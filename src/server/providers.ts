import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { getActiveRules } from "../shared/gameRules.js";
import type {
  MatchState,
  ModelDecision,
  ProviderConfig,
  ProviderPreset,
  ReasoningEffort,
  RoundSubmission,
  Seat
} from "../shared/types.js";

export function buildProviderPresets(env: NodeJS.ProcessEnv = process.env): ProviderPreset[] {
  const presets: Array<Omit<ProviderPreset, "configured">> = [
    {
      id: "openai",
      label: "OpenAI GPT",
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      envKey: "OPENAI_API_KEY",
      defaultModel: "gpt-5.1",
      modelOptions: ["gpt-5.1"],
      reasoningEffortParam: "reasoning_effort",
      reasoningEffortOptions: ["none", "low", "medium", "high"],
      notes: "Official OpenAI Chat Completions-compatible endpoint."
    },
    {
      id: "openai-compatible",
      label: "OpenAI Compatible",
      kind: "openai-compatible",
      baseUrl: env.OPENAI_COMPAT_BASE_URL,
      requiresBaseUrl: true,
      envKey: "OPENAI_COMPAT_API_KEY",
      envKeys: ["OPENAI_THIRD_PARTY_API_KEY"],
      defaultModel: env.OPENAI_COMPAT_MODEL || "gpt-4o-mini",
      modelOptions: modelOptions(env.OPENAI_COMPAT_MODEL || "gpt-4o-mini", env.OPENAI_COMPAT_MODELS),
      reasoningEffortParam: env.OPENAI_COMPAT_REASONING_PARAM || "reasoning_effort",
      reasoningEffortOptions: reasoningEffortOptions(env.OPENAI_COMPAT_REASONING_EFFORTS),
      notes: "Third-party OpenAI-compatible endpoint. Configure OPENAI_COMPAT_BASE_URL."
    },
    {
      id: "openai-codex",
      label: "OpenAI Codex",
      kind: "openai-compatible",
      baseUrl: env.OPENAI_CODEX_BASE_URL || env.OPENAI_COMPAT_BASE_URL || "https://api.openai.com/v1",
      envKey: "OPENAI_CODEX_API_KEY",
      envKeys: ["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY"],
      defaultModel: env.OPENAI_CODEX_MODEL || "gpt-5-codex",
      modelOptions: modelOptions(env.OPENAI_CODEX_MODEL || "gpt-5-codex", env.OPENAI_CODEX_MODELS),
      reasoningEffortParam: env.OPENAI_CODEX_REASONING_PARAM || "reasoning_effort",
      reasoningEffortOptions: reasoningEffortOptions(env.OPENAI_CODEX_REASONING_EFFORTS, ["low", "medium", "high"]),
      notes: "OpenAI/Codex-compatible model endpoint. Override base URL with OPENAI_CODEX_BASE_URL."
    },
    {
      id: "deepseek",
      label: "DeepSeek V4 Flash",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      envKey: "DEEPSEEK_API_KEY",
      defaultModel: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      modelOptions: modelOptions(env.DEEPSEEK_MODEL || "deepseek-v4-flash", env.DEEPSEEK_MODELS || "deepseek-v4-pro"),
      reasoningEffortParam: env.DEEPSEEK_REASONING_PARAM || "reasoning_effort",
      reasoningEffortOptions: reasoningEffortOptions(env.DEEPSEEK_REASONING_EFFORTS),
      notes: "DeepSeek OpenAI-compatible API."
    },
    {
      id: "kimi",
      label: "Kimi / Moonshot",
      kind: "openai-compatible",
      baseUrl: env.KIMI_BASE_URL || "https://api.moonshot.ai/v1",
      envKey: "KIMI_API_KEY",
      defaultModel: env.KIMI_MODEL || "kimi-k2.7-code",
      modelOptions: modelOptions(env.KIMI_MODEL || "kimi-k2.7-code", env.KIMI_MODELS || "kimi-k2.7-code-highspeed,kimi-k2.6"),
      reasoningEffortParam: env.KIMI_REASONING_PARAM || "reasoning_effort",
      reasoningEffortOptions: reasoningEffortOptions(env.KIMI_REASONING_EFFORTS),
      notes: "Kimi OpenAI-compatible API."
    },
    {
      id: "glm",
      label: "Zhipu GLM",
      kind: "openai-compatible",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      envKey: "GLM_API_KEY",
      envKeys: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
      defaultModel: "glm-5.2",
      modelOptions: ["glm-5.2"],
      reasoningEffortParam: env.GLM_REASONING_PARAM || "reasoning_effort",
      reasoningEffortOptions: reasoningEffortOptions(env.GLM_REASONING_EFFORTS),
      notes: "Zhipu/GLM standard OpenAI-compatible API."
    },
    {
      id: "glmcodingplan",
      label: "GLM Coding Plan",
      kind: "openai-compatible",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      envKey: "GLM_CODING_API_KEY",
      envKeys: ["ZHIPU_CODING_API_KEY", "ZHIPU_API_KEY", "ZAI_API_KEY"],
      defaultModel: "glm-coding-plan",
      modelOptions: ["glm-coding-plan"],
      reasoningEffortParam: env.GLM_CODING_REASONING_PARAM || "reasoning_effort",
      reasoningEffortOptions: reasoningEffortOptions(env.GLM_CODING_REASONING_EFFORTS),
      notes: "Zhipu Coding Plan models through the Coding Plan OpenAI-compatible API."
    },
    {
      id: "gemini",
      label: "Gemini AI Studio",
      kind: "gemini",
      envKey: "GEMINI_API_KEY",
      defaultModel: "gemini-3.5-flash",
      modelOptions: ["gemini-3.5-flash"],
      notes: "Google AI Studio generateContent API."
    },
    {
      id: "anthropic",
      label: "Anthropic Claude",
      kind: "anthropic",
      envKey: "ANTHROPIC_API_KEY",
      defaultModel: "claude-sonnet-4-5",
      modelOptions: ["claude-sonnet-4-5"],
      notes: "Anthropic Messages API."
    }
  ];

  return presets.map((preset) => ({
    ...preset,
    configured: providerHasApiKey(preset, env) && providerHasRequiredBaseUrl(preset)
  }));
}

