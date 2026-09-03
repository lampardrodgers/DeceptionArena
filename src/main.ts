import { buildObservation, buildUserPrompt, decide, SYSTEM_PROMPT, testConnection, type AiDecision } from "./ai/brain.js";
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
  overlaySub: $("overlay").querySelector<HTMLElement>(".sub")!
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function providerLabel(): string {
  const p = settings.provider;
  return p.kind === "heuristic" ? "内置机器人" : `${p.presetId} · ${p.model}`;
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
    status = state.toAct === "player" ? `轮到你下注。你打出的是 ${cardLabel(P.chosen!)}。` : "和也正在思考…";
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
  const note = decision.source === "llm" ? providerLabel() : `内置机器人${decision.error ? "（API 失败，已回退）" : ""}`;
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

function beginGame(match: MatchSettings): void {
  gameId += 1;
  aiBusy = false;
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
  const decision = await aiThink(() => decide(state, "select", settings.provider));
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
    const decision = await aiThink(() => decide(state, "bet", settings.provider));
    if (id !== gameId || state.round !== round || state.phase !== "betting" || state.toAct !== "ai") return;
    const bet = decision.bet!;
    const stakeBefore = state.players.ai.stake;
    act(state, "ai", bet);
    speak(decision);
    // 弃牌由结算横幅播报「和也弃牌」，这里不重复；其余动作先大字播报再继续流程。
    if (bet.type !== "fold") {
      await announceAiAction(bet, stakeBefore);
      if (id !== gameId || state.round !== round) return;
    }
  } finally {
    aiBusy = false;
  }
  render();
  void afterAction();
}

const ACTION_HOLD_MS = 1300;
async function announceAiAction(bet: BetInput, stakeBefore: number): Promise<void> {
  const A = state.players.ai;
  let big = "";
  if (bet.type === "check") big = "过牌";
  else if (bet.type === "call") big = "跟注";
  else if (bet.type === "raise") big = A.stake >= state.maxStake ? "全下" : "加注";
  let sub = `和也 · 赌注 ${stakeBefore} → ${A.stake}`;
  if (bet.type === "check") sub = `和也 · 赌注 ${A.stake}`;
  else if (bet.type === "call") sub = `和也 · 跟到 ${A.stake}`;
  showBanner(big, sub, "action");
  await sleep(ACTION_HOLD_MS);
  if (ui.banner.className === "action") hideBanner();
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
  }
});
const openSetup = () => setupPanel.open(loadSettings().match);
$("btn-new").addEventListener("click", openSetup);
$("overlay-btn").addEventListener("click", openSetup);

const settingsPanel = initSettingsPanel(settings, {
  onSave(next) {
    settings = next;
    if (state) {
      state.log.push({ round: state.round, text: `AI 供应商已设为 ${providerLabel()}。` });
      renderLog();
    }
  },
  test: testConnection
});
$("btn-settings").addEventListener("click", () => settingsPanel.open());
$("btn-rules").addEventListener("click", () => $("modal-rules").classList.remove("hidden"));
$("rules-close").addEventListener("click", () => $("modal-rules").classList.add("hidden"));
$("btn-prompt").addEventListener("click", () => {
  $("prompt-system").textContent = SYSTEM_PROMPT;
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
  start: (match: MatchSettings) => {
    $("modal-setup").classList.add("hidden");
    beginGame(match);
  }
};
