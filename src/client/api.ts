import type {
  MatchState,
  ModelDecision,
  ProviderPreset,
  ReasoningEffort,
  RoundSubmission,
  Seat
} from "../shared/types";

export interface CreateMatchSeat {
  name: string;
  kind: Seat["kind"];
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  strategy?: string;
}

export async function fetchProviders(): Promise<ProviderPreset[]> {
  const data = await request<{ providers: ProviderPreset[] }>("/api/providers");
  return data.providers;
}

export async function createMatch(seats: CreateMatchSeat[]): Promise<MatchState> {
  const data = await request<{ match: MatchState }>("/api/matches", {
    method: "POST",
    body: JSON.stringify({ seats })
  });
  return data.match;
}

export async function submitHuman(matchId: string, seatId: string, number: number, signal?: AbortSignal): Promise<MatchState> {
  const data = await request<{ match: MatchState }>(`/api/matches/${matchId}/submit`, {
    method: "POST",
    body: JSON.stringify({ seatId, number }),
    signal
  });
  return data.match;
}

export async function runRound(matchId: string, signal?: AbortSignal): Promise<MatchState> {
  const data = await request<{ match: MatchState }>(`/api/matches/${matchId}/run-round`, {
    method: "POST",
    signal
  });
  return data.match;
}

export type RoundStreamEvent =
  | { type: "round-start"; roundIndex: number; seatIds: string[]; startedAt: number }
  | { type: "seat-start"; seatId: string; seatName: string; providerId?: string; model?: string; at: number }
  | { type: "seat-done"; seatId: string; submission: RoundSubmission; elapsedMs: number; at: number }
  | { type: "round-complete"; match: MatchState; elapsedMs: number; at: number }
  | { type: "error"; error: string };

export async function runRoundStream(
  matchId: string,
  onEvent: (event: RoundStreamEvent) => void,
  signal?: AbortSignal
): Promise<MatchState> {
  const response = await fetch(`/api/matches/${matchId}/run-round-stream`, {
    method: "POST",
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error("Stream request failed.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalMatch: MatchState | undefined;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line) as RoundStreamEvent;
      if (event.type === "error") {
        throw new Error(event.error);
      }
      onEvent(event);
      if (event.type === "round-complete") {
        finalMatch = event.match;
      }
    }

    if (done) {
      break;
    }
  }

  if (!finalMatch) {
    throw new Error("Stream ended before the round resolved.");
  }
  return finalMatch;
}

export async function autoRun(matchId: string, rounds: number): Promise<MatchState> {
  const data = await request<{ match: MatchState }>(`/api/matches/${matchId}/autorun`, {
    method: "POST",
    body: JSON.stringify({ rounds })
  });
  return data.match;
}

export async function testProvider(providerId: string, model: string): Promise<ModelDecision> {
  const data = await request<{ ok: boolean; decision: ModelDecision }>("/api/providers/test", {
    method: "POST",
    body: JSON.stringify({ providerId, model })
  });
  return data.decision;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Request failed.");
  }
  return data as T;
}
