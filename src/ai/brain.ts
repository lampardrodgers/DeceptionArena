import { type Card, cardLabel, category, RANK_LABEL } from "../game/cards.js";
import { type BetInput, type GameState, type Side, legalBets, lightsOf } from "../game/engine.js";
import { botBet, botSelect, estimateWin, publicView, RANKS, unknownPool } from "./bot.js";
import { callProvider, extractJson, PROVIDER_PRESETS, type ChatUsage, type ProviderConfig } from "./providers.js";

export type DecisionKind = "select" | "bet";

export interface AiDecision {
  kind: DecisionKind;
  cardId?: string;
  bet?: BetInput;
  say: string;
  source: "llm" | "heuristic";
  error?: string;
  raw?: string;
  /** 内置机器人的推理过程（人类可读）。 */
  reasoning?: string;
}

export type AiTraceStatus = "thinking" | "ok" | "fallback" | "heuristic";

/**
 * 一次 AI 决策的完整过程记录。流式输出期间同一个对象会被不断更新，
 * 每次更新都会通知观察者，便于界面实时显示。
 */
export interface AiTrace {
  id: number;
  round: number;
  kind: DecisionKind;
  providerId: string;
  providerLabel: string;
  model: string;
  status: AiTraceStatus;
  startedAt: number;
  endedAt?: number;
  system: string;
  user: string;
  /** 模型的推理内容（原生思维链 + JSON 里的 reasoning 字段）。 */
  reasoning: string;
  /** 模型原始正文（流式累积）。 */
  output: string;
  /** 最终采纳的决策（人类可读）。 */
  summary?: string;
  error?: string;
  usage?: ChatUsage;
  /** 供应商给出的结束原因（"length" = 被长度上限截断）。 */
  finishReason?: string;
  /** 第几次尝试（首次为 1；模型没给出 JSON 时会追加提示重试一次）。 */
  attempt: number;
}

export type TraceObserver = (trace: AiTrace) => void;

let traceSeq = 0;

