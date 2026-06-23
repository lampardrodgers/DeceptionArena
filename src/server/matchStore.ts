import { resolveRound } from "../shared/gameRules.js";
import type {
  MatchState,
  ProviderPreset,
  ReasoningEffort,
  RoundSubmission,
  Seat
} from "../shared/types.js";
import {
  buildProviderPresets,
  callSeatModel
} from "./providers.js";

interface StoredMatch {
  match: MatchState;
  pending: RoundSubmission[];
}

export type RoundStreamEvent =
  | { type: "round-start"; roundIndex: number; seatIds: string[]; startedAt: number }
  | { type: "seat-start"; seatId: string; seatName: string; providerId?: string; model?: string; at: number }
  | { type: "seat-done"; seatId: string; submission: RoundSubmission; elapsedMs: number; at: number }
  | { type: "round-complete"; match: MatchState; elapsedMs: number; at: number };

export interface CreateMatchSeat {
  name: string;
  kind: Seat["kind"];
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  strategy?: string;
}

export class MatchStore {
  private readonly matches = new Map<string, StoredMatch>();

  createMatch(seats: CreateMatchSeat[]): MatchState {
    const now = new Date().toISOString();
    const match: MatchState = {
      id: `match_${Math.random().toString(36).slice(2, 10)}`,
      status: "running",
      seats: seats.map((seat, index) => ({
        id: `seat_${index + 1}`,
        name: seat.name || `Contestant ${index + 1}`,
        kind: seat.kind,
        status: "active",
        score: 0,
        providerId: seat.providerId,
        model: seat.model,
        reasoningEffort: seat.reasoningEffort,
        strategy: seat.strategy
      })),
      rounds: [],
      createdAt: now,
      updatedAt: now
    };

    this.matches.set(match.id, { match, pending: [] });
    return match;
  }

  getMatch(id: string): MatchState | undefined {
    return this.matches.get(id)?.match;
  }

  getReplay(id: string): StoredMatch | undefined {
    return this.matches.get(id);
  }

  submitHuman(id: string, submission: RoundSubmission): MatchState {
    const stored = this.mustGet(id);
    if (stored.match.status === "complete") {
      throw new Error("Match is already complete.");
    }

    const seat = stored.match.seats.find((item) => item.id === submission.seatId);
    if (!seat || seat.status !== "active") {
      throw new Error("Seat is not active.");
    }
    if (seat.kind !== "human") {
      throw new Error("Only human seats can be manually submitted.");
    }

    stored.pending = [
      ...stored.pending.filter((item) => item.seatId !== submission.seatId),
      {
        ...submission,
        number: Math.max(0, Math.min(100, Math.round(submission.number))),
        rationale: submission.rationale || "Human submission."
      }
    ];
    stored.match = touch(stored.match);
    return stored.match;
  }

  async runRound(id: string, env: NodeJS.ProcessEnv = process.env): Promise<MatchState> {
    const stored = this.mustGet(id);
    if (stored.match.status === "complete") {
      return stored.match;
    }

    const providers = buildProviderPresets(env);
    const activeSeats = stored.match.seats.filter((seat) => seat.status === "active");
    const manualBySeat = new Map(stored.pending.map((submission) => [submission.seatId, submission]));
    const missingHuman = activeSeats.find((seat) => seat.kind === "human" && !manualBySeat.has(seat.id));
    if (missingHuman) {
      throw new Error(`${missingHuman.name} has not submitted a number.`);
    }

    const submissions = await Promise.all(activeSeats.map((seat) => {
      const manual = manualBySeat.get(seat.id);
      if (manual) {
        return Promise.resolve(manual);
      }
      return this.callAutomatedSeat(seat, stored.match, providers, env);
    }));

    stored.match = resolveRound(stored.match, submissions);
    stored.pending = [];
    return stored.match;
  }