export function providerEnvKey(config: ProviderConfig): string {
  return config.envKey;
}

export function parseModelDecision(raw: string): ModelDecision {
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return fallbackDecision("Fallback: model did not return valid JSON.");
  }

  const maybeNumber = Number((parsed as Record<string, unknown>).number);
  const rawRationale = (parsed as Record<string, unknown>).rationale;
  if (!Number.isFinite(maybeNumber)) {
    return fallbackDecision("Fallback: model did not provide a numeric pick.");
  }

  return {
    number: Math.max(0, Math.min(100, Math.round(maybeNumber))),
    rationale: typeof rawRationale === "string" && rawRationale.trim()
      ? rawRationale.trim().slice(0, 180)
      : "No public rationale provided."
  };
}

export async function callSeatModel(
  seat: Seat,
  match: MatchState,
  provider: ProviderPreset,
  env: NodeJS.ProcessEnv = process.env
): Promise<RoundSubmission> {
  const prompt = buildDecisionPrompt(seat, match);

  try {
    const text = await withTimeout(
      callProviderText(provider, seat.model || provider.defaultModel, prompt, env, seat.reasoningEffort),
      providerTimeoutMs(env),
      `${provider.label} request timed out.`
    );
    const decision = parseModelDecision(text);
    return {
      seatId: seat.id,
      number: decision.number,
      rationale: decision.rationale
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provider error";
    const decision = fallbackDecision(`Fallback after provider error: ${message.slice(0, 80)}`);
    return {
      seatId: seat.id,
      number: decision.number,
      rationale: decision.rationale,
      error: message
    };
  }
}

export async function testProvider(
  provider: ProviderPreset,
  model: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ModelDecision> {
  const text = await withTimeout(
    callProviderText(
      provider,
      model,
      "Return only JSON: {\"number\": 42, \"rationale\": \"connectivity test\"}",
      env
    ),
    providerTimeoutMs(env),
    `${provider.label} request timed out.`
  );
  return parseModelDecision(text);
}

async function callProviderText(
  provider: ProviderPreset,
  model: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  reasoningEffort?: ReasoningEffort
): Promise<string> {
  const apiKey = providerApiKey(provider, env);
  if (!apiKey) {
    throw new Error(`${providerEnvKeys(provider).join(" or ")} is not configured.`);
  }

  if (provider.kind === "openai-compatible") {
    if (provider.requiresBaseUrl && !provider.baseUrl) {
      throw new Error(`${provider.id} base URL is not configured.`);
    }
    const client = new OpenAI({
      apiKey,
      baseURL: provider.baseUrl,
      timeout: providerTimeoutMs(env)
    });
    const completion = await client.chat.completions.create(
      buildOpenAIChatRequest(
        model,
        prompt,
        supportedReasoningEffort(provider, reasoningEffort),
        provider.reasoningEffortParam
      )
    );
    return completion.choices[0]?.message?.content ?? "";
  }

  if (provider.kind === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });
    return response.text ?? "";
  }

  const anthropic = new Anthropic({ apiKey });
  const message = await anthropic.messages.create({
    model,
    max_tokens: 240,
    system: "Return only strict JSON with keys number and rationale. The rationale is public and must be short.",
    messages: [{ role: "user", content: prompt }]
  });
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function buildOpenAIChatRequest(
  model: string,
  prompt: string,
  reasoningEffort?: ReasoningEffort,
  reasoningEffortParam = "reasoning_effort"
) {
  return {
    model,
    messages: [
      {
        role: "system" as const,
        content: "You are playing a number strategy game. Return only strict JSON with keys number and rationale. The rationale is public and must be short."
      },
      { role: "user" as const, content: prompt }
    ],
    ...(reasoningEffort ? { [reasoningEffortParam]: reasoningEffort } : {})
  };
}

function providerTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.PROVIDER_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed >= 5000) {
    return Math.round(parsed);
  }
  return 180000;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function providerEnvKeys(config: ProviderConfig): string[] {
  return [config.envKey, ...(config.envKeys ?? [])];
}

