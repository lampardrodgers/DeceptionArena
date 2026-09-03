export type ProviderKind = "openai-compatible" | "anthropic" | "gemini" | "heuristic";

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  editableUrl: boolean;
  notes: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "heuristic",
    label: "内置机器人（无需 API）",
    kind: "heuristic",
    baseUrl: "",
    defaultModel: "",
    editableUrl: false,
    notes: "离线概率模型驱动的和也，不需要密钥。"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    editableUrl: true,
    notes: "DeepSeek 官方 OpenAI 兼容接口。"
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    editableUrl: true,
    notes: "OpenAI Chat Completions 接口。"
  },
  {
    id: "openai-compatible",
    label: "OpenAI 兼容格式（自定义 URL）",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "",
    editableUrl: true,
    notes: "任意 /chat/completions 接口：Ollama、vLLM、Kimi、GLM、Qwen、OpenRouter……接口需允许浏览器跨域（CORS）。"
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-5",
    editableUrl: true,
    notes: "Anthropic Messages API（已附带浏览器直连请求头）。"
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.5-flash",
    editableUrl: true,
    notes: "Google AI Studio generateContent 接口。"
  }
];

/** 推理强度。空串 = 不发送该参数，由模型自行决定。 */
export type ReasoningEffort = "" | "none" | "low" | "medium" | "high";

export const REASONING_EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "", label: "默认（不发送，由模型决定）" },
  { value: "none", label: "关闭思考" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" }
];

export interface ProviderConfig {
  presetId: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  /** 推理强度；OpenAI 兼容接口发 reasoning_effort，Claude 映射为 thinking 预算，Gemini 映射为 thinkingBudget。 */
  reasoningEffort?: ReasoningEffort;
}

/**
 * 默认不发送输出上限，由模型自己决定；只有 Anthropic 接口把 max_tokens 作为必填项，
 * 对它使用这个宽裕的值（推理型模型的思维链也计入其中）。
 */
export const ANTHROPIC_MAX_TOKENS = 32000;

export interface ChatRequest {
  /** 系统提示词。它是每次请求都相同的稳定前缀，供应商的前缀缓存靠它命中。 */
  system: string;
  user: string;
  /** 可选的输出上限；不填则不向接口发送（Anthropic 除外，见 ANTHROPIC_MAX_TOKENS）。 */
  maxTokens?: number;
}

/** token 用量；cached 是命中前缀缓存的输入 token 数。 */
export interface ChatUsage {
  input?: number;
  cached?: number;
  output?: number;
}

/** 流式回复的增量：正文或推理（思维链）片段，末尾可能附带用量与结束原因。 */
export interface ChatDelta {
  text?: string;
  reasoning?: string;
  usage?: ChatUsage;
  finishReason?: string;
}

export interface ChatResult {
  /** 模型正文（应为 JSON）。 */
  text: string;
  /** 模型的推理内容（DeepSeek reasoning_content、Claude thinking、Gemini thought 等），没有则为空串。 */
  reasoning: string;
  usage?: ChatUsage;
  /** 供应商给出的结束原因；"length" 表示输出被 max_tokens 截断。 */
  finishReason?: string;
}

/**
 * 调用供应商。所有供应商都以流式（SSE）请求，每收到一段增量就回调 onDelta；
 * 接口不支持流式（返回普通 JSON）时自动降级为一次性解析。
 */
