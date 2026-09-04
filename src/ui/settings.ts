import { PROVIDER_PRESETS, REASONING_EFFORTS, type ProviderConfig, type ReasoningEffort } from "../ai/providers.js";
import { type Side } from "../game/engine.js";

export interface MatchSettings {
  playerLives: number;
  aiLives: number;
  firstMover: Side | "random";
}

/** 保存在本地的一套供应商配置（含密钥）。 */
export interface SavedProfile extends ProviderConfig {
  id: string;
  savedAt: number;
}

export interface AppSettings {
  provider: ProviderConfig;
  match: MatchSettings;
  /** 之前配置过的所有 API，按最近保存时间倒序。 */
  profiles: SavedProfile[];
  /** 本局未结束时隐藏「AI 思考记录」的推理 / 回复 / 决策，避免从中读出和也的牌。 */
  hideTraceDuringRound: boolean;
}

const KEY = "pokesolo.settings.v2";
const MAX_PROFILES = 30;

export function defaultSettings(): AppSettings {
  const preset = PROVIDER_PRESETS[0];
  return {
    provider: {
      presetId: preset.id,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      apiKey: "",
      model: preset.defaultModel,
      temperature: 0.7,
      timeoutMs: 90000,
      reasoningEffort: ""
    },
    match: { playerLives: 12, aiLives: 12, firstMover: "random" },
    profiles: [],
    hideTraceDuringRound: true
  };
}

/** 同一供应商 + 地址 + 模型视为同一份配置。 */
export function profileId(c: ProviderConfig): string {
  return `${c.presetId}|${c.baseUrl.trim().replace(/\/+$/, "")}|${c.model.trim()}`;
}

export function upsertProfile(profiles: SavedProfile[], config: ProviderConfig): SavedProfile[] {
  if (config.kind === "heuristic") return profiles;
  const id = profileId(config);
  const entry: SavedProfile = { ...config, id, savedAt: Date.now() };
  return [entry, ...profiles.filter((p) => p.id !== id)].slice(0, MAX_PROFILES);
}