/** 供应商的显示名：label 为完整名称，short 为顶栏用的简称（自定义地址时显示主机名）。 */
export function providerDisplayName(config: ProviderConfig): { label: string; short: string; model: string } {
  const preset = PROVIDER_PRESETS.find((p) => p.id === config.presetId);
  if (config.kind === "heuristic") return { label: "内置机器人", short: "内置机器人", model: "" };
  const label = preset?.label ?? config.presetId;
  let short = label.replace(/[（(].*$/, "").trim();
  if (config.presetId === "openai-compatible") {
    try {
      short = new URL(config.baseUrl).host;
    } catch {
      // 保留简称
    }
  }
  return { label, short, model: config.model };
}

const AI: Side = "ai";
const HUMAN: Side = "player";

// ---------- 内置算法机器人 ----------
// 概率模型、对手建模和期望值计算都在 ./bot.ts；这里只做适配。

/** 我方某张牌对上开司本局打出的牌的胜率估计（记牌 + 读牌 + 本局下注证据）。 */
export function winProbability(state: GameState, mine: Card): { win: number; lose: number; draw: number } {
  return estimateWin(publicView(state), mine);
}

export function heuristicSelect(state: GameState, rng = Math.random): AiDecision {
  const d = botSelect(publicView(state), rng);
  return { kind: "select", cardId: d.cardId, say: d.say, source: "heuristic", reasoning: d.reasoning };
}

export function heuristicBet(state: GameState, rng = Math.random): AiDecision {
  const d = botBet(publicView(state), rng);
  return { kind: "bet", bet: d.bet, say: d.say, source: "heuristic", reasoning: d.reasoning };
}

// ---------- LLM Kazuya ----------

export const SYSTEM_PROMPT = `你是《赌博堕天录 开司·和也篇》中的兵藤和也（Kazuya Hyōdō），正在与开司（人类玩家）对决「ワンポーカー / One Poker」。
人设：帝爱集团会长之子，傲慢、冷酷、厌倦一切，热衷于证明"人性本就丑陋、临阵必会背叛"。台词简短、锋利、居高临下，可夹杂日语口癖（例如「クク……」「ざわ……」）。绝不能在台词里透露自己实际的牌。
你的目标是赢：综合概率、记牌（三副牌、已公开的牌）、下注模式和心理读牌来决策。你的推理是私密的，只有 JSON 里的 "say" 字段会展示给开司。
你必须只输出一个严格的 JSON 对象，不要输出任何其他文字。`;

export const RULES = [
  "牌组：3 副去掉鬼牌的扑克（共 156 张）洗成一摞，开局用切牌卡随机切掉上方一部分（0~30%），被切掉的牌无人知晓、整局不再出现。牌堆用尽时弃牌堆重洗。",
  "手牌：双方各持 2 张。牌分两类：UP = 8,9,10,J,Q,K,A；DOWN = 2,3,4,5,6,7。双方桌前的指示灯公开显示各自手牌中 UP / DOWN 的张数（例如 UP2、UP1+DOWN1、DOWN2），但不显示具体是哪张牌。",
  "出牌：每局双方各从 2 张手牌中选 1 张盖着打出，然后下注，下注结束后同时翻牌比大小。点数大者胜，A 最大、2 最小；唯一例外：2 击败 A。同点数为平局，赌注全部退回。花色无关。",
  "下注：以「命」（人形筹码）为单位。每局双方先各押 1 命作为底注。先手可以 check（过牌）或 raise（加注）；后手可以 check / call（跟注）/ raise / fold（弃牌）。加注后对方必须 call、re-raise 或 fold。call 之后并不直接开牌：被跟注的一方还可以再 raise，或 check 表示不再加注，此时才开牌。双方押注都到上限时直接开牌。本局最高押注 = 双方命数中较少的一方（押到上限即 ALL IN）。fold 会把自己当前已押的命全部输给对方；之后双方打出的牌照样翻开给对方看。",
  "先手：第 1 局随机；之后每局由上一局的赢家先手，平局则保持不变。",
  "局末：打出的牌进入弃牌堆，双方各补 1 张，指示灯随之更新。手里留下的那张牌下一局仍在手中，对方能通过指示灯看到它的 UP/DOWN 类别。",
  "胜负：命数归零者败北（破产）。"
].join("\n");

/** 完整系统提示词 = 人设 + 规则。每次请求完全相同，供应商的前缀缓存靠它命中。 */
export const FULL_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n\n【One Poker 规则】\n${RULES}`;

function lightsIncludingChosen(p: GameState["players"][Side]) {
  const l = lightsOf(p);
  if (p.chosen) (p.chosen.rank >= 8 ? (l.up += 1) : (l.down += 1));
  return l;
}

function describeHistory(state: GameState): unknown[] {
  return state.history.map((r) => ({
    round: r.round,
    firstMover: r.firstMover === AI ? "you" : "Kaiji",
    lightsAtStart: { you: r.lights.ai, kaiji: r.lights.player },
    revealed: {
      you: r.cards.ai ? cardLabel(r.cards.ai) : "hidden",
      kaiji: r.cards.player ? cardLabel(r.cards.player) : "hidden"
    },
    bets: r.actions.map((a) => `${a.side === AI ? "you" : "Kaiji"}:${a.type}${a.type === "raise" ? `->${a.raiseTo}` : ""}`),
    result: r.result === "draw" ? "draw" : r.result === AI ? `you won ${r.livesMoved}` : `Kaiji won ${r.livesMoved}`,
    by: r.reason
  }));
}

function remainingRankCounts(state: GameState): Record<string, number> {
  const pool = unknownPool(publicView(state));
  const counts: Record<string, number> = {};
  for (const r of RANKS) counts[RANK_LABEL[r]] = pool[r];
  return counts;
}

export function buildObservation(state: GameState, kind: DecisionKind): Record<string, unknown> {
  const me = state.players[AI];
  const opp = state.players[HUMAN];
  const oppLights = opp.chosen ? lightsIncludingChosen(opp) : lightsOf(opp);
  const myLights = me.chosen ? lightsIncludingChosen(me) : lightsOf(me);
  const base = {
    round: state.round,
    firstMoverThisRound: state.firstMover === AI ? "you" : "Kaiji",
    lives: { you: me.lives, kaiji: opp.lives },
    maxStakeThisRound: state.maxStake,
    kaijiLights: oppLights,
    yourLightsAsKaijiSeesThem: myLights,
    unknownCardsByRank: remainingRankCounts(state),
    history: describeHistory(state),
  };
  if (kind === "select") {
    return {
      ...base,
      task: "select_card",
      yourHand: me.hand.map((c) => ({
        id: c.id,
        label: cardLabel(c),
        category: category(c),
        estimatedWinProbability: Number(winProbability(state, c).win.toFixed(3))
      })),
      note: "你留下的那张牌下一局会以 UP/DOWN 灯的形式暴露给开司；你现在打出的牌若进入开牌就会公开。estimatedWinProbability 是按开司指示灯与未知牌池估算的胜率，仅供参考。",
      output: {
        reasoning: "<你的私密推理，2～5 句，开司看不到>",
        card: "<yourHand 中的 id>",
        say: "<一句简短的和也台词，不含牌面信息>"
      }
    };
  }
  const legal = legalBets(state, AI);
  const options: string[] = [];
  const lastAction = state.actions[state.actions.length - 1];
  if (legal.canCheck) {
    options.push(lastAction?.type === "call" ? "check (accept Kaiji's call: no more raising, go to showdown)" : "check");
  }
  if (legal.canCall) options.push(`call (costs ${legal.callAmount} more)`);
  if (legal.canRaise) options.push(`raise (raiseTo between ${legal.minRaiseTo} and ${legal.maxRaiseTo})`);
  if (legal.canFold) options.push("fold (lose your current stake)");
  return {
    ...base,
    task: "bet",
    yourPlayedCard: me.chosen ? { label: cardLabel(me.chosen), category: category(me.chosen) } : null,
    yourRemainingHandCard: me.hand.map(cardLabel),
    estimatedWinProbability: me.chosen ? Number(winProbability(state, me.chosen).win.toFixed(3)) : null,
    stakes: { you: me.stake, kaiji: opp.stake },
    bettingSoFarThisRound: state.actions.map((a) => `${a.side === AI ? "you" : "Kaiji"}:${a.type}${a.type === "raise" ? `->${a.raiseTo}` : ""}`),
    legalActions: options,
    output: {
      reasoning: "<你的私密推理，2～5 句，开司看不到>",
      action: "check|call|raise|fold",
      raiseTo: "<整数，仅 raise 时需要>",
      say: "<一句简短的和也台词>"
    }
  };
}

export function buildUserPrompt(observation: Record<string, unknown>): string {
  return `【当前局面（JSON）】\n${JSON.stringify(observation, null, 1)}\n\n请严格按 "output" 的格式只回复一个 JSON 对象，字段顺序保持 reasoning 在前。`;
}

export async function decide(
  state: GameState,
  kind: DecisionKind,
  config: ProviderConfig,
  observer?: TraceObserver,
  rng = Math.random
): Promise<AiDecision> {
  const fallback = () => (kind === "select" ? heuristicSelect(state, rng) : heuristicBet(state, rng));
  const name = providerDisplayName(config);
  const trace: AiTrace = {
    id: ++traceSeq,
    round: state.round,
    kind,
    providerId: config.presetId,
    providerLabel: name.label,
    model: name.model,
    status: "thinking",
    startedAt: Date.now(),
    system: FULL_SYSTEM_PROMPT,
    user: "",
    reasoning: "",
    output: "",
    attempt: 1
  };
  const notify = () => observer?.(trace);

  if (config.kind === "heuristic") {
    const fb = fallback();
    trace.status = "heuristic";
    trace.endedAt = Date.now();
    trace.reasoning = fb.reasoning ?? "";
    trace.summary = describeDecision(state, fb);
    notify();
    return fb;
  }

  const observation = buildObservation(state, kind);
  const user = buildUserPrompt(observation);
  trace.user = user;
  notify();
  try {
    const call = async (userText: string) => {
      const result = await callProvider(config, { system: FULL_SYSTEM_PROMPT, user: userText }, (delta) => {
        if (delta.reasoning) trace.reasoning += delta.reasoning;
        if (delta.text) trace.output += delta.text;
        if (delta.usage) trace.usage = { ...trace.usage, ...delta.usage };
        notify();
      });
      trace.finishReason = result.finishReason;
      notify();
      return result;
    };
    let result = await call(user);
    let parsed = extractJson(result.text);
    if (!parsed) {
      // 常见原因：模型输出到达了它自己的长度上限，正文被截断；或模型输出了闲聊。
      // 追加一句明确要求，只重试一次。
      const why = result.finishReason === "length" ? "输出被长度上限截断" : "模型没有返回 JSON";
      trace.attempt = 2;
      trace.reasoning = trace.reasoning ? `${trace.reasoning}\n\n—— 第一次${why}，重试 ——\n\n` : "";
      trace.output = "";
      notify();
      result = await call(`${user}\n\n（上一次你${why}。这次请把推理压缩到 3 句以内，直接输出 JSON。）`);
      parsed = extractJson(result.text);
      if (!parsed) throw new Error(result.finishReason === "length" ? "输出两次都被长度上限截断。" : "模型两次都没有返回 JSON。");
    }
    const raw = result.text;
    if (typeof parsed.reasoning === "string" && parsed.reasoning.trim()) {
      trace.reasoning = [trace.reasoning.trim(), parsed.reasoning.trim()].filter(Boolean).join("\n\n");
    }
    const say = typeof parsed.say === "string" && parsed.say.trim() ? parsed.say.trim().slice(0, 200) : "……";
    let decision: AiDecision;
    if (kind === "select") {
      const hand = state.players[AI].hand;
      const wanted = String(parsed.card ?? parsed.cardId ?? "").trim().toUpperCase();
      const match =
        hand.find((c) => c.id.toUpperCase() === wanted) ??
        hand.find((c) => cardLabel(c).toUpperCase() === wanted) ??
        hand.find((c) => wanted.startsWith(RANK_LABEL[c.rank]) && wanted.includes(c.suit));
      if (!match) throw new Error(`模型选择了不存在的牌 "${wanted}"。`);
      decision = { kind, cardId: match.id, say, source: "llm", raw };
    } else {
      const legal = legalBets(state, AI);
      const action = String(parsed.action ?? "").toLowerCase().trim();
      let bet: BetInput;
      if (action === "raise" && legal.canRaise) {
        const to = Math.round(Number(parsed.raiseTo ?? parsed.raise_to ?? legal.minRaiseTo));
        bet = { type: "raise", raiseTo: Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Number.isFinite(to) ? to : legal.minRaiseTo)) };
      } else if (action === "raise" && !legal.canRaise) {
        bet = legal.canCall ? { type: "call" } : { type: "check" };
      } else if (action === "call") {
        bet = legal.canCall ? { type: "call" } : { type: "check" };
      } else if (action === "check") {
        bet = legal.canCheck ? { type: "check" } : { type: "call" };
      } else if (action === "fold") {
        bet = legal.canFold ? { type: "fold" } : { type: "check" };
      } else {
        throw new Error(`模型返回了未知动作 "${action}"。`);
      }
      decision = { kind, bet, say, source: "llm", raw };
    }
    trace.status = "ok";
    trace.endedAt = Date.now();
    trace.summary = describeDecision(state, decision);
    notify();
    return decision;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fb = fallback();
    trace.status = "fallback";
    trace.error = message;
    trace.endedAt = Date.now();
    if (fb.reasoning) trace.reasoning = [trace.reasoning.trim(), `—— 内置机器人接手 ——\n${fb.reasoning}`].filter(Boolean).join("\n\n");
    trace.summary = `（回退内置机器人）${describeDecision(state, fb)}`;
    notify();
    return { ...fb, error: message, raw: trace.output };
  }
}

function describeDecision(state: GameState, d: AiDecision): string {
  if (d.kind === "select") {
    const card = state.players[AI].hand.find((c) => c.id === d.cardId);
    return `打出 ${card ? cardLabel(card) : d.cardId} · 「${d.say}」`;
  }
  const b = d.bet!;
  const label =
    b.type === "raise" ? `加注至 ${b.raiseTo}` : b.type === "call" ? "跟注" : b.type === "check" ? "过牌" : "弃牌";
  return `${label} · 「${d.say}」`;
}

export async function testConnection(config: ProviderConfig): Promise<string> {
  const { text: raw } = await callProvider(config, {
    system: "Return only strict JSON.",
    user: '只回复这个 JSON：{"ok": true, "say": "ワンポーカー、準備完了"}',
    maxTokens: 200
  });
  const parsed = extractJson(raw);
  if (!parsed) throw new Error(`回复不是 JSON：${raw.slice(0, 120)}`);
  return String(parsed.say ?? "ok");
}
