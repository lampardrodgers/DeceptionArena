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

export interface ProviderConfig {
  presetId: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export async function callProvider(config: ProviderConfig, req: ChatRequest): Promise<string> {
  if (config.kind === "heuristic") throw new Error("内置机器人没有 API。");
  if (!config.apiKey && config.kind !== "openai-compatible") {
    throw new Error("API 密钥为空。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    switch (config.kind) {
      case "openai-compatible":
        return await callOpenAICompatible(config, req, controller.signal);
      case "anthropic":
        return await callAnthropic(config, req, controller.signal);
      case "gemini":
        return await callGemini(config, req, controller.signal);
      default:
        throw new Error(`不支持的供应商类型 ${config.kind}`);
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`请求超时（${config.timeoutMs} 毫秒）。`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
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

async function callOpenAICompatible(config: ProviderConfig, req: ChatRequest, signal: AbortSignal): Promise<string> {
  const base = trimSlash(config.baseUrl);
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      max_tokens: req.maxTokens ?? 600,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user }
      ]
    })
  });
  const data = await readJson(res);
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error(`响应格式异常：${JSON.stringify(data).slice(0, 200)}`);
  return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
}

async function callAnthropic(config: ProviderConfig, req: ChatRequest, signal: AbortSignal): Promise<string> {
  const base = trimSlash(config.baseUrl);
  const url = base.endsWith("/v1/messages") ? base : `${base}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: req.maxTokens ?? 600,
      temperature: config.temperature,
      system: req.system,
      messages: [{ role: "user", content: req.user }]
    })
  });
  const data = await readJson(res);
  const blocks: any[] = data.content ?? [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

async function callGemini(config: ProviderConfig, req: ChatRequest, signal: AbortSignal): Promise<string> {
  const base = trimSlash(config.baseUrl);
  const url = `${base}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: config.temperature,
        maxOutputTokens: req.maxTokens ?? 800,
        responseMimeType: "application/json"
      }
    })
  });
  const data = await readJson(res);
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("\n");
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
