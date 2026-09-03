import {
  buildObservation,
  buildUserPrompt,
  decide,
  FULL_SYSTEM_PROMPT,
  providerDisplayName,
  testConnection,
  type AiDecision,
  type AiTrace
} from "./ai/brain.js";
import { listModels } from "./ai/providers.js";
import { cardLabel } from "./game/cards.js";
import {
  act,
  clearTable,
  legalBets,
  newGame,
  selectCard,
  startRound,
  type BetInput,
  type GameState
} from "./game/engine.js";
import { TableScene } from "./scene/table.js";
import { initSettingsPanel, initSetupPanel, loadSettings, type AppSettings, type MatchSettings } from "./ui/settings.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: AppSettings = loadSettings();
let state: GameState;
let gameId = 0;
let aiBusy = false;

const stage = $("stage");
const table = new TableScene(stage, {
  onCardClick: (cardId) => onPlayerPick(cardId)
});

const ui = {
  statAi: $("stat-ai"),
  statPlayer: $("stat-player"),
  aiLives: $("stat-ai").querySelector(".lives")!,
  playerLives: $("stat-player").querySelector(".lives")!,
  round: $("round-info"),
  bubble: $("bubble"),
  bubbleText: $("bubble").querySelector(".text")!,
  banner: $("banner"),
  flash: $("flash"),
  status: $("status"),
  actions: $("actions"),
  nextWrap: $("next-wrap"),
  log: $("log"),
  stakeYou: $("stake-you"),
  stakeAi: $("stake-ai"),
  stakeMax: $("stake-max"),
  btnCheck: $<HTMLButtonElement>("btn-check"),
  btnCall: $<HTMLButtonElement>("btn-call"),
  btnFold: $<HTMLButtonElement>("btn-fold"),
  btnRaise: $<HTMLButtonElement>("btn-raise"),
  btnAllIn: $<HTMLButtonElement>("btn-allin"),
  raiseRange: $<HTMLInputElement>("raise-range"),
  raiseValue: $("raise-value"),
  raiseRow: $("actions").querySelector<HTMLElement>(".raise")!,
  overlay: $("overlay"),
  overlayKicker: $("overlay").querySelector<HTMLElement>(".kicker")!,
  overlayTitle: $("overlay").querySelector<HTMLElement>(".title")!,
  overlaySub: $("overlay").querySelector<HTMLElement>(".sub")!,
  chip: $<HTMLButtonElement>("ai-chip"),
  chipWho: $("ai-chip-who"),
  chipState: $("ai-chip-state"),
  thinkPanel: $("think-panel"),
  thinkBody: $("tp-body"),
  thinkProvider: $("tp-provider")
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function providerLabel(short = false): string {
  const name = providerDisplayName(settings.provider);
  const label = short ? name.short : name.label;
  return name.model ? `${label} · ${name.model}` : label;
}

// ---------- AI 状态指示 & 思考面板 ----------

const MAX_TRACES = 40;
const traces: AiTrace[] = [];
/** 每条记录对应的 DOM 引用，流式更新时只改文本，不重建，避免用户展开的状态被重置。 */
const traceViews = new Map<number, { root: HTMLDetailsElement; st: HTMLElement; reasoning: HTMLElement; output: HTMLElement; result: HTMLElement; meta: HTMLElement; secReasoning: HTMLElement; secOutput: HTMLElement; secErr: HTMLElement; err: HTMLElement; rn: HTMLElement; on: HTMLElement }>();
let chipTimer: ReturnType<typeof setInterval> | undefined;
let currentTrace: AiTrace | undefined;

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function renderChip(): void {
  const t = currentTrace;
  const heuristic = settings.provider.kind === "heuristic";
  ui.chipWho.textContent = providerLabel(true);
  ui.thinkProvider.textContent = providerLabel();
  let cls = heuristic ? "local" : "idle";
  let text = heuristic ? "本地" : "待命";
  if (t && t.status === "thinking") {
    cls = "thinking";
    text = `思考中 ${fmtSec(Date.now() - t.startedAt)}${t.output || t.reasoning ? " · 流式输出中" : ""}`;
  } else if (t && t.status === "ok") {
    cls = "ok";
    text = `已回复 ${fmtSec((t.endedAt ?? Date.now()) - t.startedAt)}`;
  } else if (t && t.status === "fallback") {
    cls = "fallback";
    text = "失联 · 已回退内置机器人";
    ui.chip.title = `AI 调用失败：${t.error ?? ""}\n点击查看详情`;
  }
  if (cls !== "fallback") ui.chip.title = "点击查看 AI 思考细节";
  ui.chip.className = cls;
  ui.chipState.textContent = text;
  if (cls === "thinking" && !chipTimer) chipTimer = setInterval(renderChip, 200);
  if (cls !== "thinking" && chipTimer) {
    clearInterval(chipTimer);
    chipTimer = undefined;
  }
}

function traceStatusText(t: AiTrace): string {
  const dur = fmtSec((t.endedAt ?? Date.now()) - t.startedAt);
  switch (t.status) {
    case "thinking":
      return `思考中 ${dur}`;
    case "ok":
      return `模型已回复 · ${dur}`;
    case "fallback":
      return `失联，回退内置机器人 · ${dur}`;
    default:
      return "内置机器人";
  }
}

function makeSection(title: string, cls: string): { sec: HTMLElement; pre: HTMLElement; n: HTMLElement } {
  const sec = document.createElement("div");
  sec.className = "sec";
  const h = document.createElement("div");
  h.className = "h";
  const n = document.createElement("span");
  n.className = "n";
  h.append(title, n);
  const pre = document.createElement("pre");
  pre.className = cls;
  sec.append(h, pre);
  return { sec, pre, n };
}

function buildTraceView(t: AiTrace): void {
  const root = document.createElement("details");
  root.className = `trace ${t.status}`;
  root.open = true;
  const sum = document.createElement("summary");
  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "▶";
  const rt = document.createElement("span");
  rt.className = "rt";
  rt.textContent = `R${t.round}`;
  const task = document.createElement("span");
  task.className = "task";
  task.textContent = t.kind === "select" ? "选牌" : "下注";
  const st = document.createElement("span");
  st.className = "st";
  sum.append(arrow, rt, task, st);
  const body = document.createElement("div");
  body.className = "body";

  const result = document.createElement("div");
  result.className = "result";
  const meta = document.createElement("div");
  meta.className = "meta";

  const prompt = document.createElement("details");
  prompt.className = "sub";
  const ps = document.createElement("summary");
  ps.textContent = "提示词（发给模型的完整内容）";
  const pre1 = document.createElement("pre");
  pre1.textContent = `[system]\n${t.system}\n\n[user]\n${t.user}`;
  prompt.append(ps, pre1);
  if (t.status === "heuristic") prompt.classList.add("hidden");

  const r = makeSection("推理", "reasoning");
  const o = makeSection("回复（原文）", "output");
  const e = makeSection("错误", "err");

  body.append(result, meta, r.sec, o.sec, e.sec, prompt);
  root.append(sum, body);
  traceViews.set(t.id, {
    root,
    st,
    reasoning: r.pre,
    output: o.pre,
    result,
    meta,
    secReasoning: r.sec,
    secOutput: o.sec,
    secErr: e.sec,
    err: e.pre,
    rn: r.n,
    on: o.n
  });
  ui.thinkBody.querySelector(".tp-empty")?.remove();
  // 新记录放最上面，旧记录自动折叠。
  for (const v of traceViews.values()) if (v.root !== root) v.root.open = false;
  ui.thinkBody.prepend(root);
}

function updateTraceView(t: AiTrace): void {
  const v = traceViews.get(t.id);
  if (!v) return;
  v.root.className = `trace ${t.status}`;
  v.st.textContent = traceStatusText(t);
  const streaming = t.status === "thinking";
  v.secReasoning.classList.toggle("hidden", !t.reasoning && !streaming);
  v.secOutput.classList.toggle("hidden", !t.output && !streaming && t.status !== "heuristic");
  if (t.status === "heuristic") {
    // 内置机器人没有模型原文，但有自己的推理过程。
    v.secReasoning.classList.toggle("hidden", !t.reasoning);
    v.secOutput.classList.add("hidden");
  }
  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  const setStream = (el: HTMLElement, text: string, placeholder: string) => {
    const stick = atBottom(el);
    el.textContent = text || (streaming ? placeholder : "");
    el.classList.toggle("cursor", streaming);
    if (stick) el.scrollTop = el.scrollHeight;
  };
  setStream(v.reasoning, t.reasoning, "等待模型输出推理…");
  setStream(v.output, t.output, "等待模型回复…");
  v.rn.textContent = t.reasoning ? `${t.reasoning.length} 字` : "";
  v.on.textContent = t.output ? `${t.output.length} 字` : "";
  v.secErr.classList.toggle("hidden", !t.error);
  v.err.textContent = t.error ?? "";
  v.result.innerHTML = t.summary ? `<b>决策</b> ${escapeHtml(t.summary)}` : streaming ? "<b>决策</b> 尚未得出…" : "";
  const meta: string[] = [];
  if (t.attempt > 1) meta.push(`<span class="cut">第 ${t.attempt} 次尝试</span>`);
  if (t.usage?.input != null) {
    const cached = t.usage.cached ?? 0;
    meta.push(`输入 ${t.usage.input} tokens`);
    meta.push(cached > 0 ? `<span class="hit">缓存命中 ${cached}（${Math.round((cached / t.usage.input) * 100)}%）</span>` : "缓存命中 0");
  }
  if (t.usage?.output != null) meta.push(`输出 ${t.usage.output} tokens`);
  if (t.finishReason === "length") meta.push(`<span class="cut">输出被长度上限截断</span>`);
  v.meta.innerHTML = meta.join(" · ");
  v.meta.classList.toggle("hidden", meta.length === 0);
}

function onTrace(t: AiTrace): void {
  if (!traces.includes(t)) {
    traces.push(t);
    while (traces.length > MAX_TRACES) {
      const old = traces.shift()!;
      traceViews.get(old.id)?.root.remove();
      traceViews.delete(old.id);
    }
    buildTraceView(t);
  }
  currentTrace = t;
  updateTraceView(t);
  renderChip();
}

function toggleThinkPanel(force?: boolean): void {
  const show = force ?? ui.thinkPanel.classList.contains("hidden");
  ui.thinkPanel.classList.toggle("hidden", !show);
  ui.log.classList.toggle("pushed", show);
}

/** 开局面板里的「对手 AI」摘要。 */
function aiSummaryHtml(): { html: string; cls: string } {
  const p = settings.provider;
  const { label, model } = providerDisplayName(p);
  if (p.kind === "heuristic") {
    return { html: `<b>${escapeHtml(label)}</b><small>本地算法：记牌、读牌、对手行为建模与期望值计算，不需要 API。想让大模型来扮演和也，点右侧按钮选择。</small>`, cls: "" };
  }
  const head = `<b>${escapeHtml(label)}</b> · ${escapeHtml(model || "（未填模型）")}`;
  if (!p.apiKey && p.kind !== "openai-compatible") {
    return { html: `${head}<small>尚未填写 API 密钥，开局后每次决策都会失败并回退到内置机器人。</small>`, cls: "bad" };
  }
  if (!model) return { html: `${head}<small>模型名为空，请先在设置里选择模型。</small>`, cls: "warn" };
  const host = (() => {
    try {
      return new URL(p.baseUrl).host;
    } catch {
      return p.baseUrl;
    }
  })();
  return { html: `${head}<small>${escapeHtml(host)}${p.apiKey ? " · 密钥已填" : " · 无密钥"} · 超时 ${Math.round(p.timeoutMs / 1000)}s</small>`, cls: "" };
}

// ---------- 渲染 ----------

let lastLives = { player: -1, ai: -1 };

function render(): void {
  const P = state.players.player;
  const A = state.players.ai;
  ui.playerLives.textContent = String(P.lives);
  ui.aiLives.textContent = String(A.lives);
  if (lastLives.player !== -1 && lastLives.player !== P.lives) bump(ui.statPlayer);
  if (lastLives.ai !== -1 && lastLives.ai !== A.lives) bump(ui.statAi);
  lastLives = { player: P.lives, ai: A.lives };
  ui.round.textContent =
    state.phase === "gameover"
      ? "对局结束"
      : `第 ${state.round} 回合 · ${state.players[state.firstMover].name}先手 · 牌堆 ${state.deck.length} 张`;

  const canPick = state.phase === "select" && !P.chosen;
  table.sync(state, canPick);

  let status = "";
  if (state.phase === "select") {
    if (!P.chosen) status = "点击你的一张手牌，盖着打出。";
    else if (!A.chosen) status = "和也正在选牌…";
  } else if (state.phase === "betting") {
    const last = state.actions[state.actions.length - 1];
    if (state.toAct !== "player") status = "和也正在思考…";
    else if (last?.type === "call") status = `和也跟注了。你可以过牌开牌，或继续加注。你打出的是 ${cardLabel(P.chosen!)}。`;
    else status = `轮到你下注。你打出的是 ${cardLabel(P.chosen!)}。`;
  } else if (state.phase === "showdown" || state.phase === "gameover") {
    const r = state.lastResult!;
    const cards = `${cardLabel(P.chosen!)} 对 ${cardLabel(A.chosen!)}`;
    status = r.reason === "fold" ? `${r.result === "player" ? "和也弃牌了" : "你弃牌了"}。${cards}` : cards;
  }
  ui.status.textContent = status;

  const myTurn = state.phase === "betting" && state.toAct === "player";
  ui.actions.classList.toggle("hidden", !myTurn);
  if (myTurn) {
    const legal = legalBets(state, "player");
    ui.stakeYou.textContent = String(P.stake);
    ui.stakeAi.textContent = String(A.stake);
    ui.stakeMax.textContent = String(state.maxStake);
    ui.btnCheck.disabled = !legal.canCheck;
    ui.btnCall.disabled = !legal.canCall;
    ui.btnCall.textContent = legal.canCall ? `跟注 +${legal.callAmount}` : "跟注";
    ui.btnFold.disabled = !legal.canFold;
    ui.raiseRow.classList.toggle("hidden", !legal.canRaise);
    if (legal.canRaise) {
      ui.raiseRange.min = String(legal.minRaiseTo);
      ui.raiseRange.max = String(legal.maxRaiseTo);
      const current = Number(ui.raiseRange.value);
      ui.raiseRange.value = String(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, current || legal.minRaiseTo)));
      ui.raiseValue.textContent = ui.raiseRange.value;
    }
  }

  ui.nextWrap.classList.toggle("hidden", state.phase !== "showdown");
  renderLog();
}