  async *runRoundStream(id: string, env: NodeJS.ProcessEnv = process.env): AsyncGenerator<RoundStreamEvent> {
    const stored = this.mustGet(id);
    if (stored.match.status === "complete") {
      yield { type: "round-complete", match: stored.match, elapsedMs: 0, at: Date.now() };
      return;
    }

    const providers = buildProviderPresets(env);
    const activeSeats = stored.match.seats.filter((seat) => seat.status === "active");
    const manualBySeat = new Map(stored.pending.map((submission) => [submission.seatId, submission]));
    const missingHuman = activeSeats.find((seat) => seat.kind === "human" && !manualBySeat.has(seat.id));
    if (missingHuman) {
      throw new Error(`${missingHuman.name} has not submitted a number.`);
    }

    const startedAt = Date.now();
    yield {
      type: "round-start",
      roundIndex: stored.match.rounds.length + 1,
      seatIds: activeSeats.map((seat) => seat.id),
      startedAt
    };

    for (const seat of activeSeats) {
      yield {
        type: "seat-start",
        seatId: seat.id,
        seatName: seat.name,
        providerId: seat.providerId,
        model: seat.model,
        at: Date.now()
      };
    }

    const pending = activeSeats.map((seat) => {
      const manual = manualBySeat.get(seat.id);
      const promise = (manual
        ? Promise.resolve(manual)
        : this.callAutomatedSeat(seat, stored.match, providers, env))
        .then((submission) => ({ seat, submission }));
      return { seat, promise };
    });

    const submissions: RoundSubmission[] = [];
    const remaining = [...pending];
    while (remaining.length) {
      const { seat, submission } = await Promise.race(remaining.map((item) => item.promise));
      const index = remaining.findIndex((item) => item.seat.id === seat.id);
      if (index >= 0) {
        remaining.splice(index, 1);
      }
      submissions.push(submission);
      yield {
        type: "seat-done",
        seatId: seat.id,
        submission,
        elapsedMs: Date.now() - startedAt,
        at: Date.now()
      };
    }

    stored.match = resolveRound(stored.match, submissions);
    stored.pending = [];
    yield {
      type: "round-complete",
      match: stored.match,
      elapsedMs: Date.now() - startedAt,
      at: Date.now()
    };
  }

  async autoRun(id: string, maxRounds: number, env: NodeJS.ProcessEnv = process.env): Promise<MatchState> {
    let match = this.mustGet(id).match;
    const rounds = Math.max(1, Math.min(50, Math.round(maxRounds)));
    for (let index = 0; index < rounds; index += 1) {
      if (match.status === "complete") {
        return match;
      }
      match = await this.runRound(id, env);
    }
    return match;
  }

  private async callAutomatedSeat(
    seat: Seat,
    match: MatchState,
    providers: ProviderPreset[],
    env: NodeJS.ProcessEnv
  ): Promise<RoundSubmission> {
    if (seat.kind === "bot" || !seat.providerId) {
      return localBotDecision(seat, match);
    }

    const provider = providers.find((item) => item.id === seat.providerId);
    if (!provider) {
      return localBotDecision(seat, match, `Provider ${seat.providerId} is unavailable.`);
    }

    return callSeatModel(seat, match, provider, env);
  }

  private mustGet(id: string): StoredMatch {
    const stored = this.matches.get(id);
    if (!stored) {
      throw new Error("Match not found.");
    }
    return stored;
  }
}

function localBotDecision(seat: Seat, match: MatchState, error?: string): RoundSubmission {
  const activeScores = match.seats
    .filter((item) => item.status === "active")
    .map((item) => item.lastNumber)
    .filter((value): value is number => typeof value === "number");
  const recentAverage = activeScores.length
    ? activeScores.reduce((sum, value) => sum + value, 0) / activeScores.length
    : 50;
  const pressure = Math.max(0, Math.min(20, Math.abs(seat.score) * 2));
  const number = Math.max(0, Math.min(100, Math.round(recentAverage * 0.8 - pressure / 4)));

  return {
    seatId: seat.id,
    number,
    rationale: error ? `Local fallback: ${error}` : "Local baseline follows recent average pressure.",
    error
  };
}

function touch(match: MatchState): MatchState {
  return {
    ...match,
    updatedAt: new Date().toISOString()
  };
}
