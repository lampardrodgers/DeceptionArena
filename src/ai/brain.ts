import { type Card, cardLabel, category, compareCards, createDeck, isUp, RANK_LABEL } from "../game/cards.js";
import {
  type BetInput,
  type GameState,
  type Side,
  legalBets,
  lightsOf,
  revealedCards
} from "../game/engine.js";
import { callProvider, extractJson, type ProviderConfig } from "./providers.js";

export type DecisionKind = "select" | "bet";

export interface AiDecision {
  kind: DecisionKind;
  cardId?: string;
  bet?: BetInput;
  say: string;
  source: "llm" | "heuristic";
  error?: string;
  raw?: string;
}

const AI: Side = "ai";
const HUMAN: Side = "player";

// ---------- probability model ----------

/** Cards not known to the AI: everything except its own cards and publicly revealed cards. */
function unknownCards(state: GameState): Card[] {
  const known = new Set<string>();
  const me = state.players[AI];
  for (const c of me.hand) known.add(c.id);
  if (me.chosen) known.add(me.chosen.id);
  for (const c of revealedCards(state)) known.add(c.id);
  return createDeck().filter((c) => !known.has(c.id));
}

/**
 * Probability that `mine` beats the opponent's played card, given the opponent's lights.
 * Model: the opponent plays an UP card with probability up/(up+down) and, within a category,
 * every unknown card of that category is equally likely.
 */
export function winProbability(state: GameState, mine: Card): { win: number; lose: number; draw: number } {
  const opp = state.players[HUMAN];
  const lights = opp.chosen ? lightsIncludingChosen(opp) : lightsOf(opp);
  const pool = unknownCards(state);
  const ups = pool.filter(isUp);
  const downs = pool.filter((c) => !isUp(c));
  const total = lights.up + lights.down || 1;
  const pUp = lights.up / total;
  const pDown = lights.down / total;
  const stat = (cards: Card[]) => {
    if (!cards.length) return { win: 0, lose: 0, draw: 0 };
    let w = 0;
    let l = 0;
    let d = 0;
    for (const c of cards) {
      const r = compareCards(mine, c);
      if (r > 0) w += 1;
      else if (r < 0) l += 1;
      else d += 1;
    }
    return { win: w / cards.length, lose: l / cards.length, draw: d / cards.length };
  };
  const u = stat(ups);
  const dn = stat(downs);
  return {
    win: pUp * u.win + pDown * dn.win,
    lose: pUp * u.lose + pDown * dn.lose,
    draw: pUp * u.draw + pDown * dn.draw
  };
}

function lightsIncludingChosen(p: GameState["players"][Side]) {
  const cards = p.chosen ? [p.chosen, ...p.hand] : p.hand;
  let up = 0;
  let down = 0;
  for (const c of cards) (isUp(c) ? (up += 1) : (down += 1));
  return { up, down };
}

// ---------- heuristic Kazuya ----------

export function heuristicSelect(state: GameState, rng = Math.random): AiDecision {
  const hand = state.players[AI].hand;
  const scored = hand.map((c) => ({ c, p: winProbability(state, c) }));
  scored.sort((a, b) => b.p.win - a.p.win || a.c.rank - b.c.rank);
  // Mostly pick the best card; occasionally keep the strong card for later.
  const pick = scored.length > 1 && rng() < 0.15 && scored[1].p.win > 0.35 ? scored[1] : scored[0];
  return {
    kind: "select",
    cardId: pick.c.id,
    say: pick.p.win > 0.7 ? "クク……置いたぞ。" : "さあ、始めようか。",
    source: "heuristic"
  };
}