export function loadSettings(): AppSettings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const provider = { ...base.provider, ...(parsed.provider ?? {}) };
    let profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles.filter((p) => p && typeof p.id === "string" && typeof p.presetId === "string")
      : [];
    // 旧版本只保存当前供应商：把它补进已保存列表，避免升级后丢失。
    if (!profiles.length && provider.kind !== "heuristic" && (provider.apiKey || provider.model)) {
      profiles = upsertProfile([], provider);
    }
    return {
      provider,
      match: { ...base.match, ...(parsed.match ?? {}) },
      profiles,
      hideTraceDuringRound: parsed.hideTraceDuringRound ?? base.hideTraceDuringRound
    };
  } catch {
    return base;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式等情况下忽略存储失败
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const clampNum = (v: string, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 已保存配置在下拉框中的显示名。 */
export function profileLabel(p: ProviderConfig): string {
  const preset = PROVIDER_PRESETS.find((x) => x.id === p.presetId);
  const parts = [preset?.label ?? p.presetId, p.model || "（未填模型）"];
  if (preset?.editableUrl && p.baseUrl && p.baseUrl !== preset.baseUrl) parts.push(hostOf(p.baseUrl));
  return parts.join(" · ");
}

export interface SettingsPanelHooks {
  onSave(settings: AppSettings): void;
  test(config: ProviderConfig): Promise<string>;
  listModels(config: ProviderConfig): Promise<string[]>;
}

/** AI 供应商设置面板。 */
export function initSettingsPanel(initial: AppSettings, hooks: SettingsPanelHooks): { open(): void } {
  const modal = $("modal-settings");
  const saved = $<HTMLSelectElement>("cfg-saved");
  const btnDelete = $<HTMLButtonElement>("cfg-delete");
  const provider = $<HTMLSelectElement>("cfg-provider");
  const url = $<HTMLInputElement>("cfg-url");
  const key = $<HTMLInputElement>("cfg-key");
  const model = $<HTMLInputElement>("cfg-model");
  const modelList = $<HTMLSelectElement>("cfg-model-list");
  const temp = $<HTMLInputElement>("cfg-temp");
  const timeout = $<HTMLInputElement>("cfg-timeout");
  const effort = $<HTMLSelectElement>("cfg-effort");
  const notes = $("cfg-notes");
  const testResult = $("cfg-test-result");
  const btnModels = $<HTMLButtonElement>("cfg-models");
  const btnTest = $<HTMLButtonElement>("cfg-test");

  for (const preset of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.label;
    provider.appendChild(opt);
  }
  for (const e of REASONING_EFFORTS) {
    const opt = document.createElement("option");
    opt.value = e.value;
    opt.textContent = e.label;
    effort.appendChild(opt);
  }
  const readEffort = (): ReasoningEffort =>
    (REASONING_EFFORTS.find((e) => e.value === effort.value)?.value ?? "") as ReasoningEffort;

  /** 记住每个预设在本次会话中的 URL / 模型 / 密钥，切换回来时不丢失。 */
  const perPreset = new Map<string, { baseUrl: string; model: string; apiKey: string }>();
  /** 每个预设最近一次拉到的模型列表，切换回来时不用重新请求。 */
  const modelsByPreset = new Map<string, string[]>();
  let profiles: SavedProfile[] = initial.profiles;

  const setStatus = (text: string, cls: "" | "ok" | "bad") => {
    testResult.textContent = text;
    testResult.className = cls;
  };

  const rememberCurrent = () => perPreset.set(provider.value, { baseUrl: url.value, model: model.value, apiKey: key.value });

  /** 用给定的模型列表刷新下拉框；空列表表示尚未获取。 */
  const fillModelList = (models: string[]) => {
    modelList.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = models.length ? `— 共 ${models.length} 个模型，选择即填入上方 —` : "— 尚未获取 —";
    modelList.appendChild(placeholder);
    for (const id of models) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      modelList.appendChild(opt);
    }
    modelList.disabled = models.length === 0;
    // 当前填写的模型如果在列表里，就让下拉框跟着高亮它。
    modelList.value = models.includes(model.value.trim()) ? model.value.trim() : "";
  };

  /** 刷新「已保存的配置」下拉框，并高亮与当前表单一致的那份。 */
  const fillSaved = () => {
    saved.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = profiles.length ? `— 已保存 ${profiles.length} 份配置，选择即填入 —` : "— 还没有保存过任何 API —";
    saved.appendChild(placeholder);
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${profileLabel(p)}${p.apiKey ? "" : "（无密钥）"}`;
      saved.appendChild(opt);
    }
    saved.disabled = profiles.length === 0;
    syncSavedHighlight();
  };
  const syncSavedHighlight = () => {
    const id = profileId(read());
    saved.value = profiles.some((p) => p.id === id) ? id : "";
    btnDelete.disabled = !saved.value;
  };

  const applyPreset = (id: string, keepValues: boolean) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0];
    const isApi = preset.kind !== "heuristic";
    url.disabled = !isApi || !preset.editableUrl;
    key.disabled = !isApi;
    model.disabled = !isApi;
    temp.disabled = !isApi;
    timeout.disabled = !isApi;
    effort.disabled = !isApi;
    if (!keepValues) {
      // 优先用本次会话里改过的值，其次用本地保存过的同供应商配置，最后用预设默认值。
      const session = perPreset.get(preset.id);
      const stored = profiles.find((p) => p.presetId === preset.id);
      url.value = session?.baseUrl ?? stored?.baseUrl ?? preset.baseUrl;
      model.value = session?.model ?? stored?.model ?? preset.defaultModel;
      key.value = session?.apiKey ?? stored?.apiKey ?? "";
      if (!session && stored) {
        temp.value = String(stored.temperature);
        timeout.value = String(Math.round(stored.timeoutMs / 1000));
        effort.value = stored.reasoningEffort ?? "";
      }
    }
    notes.textContent = preset.notes;
    modelList.disabled = !isApi;
    fillModelList(modelsByPreset.get(preset.id) ?? []);
  };

  const fillConfig = (c: ProviderConfig) => {
    provider.value = c.presetId;
    applyPreset(c.presetId, true);
    url.value = c.baseUrl;
    key.value = c.apiKey;
    model.value = c.model;
    temp.value = String(c.temperature);
    timeout.value = String(Math.round(c.timeoutMs / 1000));
    effort.value = c.reasoningEffort ?? "";
    perPreset.set(c.presetId, { baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey });
    fillModelList(modelsByPreset.get(c.presetId) ?? []);
  };

  const fill = (settings: AppSettings) => {
    profiles = settings.profiles;
    fillConfig(settings.provider);
    fillSaved();
    setStatus("", "");
  };

  const read = (): ProviderConfig => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === provider.value) ?? PROVIDER_PRESETS[0];
    return {
      presetId: preset.id,
      kind: preset.kind,
      baseUrl: url.value.trim() || preset.baseUrl,
      apiKey: key.value.trim(),
      model: model.value.trim() || preset.defaultModel,
      temperature: clampNum(temp.value, 0, 2, 0.7),
      timeoutMs: clampNum(timeout.value, 5, 600, 90) * 1000,
      reasoningEffort: readEffort()
    };
  };

  provider.addEventListener("change", () => {
    applyPreset(provider.value, false);
    syncSavedHighlight();
  });
  for (const el of [url, model, key]) {
    el.addEventListener("input", () => {
      rememberCurrent();
      syncSavedHighlight();
    });
  }
  model.addEventListener("input", () => {
    const options = [...modelList.options].map((o) => o.value);
    modelList.value = options.includes(model.value.trim()) ? model.value.trim() : "";
  });
  modelList.addEventListener("change", () => {
    if (!modelList.value) return;
    model.value = modelList.value;
    rememberCurrent();
    syncSavedHighlight();
    setStatus(`已选择模型 ${modelList.value}。`, "ok");
  });
  saved.addEventListener("change", () => {
    const p = profiles.find((x) => x.id === saved.value);
    if (!p) return;
    fillConfig(p);
    btnDelete.disabled = false;
    setStatus(`已载入保存的配置：${profileLabel(p)}`, "ok");
  });
  btnDelete.addEventListener("click", () => {
    const id = saved.value;
    if (!id) return;
    profiles = profiles.filter((p) => p.id !== id);
    saveSettings({ ...loadSettings(), profiles });
    fillSaved();
    setStatus("已删除该配置（当前表单内容未变，点「保存」可重新加回）。", "");
  });

  $("cfg-cancel").addEventListener("click", () => modal.classList.add("hidden"));
  $("cfg-save").addEventListener("click", () => {
    const config = read();
    profiles = upsertProfile(loadSettings().profiles, config);
    const settings: AppSettings = { ...loadSettings(), provider: config, profiles };
    saveSettings(settings);
    hooks.onSave(settings);
    modal.classList.add("hidden");
  });
  btnModels.addEventListener("click", async () => {
    const config = read();
    if (config.kind === "heuristic") {
      setStatus("内置机器人无需联网，也没有模型可选。", "ok");
      return;
    }
    btnModels.disabled = true;
    setStatus("正在连接并获取模型列表…", "");
    try {
      const models = await hooks.listModels(config);
      modelsByPreset.set(config.presetId, models);
      fillModelList(models);
      if (!models.length) {
        setStatus("连接成功，但该接口没有返回任何模型，请手动填写模型名。", "bad");
        return;
      }
      // 模型名还空着时，直接替用户选上第一个，省一步操作。
      if (!model.value.trim()) {
        model.value = models[0];
        modelList.value = models[0];
        rememberCurrent();
        syncSavedHighlight();
      }
      setStatus(`连接成功 — 共 ${models.length} 个模型，请在上方下拉框中选择。`, "ok");
    } catch (err) {
      fillModelList([]);
      setStatus(`获取失败：${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      btnModels.disabled = false;
    }
  });
  btnTest.addEventListener("click", async () => {
    const config = read();
    if (config.kind === "heuristic") {
      setStatus("内置机器人无需联网。", "ok");
      return;
    }
    btnTest.disabled = true;
    setStatus("测试中…", "");
    try {
      const say = await hooks.test(config);
      setStatus(`对话成功 — ${say}`, "ok");
    } catch (err) {
      setStatus(`失败：${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      btnTest.disabled = false;
    }
  });

  fill(initial);
  return {
    open() {
      fill(loadSettings());
      modal.classList.remove("hidden");
    }
  };
}

export interface SetupPanelHooks {
  onStart(match: MatchSettings): void;
  /** 点击「选择 AI」时打开供应商设置。 */
  onPickAi(): void;
}

/** 开局设置面板：双方命数、先手、对手 AI。 */
export function initSetupPanel(hooks: SetupPanelHooks): { open(match: MatchSettings): void; setAiSummary(html: string, cls: string): void } {
  const modal = $("modal-setup");
  const playerLives = $<HTMLInputElement>("setup-player-lives");
  const aiLives = $<HTMLInputElement>("setup-ai-lives");
  const first = $<HTMLSelectElement>("setup-first");
  const aiSummary = $("setup-ai-summary");

  const read = (): MatchSettings => ({
    playerLives: Math.round(clampNum(playerLives.value, 1, 60, 12)),
    aiLives: Math.round(clampNum(aiLives.value, 1, 60, 12)),
    firstMover: first.value === "ai" ? "ai" : first.value === "player" ? "player" : "random"
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    btn.addEventListener("click", () => {
      const [p, a] = (btn.dataset.preset ?? "12,12").split(",").map(Number);
      playerLives.value = String(p);
      aiLives.value = String(a);
    });
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-step]")) {
    btn.addEventListener("click", () => {
      const [target, delta] = (btn.dataset.step ?? "").split(":");
      const input = target === "ai" ? aiLives : playerLives;
      input.value = String(Math.round(clampNum(input.value, 1, 60, 12) + Number(delta)));
      input.value = String(Math.max(1, Math.min(60, Number(input.value))));
    });
  }

  $("setup-ai-btn").addEventListener("click", () => hooks.onPickAi());
  $("setup-start").addEventListener("click", () => {
    const match = read();
    const settings = loadSettings();
    saveSettings({ ...settings, match });
    modal.classList.add("hidden");
    hooks.onStart(match);
  });

  return {
    open(match) {
      playerLives.value = String(match.playerLives);
      aiLives.value = String(match.aiLives);
      first.value = match.firstMover;
      modal.classList.remove("hidden");
    },
    setAiSummary(html, cls) {
      aiSummary.innerHTML = html;
      aiSummary.className = `summary ${cls}`;
    }
  };
}
