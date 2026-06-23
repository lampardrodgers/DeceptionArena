import type {
  ActiveRules,
  MatchState,
  RoundResult,
  RoundSubmission,
  Seat
} from "./types.js";

const SCORE_FLOOR = -10;
const EPSILON = 1e-9;

export function createInitialMatch(names: string[]): MatchState {
  const now = new Date().toISOString();
  return {
    id: `match_${Math.random().toString(36).slice(2, 10)}`,
    status: "setup",
    seats: names.map((name, index) => ({
      id: `seat_${index + 1}`,
      name,
      kind: index === 0 ? "human" : "ai",
      status: "active",
      score: 0
    })),
    rounds: [],
    createdAt: now,
    updatedAt: now
  };
}

export function getActiveRules(match: MatchState): ActiveRules {
  const eliminatedCount = match.seats.filter((seat) => seat.status === "eliminated").length;
  return {
    duplicateInvalidation: eliminatedCount >= 1,
    exactTargetPenalty: eliminatedCount >= 2,
    zeroHundredException: eliminatedCount >= 3
  };
}

export function resolveRound(match: MatchState, submissions: RoundSubmission[]): MatchState {
  if (match.status === "complete") {
    throw new Error("Cannot resolve a completed match.");
  }

  const activeSeats = match.seats.filter((seat) => seat.status === "active");
  if (activeSeats.length < 2) {
    throw new Error("At least two active seats are required.");
  }

  const normalizedSubmissions = normalizeSubmissions(activeSeats, submissions);
  const rules = getActiveRules(match);
  const average = normalizedSubmissions.reduce((sum, submission) => sum + submission.number, 0) / normalizedSubmissions.length;
  const target = average * 0.8;
  const invalidSeatIds = rules.duplicateInvalidation
    ? duplicatedSeatIds(normalizedSubmissions)
    : [];
  const winnerSeatIds = resolveWinners(normalizedSubmissions, target, invalidSeatIds, rules);
  const exactTarget = winnerSeatIds.some((seatId) => {
    const submission = normalizedSubmissions.find((item) => item.seatId === seatId);
    return submission ? Math.abs(submission.number - target) < EPSILON : false;
  });
  const penalty = rules.exactTargetPenalty && exactTarget ? -2 : -1;
  const updatedSeats = applyRoundToSeats(match.seats, normalizedSubmissions, winnerSeatIds, penalty);
  const events = roundEvents(normalizedSubmissions, target, winnerSeatIds, invalidSeatIds, exactTarget, penalty);

  for (const seat of updatedSeats) {
    if (seat.status === "active" && seat.score <= SCORE_FLOOR) {
      seat.score = SCORE_FLOOR;
      seat.status = "eliminated";
      events.push(`${seat.name} reached -10 and was eliminated.`);
    }
  }

  const survivors = updatedSeats.filter((seat) => seat.status === "active");
  let status: MatchState["status"] = "running";
  let winnerSeatId: string | undefined;

  if (survivors.length === 1) {
    status = "complete";
    winnerSeatId = survivors[0].id;
    survivors[0].status = "winner";
    events.push(`${survivors[0].name} is the last surviving contestant.`);
  }

  const round: RoundResult = {
    roundIndex: match.rounds.length + 1,
    submissions: normalizedSubmissions,
    average,
    target,
    winnerSeatIds,
    invalidSeatIds,
    exactTarget,
    appliedRules: rules,
    events
  };

  return {
    ...match,
    status,
    seats: updatedSeats,
    rounds: [...match.rounds, round],
    winnerSeatId,
    updatedAt: new Date().toISOString()
  };
}

function normalizeSubmissions(activeSeats: Seat[], submissions: RoundSubmission[]): RoundSubmission[] {
  const bySeat = new Map(submissions.map((submission) => [submission.seatId, submission]));
  return activeSeats.map((seat) => {
    const submission = bySeat.get(seat.id);
    if (!submission) {
      throw new Error(`Missing submission for ${seat.id}.`);
    }

    return {
      ...submission,
      number: clampNumber(submission.number),
      rationale: submission.rationale?.slice(0, 180)
    };
  });
}

function clampNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function duplicatedSeatIds(submissions: RoundSubmission[]): string[] {
  const byNumber = new Map<number, RoundSubmission[]>();
  for (const submission of submissions) {
    byNumber.set(submission.number, [...(byNumber.get(submission.number) ?? []), submission]);
  }

  return [...byNumber.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => group.map((submission) => submission.seatId));
}

function resolveWinners(
  submissions: RoundSubmission[],
  target: number,
  invalidSeatIds: string[],
  rules: ActiveRules
): string[] {
  if (rules.zeroHundredException && submissions.length === 2) {
    const zero = submissions.find((submission) => submission.number === 0);
    const hundred = submissions.find((submission) => submission.number === 100);
    if (zero && hundred) {
      return [hundred.seatId];
    }
  }

  const invalid = new Set(invalidSeatIds);
  const eligible = submissions.filter((submission) => !invalid.has(submission.seatId));
  if (eligible.length === 0) {
    return [];
  }

  const closestDistance = Math.min(...eligible.map((submission) => Math.abs(submission.number - target)));
  return eligible
    .filter((submission) => Math.abs(Math.abs(submission.number - target) - closestDistance) < EPSILON)
    .map((submission) => submission.seatId);
}

function applyRoundToSeats(
  seats: Seat[],
  submissions: RoundSubmission[],
  winnerSeatIds: string[],
  penalty: number
): Seat[] {
  const activeSubmissionSeatIds = new Set(submissions.map((submission) => submission.seatId));
  const winners = new Set(winnerSeatIds);
  const submissionsBySeat = new Map(submissions.map((submission) => [submission.seatId, submission]));

  return seats.map((seat) => {
    const submission = submissionsBySeat.get(seat.id);
    const next = { ...seat };
    if (submission) {
      next.lastNumber = submission.number;
      next.lastRationale = submission.rationale;
      next.error = submission.error;
    }
    if (next.status === "active" && activeSubmissionSeatIds.has(next.id) && !winners.has(next.id)) {
      next.score += penalty;
    }
    return next;
  });
}

function roundEvents(
  submissions: RoundSubmission[],
  target: number,
  winnerSeatIds: string[],
  invalidSeatIds: string[],
  exactTarget: boolean,
  penalty: number
): string[] {
  const events = [
    `Target resolved to ${formatNumber(target)} from ${submissions.length} submissions.`
  ];

  if (invalidSeatIds.length) {
    events.push(`Duplicate picks invalidated: ${invalidSeatIds.join(", ")}.`);
  }

  if (winnerSeatIds.length) {
    events.push(`Winner seat(s): ${winnerSeatIds.join(", ")}.`);
  } else {
    events.push("No eligible winner this round.");
  }

  if (exactTarget) {
    events.push(`Exact target hit; non-winner penalty is ${penalty}.`);
  }

  return events;
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