function bump(el: HTMLElement): void {
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

function renderLog(): void {
  const parts: string[] = [];
  let lastRound = -1;
  for (const entry of state.log) {
    if (entry.round !== lastRound) {
      lastRound = entry.round;
      parts.push(`<div class="r">${entry.round === 0 ? "开局" : `第 ${entry.round} 回合`}</div>`);
    }
    const cls = entry.text.startsWith("[AI]") ? "err" : "";
    parts.push(`<div class="${cls}">${escapeHtml(entry.text)}</div>`);
  }
  ui.log.innerHTML = parts.join("");
  ui.log.scrollTop = ui.log.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
function speak(decision: AiDecision): void {
  const note = decision.source === "llm" ? providerLabel() : `内置机器人${decision.error ? `（${providerLabel()} 失联，已回退）` : ""}`;
  ui.bubbleText.innerHTML = `${escapeHtml(decision.say)}<small>${escapeHtml(note)}</small>`;
  ui.bubble.classList.remove("hidden");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => ui.bubble.classList.add("hidden"), 9000);
  if (decision.error) {
    state.log.push({ round: state.round, text: `[AI] 供应商调用失败，改用内置机器人：${decision.error}` });
  }
}

function showBanner(big: string, sub: string, cls: string): void {
  ui.banner.innerHTML = `<div class="big">${escapeHtml(big)}</div><div class="sub">${escapeHtml(sub)}</div>`;
  ui.banner.className = cls;
}
function hideBanner(): void {
  ui.banner.className = "hidden";
}
function screenFlash(cls: "win" | "lose"): void {
  ui.flash.className = "";
  void ui.flash.offsetWidth;
  ui.flash.className = cls;
}

// ---------- 对局流程 ----------

function clearTraces(): void {
  traces.length = 0;
  for (const v of traceViews.values()) v.root.remove();
  traceViews.clear();
  currentTrace = undefined;
  if (!ui.thinkBody.querySelector(".tp-empty")) {
    const empty = document.createElement("div");
    empty.className = "tp-empty";
    empty.textContent = "还没有任何决策。轮到和也时，这里会实时显示模型的推理与回复。";
    ui.thinkBody.append(empty);
  }
  renderChip();
}

function beginGame(match: MatchSettings): void {
  gameId += 1;
  aiBusy = false;
  clearTraces();
  hideBanner();
  ui.overlay.classList.add("hidden");
  ui.bubble.classList.add("hidden");
  lastLives = { player: -1, ai: -1 };
  state = newGame({
    playerLives: match.playerLives,
    aiLives: match.aiLives,
    firstMover: match.firstMover
  });
  startRound(state);
  render();
  void aiSelect();
}

async function aiThink<T>(fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await fn();
  const elapsed = performance.now() - started;
  if (elapsed < 700) await sleep(700 - elapsed);
  return result;
}

async function aiSelect(): Promise<void> {
  const id = gameId;
  const round = state.round;
  const decision = await aiThink(() => decide(state, "select", settings.provider, onTrace));
  if (id !== gameId || state.round !== round || state.phase !== "select" || state.players.ai.chosen) return;
  selectCard(state, "ai", decision.cardId!);
  speak(decision);
  render();
  void afterAction();
}

function onPlayerPick(cardId: string): void {
  if (state.phase !== "select" || state.players.player.chosen) return;
  selectCard(state, "player", cardId);
  render();
  void afterAction();
}

async function afterAction(): Promise<void> {
  if (state.phase === "betting" && state.toAct === "ai" && !aiBusy) {
    await aiBet();
  } else if (state.phase === "showdown" || state.phase === "gameover") {
    showResult();
  }
}

async function aiBet(): Promise<void> {
  const id = gameId;
  const round = state.round;
  aiBusy = true;
  render();
  try {
    const decision = await aiThink(() => decide(state, "bet", settings.provider, onTrace));
    if (id !== gameId || state.round !== round || state.phase !== "betting" || state.toAct !== "ai") return;
    const bet = decision.bet!;
    const stakeBefore = state.players.ai.stake;
    act(state, "ai", bet);
    // 跟注/收尾过牌会立刻结算本回合，而结算会把双方押注清零，
    // 所以播报要用动作记录里的 stakeAfter，不能读实时 stake。
    const stakeAfter = state.actions[state.actions.length - 1]?.stakeAfter ?? stakeBefore;
    speak(decision);
    // 弃牌由结算横幅播报「和也弃牌」，这里不重复；其余动作先大字播报再继续流程。
    if (bet.type !== "fold") {
      await announceAiAction(bet, stakeBefore, stakeAfter);
      if (id !== gameId || state.round !== round) return;
    }
  } finally {
    aiBusy = false;
  }
  render();
  void afterAction();
}

const ACTION_HOLD_MS = 1300;
async function announceAiAction(bet: BetInput, stakeBefore: number, stakeAfter: number): Promise<void> {
  let big = "";
  if (bet.type === "check") big = "过牌";
  else if (bet.type === "call") big = "跟注";
  else if (bet.type === "raise") big = stakeAfter >= state.maxStake ? "全下" : "加注";
  let sub = `和也 · 赌注 ${stakeBefore} → ${stakeAfter}`;
  if (bet.type === "check") sub = `和也 · 赌注 ${stakeAfter}`;
  else if (bet.type === "call") sub = `和也 · 跟到 ${stakeAfter}`;
  showBanner(big, sub, "announce");
  await sleep(ACTION_HOLD_MS);
  if (ui.banner.className === "announce") hideBanner();
}

function playerBet(input: BetInput): void {
  if (state.phase !== "betting" || state.toAct !== "player") return;
  try {
    act(state, "player", input);
  } catch (err) {
    ui.status.textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  render();
  void afterAction();
}

function showResult(): void {
  const r = state.lastResult!;
  const P = state.players.player;
  const A = state.players.ai;
  const gameOver = state.phase === "gameover";
  let cls = "draw";
  let big = "平局";
  let sub = "赌注退回";
  if (r.result === "player") {
    cls = "win";
    big = r.reason === "fold" ? "和也弃牌" : "胜";
    sub = `夺得 ${r.livesMoved} 命`;
    table.playerWins(gameOver || r.livesMoved >= 3);
    screenFlash("win");
  } else if (r.result === "ai") {
    cls = "lose";
    big = r.reason === "fold" ? "弃牌" : "负";
    sub = `失去 ${r.livesMoved} 命`;
    table.playerLoses(gameOver || r.livesMoved >= 3);
    screenFlash("lose");
  } else {
    table.draw();
  }
  sub = `${cardLabel(P.chosen!)} 对 ${cardLabel(A.chosen!)} · ${sub}`;
  if (r.reason === "showdown") {
    if ((P.chosen!.rank === 2 && A.chosen!.rank === 14) || (P.chosen!.rank === 14 && A.chosen!.rank === 2)) {
      sub += " · 2 胜 A！";
    }
  }
  showBanner(big, sub, cls);
  if (gameOver) {
    const won = state.winner === "player";
    setTimeout(() => {
      if (state.phase !== "gameover") return;
      hideBanner();
      ui.overlay.className = won ? "win" : "lose";
      ui.overlayKicker.textContent = won ? "和也破产" : "开司破产";
      ui.overlayTitle.textContent = won ? "胜利" : "败北";
      ui.overlaySub.textContent = won
        ? `第 ${state.round} 回合，和也的最后一命归你。${sub}`
        : `第 ${state.round} 回合，你的命全部输光。${sub}`;
      if (won) table.playerWins(true);
      else table.playerLoses(true);
    }, 1900);
    return;
  }
  setTimeout(() => {
    if (state.phase === "showdown") hideBanner();
  }, 2400);
}

function nextRound(): void {
  if (state.phase !== "showdown") return;
  hideBanner();
  clearTable(state);
  startRound(state);
  render();
  void aiSelect();
}

// ---------- 事件绑定 ----------

ui.btnCheck.addEventListener("click", () => playerBet({ type: "check" }));
ui.btnCall.addEventListener("click", () => playerBet({ type: "call" }));
ui.btnFold.addEventListener("click", () => playerBet({ type: "fold" }));
ui.btnRaise.addEventListener("click", () => playerBet({ type: "raise", raiseTo: Number(ui.raiseRange.value) }));
ui.btnAllIn.addEventListener("click", () => playerBet({ type: "raise", raiseTo: state.maxStake }));
ui.raiseRange.addEventListener("input", () => (ui.raiseValue.textContent = ui.raiseRange.value));
$("btn-next").addEventListener("click", nextRound);

const setupPanel = initSetupPanel({
  onStart(match) {
    settings = { ...settings, match };
    beginGame(match);
  },
  onPickAi() {
    settingsPanel.open();
  }
});
const refreshAiSummary = () => {
  const { html, cls } = aiSummaryHtml();
  setupPanel.setAiSummary(html, cls);
};
const openSetup = () => {
  refreshAiSummary();
  setupPanel.open(loadSettings().match);
};
$("btn-new").addEventListener("click", openSetup);
$("overlay-btn").addEventListener("click", openSetup);

const settingsPanel = initSettingsPanel(settings, {
  onSave(next) {
    settings = next;
    currentTrace = undefined;
    renderChip();
    refreshAiSummary();
    if (state) {
      state.log.push({ round: state.round, text: `AI 供应商已设为 ${providerLabel()}。` });
      renderLog();
    }
  },
  test: testConnection,
  listModels
});
$("btn-settings").addEventListener("click", () => settingsPanel.open());
$("btn-think").addEventListener("click", () => toggleThinkPanel());
ui.chip.addEventListener("click", () => toggleThinkPanel());
$("tp-close").addEventListener("click", () => toggleThinkPanel(false));
renderChip();
$("btn-rules").addEventListener("click", () => $("modal-rules").classList.remove("hidden"));
$("rules-close").addEventListener("click", () => $("modal-rules").classList.add("hidden"));
$("btn-prompt").addEventListener("click", () => {
  $("prompt-system").textContent = FULL_SYSTEM_PROMPT;
  const kind = state && state.phase === "betting" ? "bet" : "select";
  $("prompt-user").textContent = state ? buildUserPrompt(buildObservation(state, kind)) : "（尚未开始对局）";
  $("modal-prompt").classList.remove("hidden");
});
$("prompt-close").addEventListener("click", () => $("modal-prompt").classList.add("hidden"));
for (const modal of document.querySelectorAll<HTMLElement>(".modal")) {
  if (modal.id === "modal-setup") continue;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && state && state.phase === "showdown") nextRound();
});

// 先让玩家设置命数，再开局。
openSetup();

// 调试句柄（生产环境无害，便于自动化冒烟测试）。
(window as unknown as { __pokesolo: unknown }).__pokesolo = {
  get state() {
    return state;
  },
  table,
  pick: onPlayerPick,
  traces,
  start: (match: MatchSettings) => {
    $("modal-setup").classList.add("hidden");
    beginGame(match);
  }
};
