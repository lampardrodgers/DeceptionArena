export type SeatStatus = "active" | "eliminated" | "winner";
export type SeatKind = "human" | "ai" | "bot";
export type MatchStatus = "setup" | "running" | "complete";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ProviderKind = "openai-compatible" | "gemini" | "anthropic";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl?: string;
  requiresBaseUrl?: boolean;
  envKey: string;
  envKeys?: string[];
}

export interface ProviderPreset extends ProviderConfig {
  id: string;
  label: string;
  defaultModel: string;
  modelOptions?: string[];
  reasoningEffortParam?: string;
  reasoningEffortOptions?: ReasoningEffort[];
  configured: boolean;
  notes: string;
}

export interface Seat {
  id: string;
  name: string;
  kind: SeatKind;
  status: SeatStatus;
  score: number;
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  strategy?: string;
  lastNumber?: number;
  lastRationale?: string;
  error?: string;
}

export interface RoundSubmission {
  seatId: string;
  number: number;
  rationale?: string;
  error?: string;
}

export interface ActiveRules {
  duplicateInvalidation: boolean;
  exactTargetPenalty: boolean;
  zeroHundredException: boolean;
}

export interface RoundResult {
  roundIndex: number;
  submissions: RoundSubmission[];
  average: number;
  target: number;
  winnerSeatIds: string[];
  invalidSeatIds: string[];
  exactTarget: boolean;
  appliedRules: ActiveRules;
  events: string[];
}

export interface MatchState {
  id: string;
  status: MatchStatus;
  seats: Seat[];
  rounds: RoundResult[];
  winnerSeatId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelDecision {
  number: number;
  rationale: string;
}