export async function callProvider(
  config: ProviderConfig,
  req: ChatRequest,
  onDelta?: (delta: ChatDelta) => void
): Promise<ChatResult> {
  if (config.kind === "heuristic") throw new Error("内置机器人没有 API。");
  if (!config.apiKey && config.kind !== "openai-compatible") {
    throw new Error("API 密钥为空。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const acc: ChatResult = { text: "", reasoning: "" };
  const push = (delta: ChatDelta) => {
    if (delta.text) acc.text += delta.text;
    if (delta.reasoning) acc.reasoning += delta.reasoning;
    if (delta.usage) acc.usage = { ...acc.usage, ...delta.usage };
    if (delta.finishReason) acc.finishReason = normalizeFinish(delta.finishReason);
    if (delta.text || delta.reasoning || delta.usage || delta.finishReason) onDelta?.(delta);
  };
  try {
    switch (config.kind) {
      case "openai-compatible":
        await callOpenAICompatible(config, req, controller.signal, push);
        break;
      case "anthropic":
        await callAnthropic(config, req, controller.signal, push);
        break;
      case "gemini":
        await callGemini(config, req, controller.signal, push);
        break;
      default:
        throw new Error(`不支持的供应商类型 ${config.kind}`);
    }
    return acc;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`请求超时（${config.timeoutMs} 毫秒）。`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取供应商的可用模型列表。同时充当连通性检测：
 * 能列出模型，就说明 URL、密钥、CORS 都是通的。
 */
export async function listModels(config: ProviderConfig): Promise<string[]> {
  if (config.kind === "heuristic") throw new Error("内置机器人没有 API。");
  if (!config.apiKey && config.kind !== "openai-compatible") {
    throw new Error("API 密钥为空。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let models: string[];
    switch (config.kind) {
      case "openai-compatible":
        models = await listOpenAICompatibleModels(config, controller.signal);
        break;
      case "anthropic":
        models = await listAnthropicModels(config, controller.signal);
        break;
      case "gemini":
        models = await listGeminiModels(config, controller.signal);
        break;
      default:
        throw new Error(`不支持的供应商类型 ${config.kind}`);
    }
    return [...new Set(models.filter(Boolean))].sort();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`请求超时（${config.timeoutMs} 毫秒）。`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function listOpenAICompatibleModels(config: ProviderConfig, signal: AbortSignal): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const res = await fetch(`${openAiRoot(config.baseUrl)}/models`, { method: "GET", headers, signal });
  const data = await readJson(res);
  const list: any[] = data.data ?? data.models ?? [];
  return list.map((m) => String(m?.id ?? m?.name ?? m ?? ""));
}

async function listAnthropicModels(config: ProviderConfig, signal: AbortSignal): Promise<string[]> {
  const base = trimSlash(config.baseUrl).replace(/\/v1\/messages$/, "");
  const res = await fetch(`${base}/v1/models?limit=1000`, {
    method: "GET",
    signal,
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    }
  });
  const data = await readJson(res);
  const list: any[] = data.data ?? [];
  return list.map((m) => String(m?.id ?? ""));
}

async function listGeminiModels(config: ProviderConfig, signal: AbortSignal): Promise<string[]> {
  const base = trimSlash(config.baseUrl);
  const res = await fetch(`${base}/v1beta/models?pageSize=1000`, {
    method: "GET",
    signal,
    headers: { "x-goog-api-key": config.apiKey }
  });
  const data = await readJson(res);
  const list: any[] = data.models ?? [];
  return list
    .filter((m) => !m?.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => String(m?.name ?? "").replace(/^models\//, ""));
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** OpenAI 兼容接口的根路径：用户可能直接填了 .../chat/completions。 */
function openAiRoot(baseUrl: string): string {
  return trimSlash(baseUrl).replace(/\/chat\/completions$/, "");
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
}

/** 把各家的结束原因统一成 "stop" / "length" / 其他原文。 */
function normalizeFinish(reason: string): string {
  const r = reason.toLowerCase();
  if (r === "length" || r === "max_tokens") return "length";
  if (r === "stop" || r === "end_turn" || r === "stop_sequence") return "stop";
  return reason;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 判断响应是否为 SSE 流。 */
function isEventStream(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/** 逐条读取 SSE 的 data 字段（多行 data 会合并），遇到 [DONE] 停止。 */
async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  if (!res.body) throw new Error("响应没有正文。");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data.trim() === "[DONE]") return;
    onData(data);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const sep = buf.slice(idx).match(/^\r?\n\r?\n/)![0].length;
      handle(buf.slice(0, idx));
      buf = buf.slice(idx + sep);
    }
  }
  if (buf.trim()) handle(buf);
}

/** 非 2xx 时抛出带正文的错误。 */
async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
}

function parseJsonLoose(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
}

async function callOpenAICompatible(
  config: ProviderConfig,
  req: ChatRequest,
  signal: AbortSignal,
  push: (d: ChatDelta) => void
): Promise<void> {
  const url = `${openAiRoot(config.baseUrl)}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream, application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: config.temperature,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user }
    ]
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
  const res = await fetch(url, { method: "POST", headers, signal, body: JSON.stringify(body) });
  await ensureOk(res);
  const asText = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  // OpenAI 用 prompt_tokens_details.cached_tokens，DeepSeek 用 prompt_cache_hit_tokens。
  const usageOf = (u: any): ChatUsage | undefined =>
    u
      ? {
          input: num(u.prompt_tokens),
          cached: num(u.prompt_cache_hit_tokens) ?? num(u.prompt_tokens_details?.cached_tokens),
          output: num(u.completion_tokens)
        }
      : undefined;
  if (isEventStream(res)) {
    await readSse(res, (data) => {
      const chunk = parseJsonLoose(data);
      if (chunk.error) throw new Error(`接口错误：${asText(chunk.error.message ?? chunk.error).slice(0, 300)}`);
      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? {};
      push({
        text: asText(delta.content),
        reasoning: asText(delta.reasoning_content ?? delta.reasoning),
        usage: usageOf(chunk.usage),
        finishReason: choice?.finish_reason ?? undefined
      });
    });
    return;
  }
  const data = parseJsonLoose(await res.text());
  if (data.error) throw new Error(`接口错误：${asText(data.error.message ?? data.error).slice(0, 300)}`);
  const choice = data.choices?.[0];
  const msg = choice?.message;
  if (!msg) throw new Error(`响应格式异常：${JSON.stringify(data).slice(0, 200)}`);
  push({
    reasoning: asText(msg.reasoning_content ?? msg.reasoning),
    text: asText(msg.content),
    usage: usageOf(data.usage),
    finishReason: choice?.finish_reason ?? undefined
  });
}

async function callAnthropic(
  config: ProviderConfig,
  req: ChatRequest,
  signal: AbortSignal,
  push: (d: ChatDelta) => void
): Promise<void> {
  const base = trimSlash(config.baseUrl);
  const url = base.endsWith("/v1/messages") ? base : `${base}/v1/messages`;
  // 推理强度映射为 extended thinking 的预算；开启 thinking 时不能再指定 temperature。
  const budget = { low: 2048, medium: 8192, high: 16384 }[config.reasoningEffort as "low" | "medium" | "high"];
  let maxTokens = req.maxTokens ?? ANTHROPIC_MAX_TOKENS;
  if (budget) maxTokens = Math.max(maxTokens, budget + 2000);
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    stream: true,
    // 系统提示词是稳定前缀，标记 cache_control 让后续回合命中提示词缓存。
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: req.user }]
  };
  if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
  else body.temperature = config.temperature;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  await ensureOk(res);
  const usageOf = (u: any): ChatUsage | undefined =>
    u
      ? {
          input: num(u.input_tokens) == null ? undefined : (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0),
          cached: num(u.cache_read_input_tokens),
          output: num(u.output_tokens)
        }
      : undefined;
  if (isEventStream(res)) {
    await readSse(res, (data) => {
      const ev = parseJsonLoose(data);
      if (ev.type === "error") throw new Error(`接口错误：${String(ev.error?.message ?? "").slice(0, 300)}`);
      if (ev.type === "message_start") {
        push({ usage: usageOf(ev.message?.usage) });
      } else if (ev.type === "message_delta") {
        const u = ev.usage;
        push({ usage: u ? { output: num(u.output_tokens) } : undefined, finishReason: ev.delta?.stop_reason ?? undefined });
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta ?? {};
        if (d.type === "text_delta") push({ text: d.text });
        else if (d.type === "thinking_delta") push({ reasoning: d.thinking });
      }
    });
    return;
  }
  const data = parseJsonLoose(await res.text());
  const blocks: any[] = data.content ?? [];
  push({
    reasoning: blocks.filter((b) => b.type === "thinking").map((b) => b.thinking).join("\n"),
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
    usage: usageOf(data.usage),
    finishReason: data.stop_reason ?? undefined
  });
}

async function callGemini(
  config: ProviderConfig,
  req: ChatRequest,
  signal: AbortSignal,
  push: (d: ChatDelta) => void
): Promise<void> {
  const base = trimSlash(config.baseUrl);
  const url = `${base}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;
  const generationConfig: Record<string, unknown> = {
    temperature: config.temperature,
    responseMimeType: "application/json"
  };
  if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
  // 推理强度映射为 thinkingBudget：0 关闭，-1 动态（最高）。
  const budget = { none: 0, low: 1024, medium: 8192, high: -1 }[config.reasoningEffort as "none" | "low" | "medium" | "high"];
  if (budget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: budget !== 0 };
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig
    })
  });
  await ensureOk(res);
  const pushParts = (data: any) => {
    if (data.error) throw new Error(`接口错误：${String(data.error.message ?? "").slice(0, 300)}`);
    if (data.promptFeedback?.blockReason) throw new Error(`请求被拦截：${data.promptFeedback.blockReason}`);
    const cand = data.candidates?.[0];
    const parts: any[] = cand?.content?.parts ?? [];
    for (const p of parts) {
      if (typeof p.text !== "string") continue;
      if (p.thought) push({ reasoning: p.text });
      else push({ text: p.text });
    }
    const u = data.usageMetadata;
    push({
      usage: u ? { input: num(u.promptTokenCount), cached: num(u.cachedContentTokenCount), output: num(u.candidatesTokenCount) } : undefined,
      finishReason: cand?.finishReason ?? undefined
    });
  };
  if (isEventStream(res)) {
    await readSse(res, (data) => pushParts(parseJsonLoose(data)));
    return;
  }
  const data = parseJsonLoose(await res.text());
  // 非流式时 Gemini 可能返回数组（每个元素一段）。
  for (const item of Array.isArray(data) ? data : [data]) pushParts(item);
}

export function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const candidates = [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0] ?? ""].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  return null;
}