function providerHasApiKey(config: ProviderConfig, env: NodeJS.ProcessEnv): boolean {
  return providerEnvKeys(config).some((key) => Boolean(env[key]));
}

function providerHasRequiredBaseUrl(config: ProviderConfig): boolean {
  return !config.requiresBaseUrl || Boolean(config.baseUrl);
}

function providerApiKey(config: ProviderConfig, env: NodeJS.ProcessEnv): string | undefined {
  for (const key of providerEnvKeys(config)) {
    if (env[key]) {
      return env[key];
    }
  }
  return undefined;
}

function modelOptions(defaultModel: string, envModels?: string): string[] {
  const models = (envModels ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return Array.from(new Set([defaultModel, ...models]));
}

function reasoningEffortOptions(envEfforts?: string, defaultEfforts: ReasoningEffort[] = []): ReasoningEffort[] {
  const allowed = new Set<ReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh"]);
  const efforts = (envEfforts ?? "")
    .split(",")
    .map((effort) => effort.trim())
    .filter((effort): effort is ReasoningEffort => allowed.has(effort as ReasoningEffort));
  return Array.from(new Set(efforts.length ? efforts : defaultEfforts));
}

export function supportedReasoningEffort(provider: ProviderPreset, effort?: ReasoningEffort): ReasoningEffort | undefined {
  if (!effort || !provider.reasoningEffortOptions?.includes(effort)) {
    return undefined;
  }
  return effort;
}

export function buildDecisionPrompt(seat: Seat, match: MatchState): string {
  const activeRules = getActiveRules(match);
  const publicHistory = match.rounds.map((round) => ({
    round: round.roundIndex,
    target: round.target,
    winners: round.winnerSeatIds,
    picks: round.submissions.map((submission) => ({
      seatId: submission.seatId,
      number: submission.number
    }))
  }));

  return JSON.stringify({
    task: "Choose your next integer from 0 to 100 for King of Diamonds Beauty Contest.",
    rules: {
      base: [
        "Choose one integer from 0 to 100.",
        "All active contestants submit simultaneously.",
        "The judge computes average(all submitted numbers) * 0.8 as the target.",
        "The active contestant closest to the target wins the round.",
        "The winner loses 0 score; all active non-winners lose 1 score.",
        "A contestant whose score reaches -10 is eliminated.",
        "The last surviving contestant wins the match."
      ],
      active: activeRules,
      activeDetails: activeRuleDetails(activeRules),
      newlyActivated: newlyActivatedRules(match)
    },
    secrecy: [
      "You can see public numbers, targets, winners, scores, and eliminations.",
      "You cannot see other contestants' private reasoning.",
      "Your rationale is shown to the human player for transparency, but do not include hidden chain-of-thought."
    ],
    output: { number: "integer 0..100", rationale: "one short public reason for the human player; no hidden chain of thought" },
    seat: {
      id: seat.id,
      name: seat.name,
      score: seat.score,
      strategy: seat.strategy
    },
    publicSeats: match.seats.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      score: item.score,
      lastNumber: item.lastNumber
    })),
    publicHistory
  });
}