export function heuristicBet(state: GameState, rng = Math.random): AiDecision {
  const me = state.players[AI];
  const legal = legalBets(state, AI);
  const p = winProbability(state, me.chosen!).win;
  const bluff = rng() < 0.12;
  let bet: BetInput;
  let say = "";
  if (legal.canRaise && (p > 0.72 || (bluff && p > 0.3))) {
    const span = legal.maxRaiseTo - legal.minRaiseTo;
    const strength = Math.max(0, Math.min(1, (p - 0.6) / 0.4));
    const raiseTo = p > 0.95 ? legal.maxRaiseTo : legal.minRaiseTo + Math.round(span * strength * rng());
    bet = { type: "raise", raiseTo };
    say = raiseTo === legal.maxRaiseTo ? "全部だ……オールイン！" : `レイズ。${raiseTo} 命だ。`;
  } else if (legal.canCall) {
    const pot = legal.callAmount;
    const needed = pot / (pot + me.stake + state.players[HUMAN].stake);
    if (p >= needed + 0.05 || (p >= 0.4 && legal.callAmount <= 1)) {
      bet = { type: "call" };
      say = "コール。見せてもらおうか、お前の牌を。";
    } else {
      bet = { type: "fold" };
      say = "……つまらん。降りる。";
    }
  } else {
    bet = { type: "check" };
    say = "チェック。";
  }
  return { kind: "bet", bet, say, source: "heuristic" };
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
  "下注：以「命」（人形筹码）为单位。每局双方先各押 1 命作为底注。先手可以 check（过牌）或 raise（加注）；后手可以 check / call（跟注）/ raise / fold（弃牌）。加注后对方必须 call、re-raise 或 fold。本局最高押注 = 双方命数中较少的一方（押到上限即 ALL IN）。fold 会把自己当前已押的命全部输给对方；之后双方打出的牌照样翻开给对方看。",
  "先手：第 1 局随机；之后每局由上一局的赢家先手，平局则保持不变。",
  "局末：打出的牌进入弃牌堆，双方各补 1 张，指示灯随之更新。手里留下的那张牌下一局仍在手中，对方能通过指示灯看到它的 UP/DOWN 类别。",
  "胜负：命数归零者败北（破产）。"
].join("\n");

function describeHistory(state: GameState): unknown[] {
  return state.history.slice(-12).map((r) => ({
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
  const counts: Record<string, number> = {};
  for (const c of unknownCards(state)) {
    const label = RANK_LABEL[c.rank];
    counts[label] = (counts[label] ?? 0) + 1;
  }
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
    historyRecent: describeHistory(state)
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
      output: { card: "<yourHand 中的 id>", say: "<一句简短的和也台词，不含牌面信息>" }
    };
  }
  const legal = legalBets(state, AI);
  const options: string[] = [];
  if (legal.canCheck) options.push("check");
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
    output: { action: "check|call|raise|fold", raiseTo: "<整数，仅 raise 时需要>", say: "<一句简短的和也台词>" }
  };
}

export function buildUserPrompt(observation: Record<string, unknown>): string {
  return `【One Poker 规则】\n${RULES}\n\n【当前局面（JSON）】\n${JSON.stringify(observation, null, 1)}\n\n请严格按 "output" 的格式只回复一个 JSON 对象。`;
}

export async function decide(
  state: GameState,
  kind: DecisionKind,
  config: ProviderConfig,
  rng = Math.random
): Promise<AiDecision> {
  const fallback = () => (kind === "select" ? heuristicSelect(state, rng) : heuristicBet(state, rng));
  if (config.kind === "heuristic") return fallback();

  const observation = buildObservation(state, kind);
  const user = buildUserPrompt(observation);
  let raw = "";
  try {
    raw = await callProvider(config, { system: SYSTEM_PROMPT, user, maxTokens: 700 });
    const parsed = extractJson(raw);
    if (!parsed) throw new Error("Model returned no JSON.");
    const say = typeof parsed.say === "string" && parsed.say.trim() ? parsed.say.trim().slice(0, 200) : "……";
    if (kind === "select") {
      const hand = state.players[AI].hand;
      const wanted = String(parsed.card ?? parsed.cardId ?? "").trim().toUpperCase();
      const match =
        hand.find((c) => c.id.toUpperCase() === wanted) ??
        hand.find((c) => cardLabel(c).toUpperCase() === wanted) ??
        hand.find((c) => wanted.startsWith(RANK_LABEL[c.rank]) && wanted.includes(c.suit));
      if (!match) throw new Error(`Model chose unknown card "${wanted}".`);
      return { kind, cardId: match.id, say, source: "llm", raw };
    }
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
      throw new Error(`Model returned unknown action "${action}".`);
    }
    return { kind, bet, say, source: "llm", raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fb = fallback();
    return { ...fb, error: message, raw };
  }
}

export async function testConnection(config: ProviderConfig): Promise<string> {
  const raw = await callProvider(config, {
    system: "Return only strict JSON.",
    user: '只回复这个 JSON：{"ok": true, "say": "ワンポーカー、準備完了"}',
    maxTokens: 60
  });
  const parsed = extractJson(raw);
  if (!parsed) throw new Error(`Unexpected reply: ${raw.slice(0, 120)}`);
  return String(parsed.say ?? "ok");
}
