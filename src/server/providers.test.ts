import { describe, expect, it } from "vitest";
import {
  buildOpenAIChatRequest,
  buildDecisionPrompt,
  buildProviderPresets,
  parseModelDecision,
  providerEnvKey,
  supportedReasoningEffort
} from "./providers";
import { createInitialMatch, resolveRound } from "../shared/gameRules";

describe("AI provider helpers", () => {
  it("parses a strict numeric JSON model decision", () => {
    expect(parseModelDecision('{"number":42,"rationale":"recursive average pressure"}')).toEqual({
      number: 42,
      rationale: "recursive average pressure"
    });
  });

  it("extracts JSON from fenced or surrounding text and clamps rationale length", () => {
    const parsed = parseModelDecision("```json\n{\"number\": 101.2, \"rationale\": \"x\"}\n```");

    expect(parsed.number).toBe(100);
    expect(parsed.rationale).toBe("x");
  });

  it("falls back to a transparent invalid-decision number", () => {
    const parsed = parseModelDecision("I refuse to choose.");

    expect(parsed.number).toBeGreaterThanOrEqual(0);
    expect(parsed.number).toBeLessThanOrEqual(100);
    expect(parsed.rationale).toMatch(/fallback/i);
  });

  it("adds reasoning effort to OpenAI-compatible requests only when selected", () => {
    expect(buildOpenAIChatRequest("gpt-5.1", "pick a number")).not.toHaveProperty("reasoning_effort");
    expect(buildOpenAIChatRequest("gpt-5.1", "pick a number", "high")).toMatchObject({
      model: "gpt-5.1",
      reasoning_effort: "high"
    });
    expect(buildOpenAIChatRequest("third-party-model", "pick a number", "low", "thinking_effort")).toMatchObject({
      model: "third-party-model",
      thinking_effort: "low"
    });
  });

  it("maps provider presets to environment keys without exposing secrets", () => {
    expect(providerEnvKey({ kind: "openai-compatible", baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY" })).toBe("DEEPSEEK_API_KEY");
    expect(providerEnvKey({ kind: "gemini", envKey: "GEMINI_API_KEY" })).toBe("GEMINI_API_KEY");
    expect(providerEnvKey({ kind: "anthropic", envKey: "ANTHROPIC_API_KEY" })).toBe("ANTHROPIC_API_KEY");

    const presets = buildProviderPresets({ DEEPSEEK_API_KEY: "secret" });
    expect(JSON.stringify(presets)).not.toContain("secret");
    expect(presets.find((preset) => preset.id === "deepseek")?.configured).toBe(true);
  });

  it("exposes reasoning effort options only for providers that declare support", () => {
    const presets = buildProviderPresets({
      OPENAI_COMPAT_API_KEY: "compat-secret",
      OPENAI_COMPAT_BASE_URL: "https://third-party.example/v1",
      OPENAI_COMPAT_REASONING_PARAM: "thinking_effort",
      OPENAI_COMPAT_REASONING_EFFORTS: "low,high,not-real",
      DEEPSEEK_REASONING_EFFORTS: "low,medium"
    });

    expect(presets.find((preset) => preset.id === "openai")?.reasoningEffortOptions).toEqual(["none", "low", "medium", "high"]);
    expect(presets.find((preset) => preset.id === "openai-compatible")?.reasoningEffortOptions).toEqual(["low", "high"]);
    expect(presets.find((preset) => preset.id === "openai-compatible")?.reasoningEffortParam).toBe("thinking_effort");
    expect(presets.find((preset) => preset.id === "openai-codex")?.reasoningEffortOptions).toEqual(["low", "medium", "high"]);
    expect(presets.find((preset) => preset.id === "deepseek")?.reasoningEffortOptions).toEqual(["low", "medium"]);
    expect(presets.find((preset) => preset.id === "kimi")?.reasoningEffortOptions).toEqual([]);
  });

  it("drops unsupported reasoning effort before sending provider requests", () => {
    const presets = buildProviderPresets();
    const openai = presets.find((preset) => preset.id === "openai");
    const deepseek = presets.find((preset) => preset.id === "deepseek");

    expect(openai ? supportedReasoningEffort(openai, "high") : undefined).toBe("high");
    expect(openai ? supportedReasoningEffort(openai, "xhigh") : undefined).toBeUndefined();
    expect(deepseek ? supportedReasoningEffort(deepseek, "high") : undefined).toBeUndefined();
  });

  it("supports a third-party OpenAI-compatible base URL provider", () => {
    const presets = buildProviderPresets({
      OPENAI_COMPAT_API_KEY: "compat-secret",
      OPENAI_COMPAT_BASE_URL: "https://third-party.example/v1",
      OPENAI_COMPAT_MODEL: "third-party-model",
      OPENAI_COMPAT_MODELS: "third-party-model,another-model"
    });
    const provider = presets.find((preset) => preset.id === "openai-compatible");

    expect(provider?.baseUrl).toBe("https://third-party.example/v1");
    expect(provider?.envKey).toBe("OPENAI_COMPAT_API_KEY");
    expect(provider?.defaultModel).toBe("third-party-model");
    expect(provider?.modelOptions).toEqual(["third-party-model", "another-model"]);
    expect(provider?.configured).toBe(true);
    expect(JSON.stringify(presets)).not.toContain("compat-secret");
  });

  it("allows Kimi endpoint and model overrides", () => {
    const presets = buildProviderPresets({
      KIMI_API_KEY: "kimi-secret",
      KIMI_BASE_URL: "https://api.moonshot.cn/v1",
      KIMI_MODEL: "kimi-k2.7-code",
      KIMI_MODELS: "kimi-k2.7-code,kimi-k2.7-code-highspeed"
    });
    const provider = presets.find((preset) => preset.id === "kimi");

    expect(provider?.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(provider?.defaultModel).toBe("kimi-k2.7-code");
    expect(provider?.modelOptions).toEqual(["kimi-k2.7-code", "kimi-k2.7-code-highspeed"]);
    expect(provider?.configured).toBe(true);
    expect(JSON.stringify(presets)).not.toContain("kimi-secret");
  });

  it("requires a base URL for the third-party OpenAI-compatible provider", () => {
    const presets = buildProviderPresets({ OPENAI_COMPAT_API_KEY: "compat-secret" });

    expect(presets.find((preset) => preset.id === "openai-compatible")?.configured).toBe(false);
    expect(JSON.stringify(presets)).not.toContain("compat-secret");
  });

  it("supports a Codex-specific OpenAI-compatible provider", () => {
    const presets = buildProviderPresets({
      OPENAI_CODEX_API_KEY: "codex-secret",
      OPENAI_CODEX_BASE_URL: "https://codex.example/v1",
      OPENAI_CODEX_MODEL: "codex-third-party-model",
      OPENAI_CODEX_MODELS: "codex-third-party-model,codex-alt"
    });
    const provider = presets.find((preset) => preset.id === "openai-codex");

    expect(provider?.baseUrl).toBe("https://codex.example/v1");
    expect(provider?.envKey).toBe("OPENAI_CODEX_API_KEY");
    expect(provider?.defaultModel).toBe("codex-third-party-model");
    expect(provider?.modelOptions).toEqual(["codex-third-party-model", "codex-alt"]);
    expect(provider?.configured).toBe(true);
    expect(JSON.stringify(presets)).not.toContain("codex-secret");
  });

  it("keeps standard GLM and GLM Coding Plan endpoints separate", () => {
    const presets = buildProviderPresets({
      GLM_API_KEY: "standard-secret",
      GLM_CODING_API_KEY: "coding-secret"
    });
    const glm = presets.find((preset) => preset.id === "glm");
    const glmCoding = presets.find((preset) => preset.id === "glmcodingplan");

    expect(glm?.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(glm?.envKey).toBe("GLM_API_KEY");
    expect(glm?.configured).toBe(true);
    expect(glmCoding?.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(glmCoding?.envKey).toBe("GLM_CODING_API_KEY");
    expect(glmCoding?.configured).toBe(true);
    expect(JSON.stringify(presets)).not.toContain("standard-secret");
    expect(JSON.stringify(presets)).not.toContain("coding-secret");
  });

  it("keeps legacy ZAI_API_KEY compatible for both GLM providers", () => {
    const presets = buildProviderPresets({ ZAI_API_KEY: "legacy-secret" });

    expect(presets.find((preset) => preset.id === "glm")?.configured).toBe(true);
    expect(presets.find((preset) => preset.id === "glmcodingplan")?.configured).toBe(true);
    expect(JSON.stringify(presets)).not.toContain("legacy-secret");
  });

  it("builds prompts with rules but without other players' rationale leakage", () => {
    let match = createInitialMatch(["A", "B", "C", "D", "E"]);
    match.seats = match.seats.map((seat) => ({
      ...seat,
      kind: "ai",
      providerId: "deepseek"
    }));

    match = resolveRound(match, [
      { seatId: "seat_1", number: 10, rationale: "secret lowball plan" },
      { seatId: "seat_2", number: 20, rationale: "secret mirror plan" },
      { seatId: "seat_3", number: 30, rationale: "secret target plan" },
      { seatId: "seat_4", number: 40, rationale: "secret high plan" },
      { seatId: "seat_5", number: 50, rationale: "secret bait plan" }
    ]);
    match.seats[4].status = "eliminated";
    match.seats[4].score = -10;

    const prompt = JSON.parse(buildDecisionPrompt(match.seats[0], match));

    expect(JSON.stringify(prompt)).not.toContain("secret lowball plan");
    expect(JSON.stringify(prompt)).not.toContain("lastRationale");
    expect(prompt.rules.base.join(" ")).toContain("Choose one integer from 0 to 100");
    expect(prompt.rules.active.duplicateInvalidation).toBe(true);
    expect(prompt.rules.newlyActivated.join(" ")).toContain("Duplicate Rule");
    expect(prompt.publicHistory[0].picks[0]).toEqual({
      seatId: "seat_1",
      number: 10
    });
  });
});