function activeRuleDetails(activeRules: ReturnType<typeof getActiveRules>): string[] {
  const details = [];
  if (activeRules.duplicateInvalidation) {
    details.push("Duplicate Rule is active: if two or more contestants choose the same number, that number is invalid for winning, though it still counts toward the average.");
  }
  if (activeRules.exactTargetPenalty) {
    details.push("Exact Target Rule is active: if any winner exactly matches the target, all non-winners lose 2 instead of 1.");
  }
  if (activeRules.zeroHundredException) {
    details.push("Final Duel 0/100 Rule is active: in a two-player final, if one contestant chooses 0 and the other chooses 100, 100 wins.");
  }
  return details.length ? details : ["No additional rule is active yet."];
}

function newlyActivatedRules(match: MatchState): string[] {
  const eliminated = match.seats.filter((seat) => seat.status === "eliminated").length;
  const previousEliminated = match.rounds.length
    ? eliminatedBeforeLatestRound(match)
    : 0;
  const messages = [];
  if (previousEliminated < 1 && eliminated >= 1) {
    messages.push("Duplicate Rule has just activated: duplicated picks are invalid for winning from this round onward.");
  }
  if (previousEliminated < 2 && eliminated >= 2) {
    messages.push("Exact Target Rule has just activated: an exact target hit makes non-winners lose 2 from this round onward.");
  }
  if (previousEliminated < 3 && eliminated >= 3) {
    messages.push("Final Duel 0/100 Rule has just activated: in a two-player final, 100 beats 0.");
  }
  return messages;
}

function eliminatedBeforeLatestRound(match: MatchState): number {
  if (!match.rounds.length) {
    return 0;
  }
  const latest = match.rounds[match.rounds.length - 1];
  const eliminatedThisRound = match.seats.filter((seat) => (
    seat.status === "eliminated"
    && latest.submissions.some((submission) => submission.seatId === seat.id)
    && seat.score === -10
  )).length;
  const currentEliminated = match.seats.filter((seat) => seat.status === "eliminated").length;
  return Math.max(0, currentEliminated - eliminatedThisRound);
}

function tryParseJson(raw: string): unknown | null {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const candidates = [
    cleaned,
    cleaned.match(/\{[\s\S]*\}/)?.[0] ?? ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep trying broader extraction forms.
    }
  }

  return null;
}

function fallbackDecision(rationale: string): ModelDecision {
  return {
    number: 20,
    rationale
  };
}
