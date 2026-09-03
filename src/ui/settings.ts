import { PROVIDER_PRESETS, type ProviderConfig } from "../ai/providers.js";
import { type Side } from "../game/engine.js";

export interface MatchSettings {
  playerLives: number;
  aiLives: number;
  firstMover: Side | "random";
}

export interface AppSettings {
  provider: ProviderConfig;
  match: MatchSettings;
}

const KEY = "pokesolo.settings.v2";

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
      timeoutMs: 90000
    },
    match: { playerLives: 12, aiLives: 12, firstMover: "random" }
  };
}

export function loadSettings(): AppSettings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      provider: { ...base.provider, ...(parsed.provider ?? {}) },
      match: { ...base.match, ...(parsed.match ?? {}) }
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

export interface SettingsPanelHooks {
  onSave(settings: AppSettings): void;
  test(config: ProviderConfig): Promise<string>;
  listModels(config: ProviderConfig): Promise<string[]>;
}

/** AI 供应商设置面板。 */
export function initSettingsPanel(initial: AppSettings, hooks: SettingsPanelHooks): { open(): void } {
  const modal = $("modal-settings");
  const provider = $<HTMLSelectElement>("cfg-provider");
  const url = $<HTMLInputElement>("cfg-url");
  const key = $<HTMLInputElement>("cfg-key");
  const model = $<HTMLInputElement>("cfg-model");
  const modelList = $<HTMLSelectElement>("cfg-model-list");
  const temp = $<HTMLInputElement>("cfg-temp");
  const timeout = $<HTMLInputElement>("cfg-timeout");
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

  /** 记住每个预设在本次会话中的 URL / 模型 / 密钥，切换回来时不丢失。 */
  const perPreset = new Map<string, { baseUrl: string; model: string; apiKey: string }>();
  /** 每个预设最近一次拉到的模型列表，切换回来时不用重新请求。 */
  const modelsByPreset = new Map<string, string[]>();

  const setStatus = (text: string, cls: "" | "ok" | "bad") => {
    testResult.textContent = text;
    testResult.className = cls;
  };

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

  const applyPreset = (id: string, keepValues: boolean) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0];
    const saved = perPreset.get(preset.id);
    const isApi = preset.kind !== "heuristic";
    url.disabled = !isApi || !preset.editableUrl;
    key.disabled = !isApi;
    model.disabled = !isApi;
    temp.disabled = !isApi;
    timeout.disabled = !isApi;
    if (!keepValues) {
      url.value = saved?.baseUrl ?? preset.baseUrl;
      model.value = saved?.model ?? preset.defaultModel;
      key.value = saved?.apiKey ?? "";
    }
    notes.textContent = preset.notes;
    modelList.disabled = !isApi;
    fillModelList(modelsByPreset.get(preset.id) ?? []);
  };

  const fill = (settings: AppSettings) => {
    provider.value = settings.provider.presetId;
    applyPreset(settings.provider.presetId, true);
    url.value = settings.provider.baseUrl;
    key.value = settings.provider.apiKey;
    model.value = settings.provider.model;
    temp.value = String(settings.provider.temperature);
    timeout.value = String(Math.round(settings.provider.timeoutMs / 1000));
    perPreset.set(settings.provider.presetId, {
      baseUrl: settings.provider.baseUrl,
      model: settings.provider.model,
      apiKey: settings.provider.apiKey
    });
    fillModelList(modelsByPreset.get(settings.provider.presetId) ?? []);
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
      timeoutMs: clampNum(timeout.value, 5, 600, 90) * 1000
    };
  };

  provider.addEventListener("change", () => applyPreset(provider.value, false));
  for (const el of [url, model, key]) {
    el.addEventListener("input", () => {
      perPreset.set(provider.value, { baseUrl: url.value, model: model.value, apiKey: key.value });
    });
  }
  model.addEventListener("input", () => {
    const options = [...modelList.options].map((o) => o.value);
    modelList.value = options.includes(model.value.trim()) ? model.value.trim() : "";
  });
  modelList.addEventListener("change", () => {
    if (!modelList.value) return;
    model.value = modelList.value;
    perPreset.set(provider.value, { baseUrl: url.value, model: model.value, apiKey: key.value });
    setStatus(`已选择模型 ${modelList.value}。`, "ok");
  });

  $("cfg-cancel").addEventListener("click", () => modal.classList.add("hidden"));
  $("cfg-save").addEventListener("click", () => {
    const settings: AppSettings = { ...loadSettings(), provider: read() };
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
        perPreset.set(provider.value, { baseUrl: url.value, model: model.value, apiKey: key.value });
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

/** 开局设置面板：双方命数与先手。 */
export function initSetupPanel(hooks: { onStart(match: MatchSettings): void }): { open(match: MatchSettings): void } {
  const modal = $("modal-setup");
  const playerLives = $<HTMLInputElement>("setup-player-lives");
  const aiLives = $<HTMLInputElement>("setup-ai-lives");
  const first = $<HTMLSelectElement>("setup-first");

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
    }
  };
}
