/**
 * 内置算法机器人（不用大模型的和也）。
 *
 * 只使用公开信息决策：自己的手牌、双方指示灯、本局下注过程、历史开牌记录、
 * 弃牌堆（所有打出的牌都翻开过）、牌堆重洗的时刻。绝不读取开司的手牌、牌堆顺序或被切掉的牌。
 *
 * 决策分三层，分别在三个模块里：
 *  1. 记牌 + 读牌：`analysis.ts`。当前牌靴减去已翻开的牌和自己的牌 = 未知牌池；
 *     对开司「留在手里那张牌」做贝叶斯滤波，再结合本局下注行为修正他打出的牌的分布。
 *  2. 对手建模：`opponentModel.ts`。选牌偏好与下注偏好全部从对局历史中统计
 *     （带先验、随时间衰减的 Beta / Dirichlet 计数），越打越了解对手。
 *  3. 算账：`solver.ts`。在本局的下注子博弈上跑 CFR+ / Restricted Nash Response，
 *     解出的是**整条范围的混合策略**而不是单张牌的最优动作，所以同一个额度里既有价值牌也有诈唬牌。
 *     `bettingTree.ts` 退居二线，只负责终局估值（`makeVal`：把命数变化折成「赢下整场的概率」，
 *     并计入留牌对下一局的增益），所以领先时不为微小优势梭哈、落后时敢搏。
 *
 * 本文件只保留决策入口（选牌 / 下注）、台词与人类可读的推理文本，并 re-export 全部公开 API。
 */
import { type Card, cardLabel, RANK_LABEL, type Rng } from "../game/cards.js";
import { type BetInput, type Lights } from "../game/engine.js";
import {
  type Analysis,
  type BotView,
  AI,
  PARAMS,
  RANKS,
  analyze,
  cmpRank,
  perceivedRange,
  uWithEdge,
  unitUtility,
  unknownPool,
  u,
  zeros
} from "./analysis.js";
import { type Beta, type Bin5, type OppModel, rate } from "./opponentModel.js";
import { type FutureCache, makeVal, outcomes } from "./bettingTree.js";
import { type SolveInput, type Solved, type SolvedAction, SOLVER_PARAMS, solve } from "./solver.js";

// 兼容旧的 import 路径：外部代码只从 ./bot.js 取这些 API。
export {
  PARAMS,
  RANKS,
  analyze,
  cmpRank,
  matchWinProb,
  perceivedWin,
  publicView,
  unknownAnywhere,
  unknownPool
} from "./analysis.js";
export type { Analysis, BotView, Cat, Ctx } from "./analysis.js";
export {
  MODEL_PARAMS,
  aggCtxOf,
  aggressionProb,
  betaN,
  bin5Of,
  contextConfidence,
  foldProb,
  learnOpponent,
  opponentConfidence,
  rate,
  reraiseProb,
  sizeBucketOf,
  sizeProb
} from "./opponentModel.js";
export type { AggCtx, Beta, Bin, Bin5, BySize, ConfSpot, OppModel, OppStats, SizeBucket } from "./opponentModel.js";
export { SOLVER_PARAMS, solve } from "./solver.js";
export type { SolveInput, Solved, SolvedAction } from "./solver.js";

/** 动作选择的 softmax 温度（单位：命，按当前效用斜率换算）。 */
const TEMP = 0.2;
/** 只在与最优动作 EV 相差不超过此值（单位：命）的动作之间随机。 */
const MIX_MARGIN = 0.35;

// ---------- 台词 ----------

/**
 * 台词池。**同一个动作只有一个池**：说什么绝不能取决于牌力，否则「クク……」这类得意台词
 * 就成了免费的读牌线索（选牌台词尤其致命——牌还没翻开）。
 * 位置（先手 / 后手）和加注额度本来就是公开信息，可以分池。
 */
const LINES = {
  select: [
    "クク……置いたぞ。",
    "さあ、始めようか。",
    "……出せ。お前の牌を。",
    "フン……好きに読め。",
    "早く決めろ、カイジ。",
    "……この一枚で十分だ。",
    "ククク……賭けてみるか？",
    "ざわ……さあ、乗ってこい。"
  ],
  checkOpen: ["チェック。", "……様子見だ。", "急ぐ必要はない。チェック。"],
  checkClose: ["……開けろ。", "ここまでだ。開牌。", "見せてもらおう、お前の牌を。"],
  call: ["コール。見せてもらおうか、お前の牌を。", "……乗ってやる。コール。", "コール。逃げはしない。"],
  raise: (n: number) => [
    `レイズ。${n} 命だ。`,
    `……${n} 命。降りるなら今だぞ。`,
    `${n} 命……付いてこれるか？`,
    `${n} 命。お前の覚悟を見せてみろ。`,
    `クク……${n} 命だ。`,
    `ざわ……${n} 命だ。`
  ],
  allIn: ["全部だ……オールイン！", "ククク……全部賭けてやる。オールイン！", "ここで終わりだ。オールイン！"],
  fold: ["……つまらん。降りる。", "フン……この牌は捨てる。", "……興が削がれた。降りる。"]
};

function pickLine(lines: string[], rng: Rng): string {
  return lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))];
}

// ---------- 决策 ----------

export interface BotDecision {
  kind: "select" | "bet";
  cardId?: string;
  bet?: BetInput;
  say: string;
  /** 人类可读的推理过程，展示在「AI 思考记录」里。 */
  reasoning: string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
/** 把效用换算成「相当于多少命」，便于阅读。 */
const inLives = (ev: number, unit: number) => signed(ev / unit);
const betaText = (x: Beta) => `${pct(rate(x))}`;

function distText(d: number[], max = 7): string {
  const items = RANKS.filter((r) => d[r] > 0.005)
    .sort((a, b) => d[b] - d[a])
    .slice(0, max)
    .map((r) => `${RANK_LABEL[r]} ${pct(d[r])}`);
  return items.join(" · ") || "（无）";
}

function lightsText(l: Lights): string {
  return l.up === 2 ? "UP2" : l.down === 2 ? "DOWN2" : "UP1+DOWN1";
}

/** 把按胜率分的 5 档写成一行。 */
const binsText = (r: Record<Bin5, Beta>) =>
  `${betaText(r.vweak)}/${betaText(r.weak)}/${betaText(r.mid)}/${betaText(r.strong)}/${betaText(r.vstrong)}`;

function modelText(m: OppModel): string {
  const pd = m.playDownWhenMixed;
  const sz = m.raiseSize.mid;
  const szTotal = sz[0] + sz[1] + sz[2];
  return [
    `【对手模型】已观察 ${m.rounds} 局（越近的局权重越高）；有效样本 ${m.nEff.toFixed(1)}，快记忆权重 ${pct(m.wFast)}，稳定度 ${pct(m.stability)}，可信度 ${pct(m.confidence)}。`,
    `持 UP+DOWN 时出 DOWN：我灯 UP2 ${betaText(pd.UP2)} · 混合 ${betaText(pd.MIX)} · DOWN2 ${betaText(pd.DOWN2)}；同类牌先出强牌 ${betaText(m.playStrongerSameCat)}（${m.pairSamples} 个样本）。`,
    `下注倾向（按他自认胜率 <20%/<40%/<60%/<80%/≥80% 分档）：先手开局加注 ${binsText(m.agg.openFirst)}；我过牌后偷注 ${binsText(m.agg.stabAfterBotCheck)}；被跟注后连续开火 ${binsText(m.agg.barrel)}。`,
    `面对加注弃牌 ${binsText(m.foldToRaise)}；再加注 ${binsText(m.reraise)}；加注额度小/中/大 ${pct(sz[0] / szTotal)}/${pct(sz[1] / szTotal)}/${pct(sz[2] / szTotal)}，平均幅度约 ${pct(m.raiseFrac.sum / m.raiseFrac.n)}。`
  ].join("\n");
}

function poolText(view: BotView, A: Analysis): string {
  let n = 0;
  for (const r of RANKS) n += A.pool[r];
  const shoe = view.reshuffles.length ? `第 ${view.reshuffles[view.reshuffles.length - 1]} 局重洗后的牌靴` : "原始牌靴";
  const counts = RANKS.map((r) => `${RANK_LABEL[r]}×${A.pool[r]}`).join(" ");
  return `【记牌】${shoe}，牌堆里未知牌 ${n} 张：${counts}。`;
}

function handText(view: BotView, A: Analysis): string {
  const L = view.lights.player;
  const heldNote = A.heldSince < view.round ? `一张自第 ${A.heldSince} 局起留手（${A.heldCat}，推断：${distText(A.held, 5)}），新牌 ${A.newCat}` : `两张都是新牌（${A.heldCat} + ${A.newCat}）`;
  return `【开司手牌】灯 ${lightsText(L)}：${heldNote}。本局出牌分布：${distText(A.played)}。`;
}

/** 带温度的随机选择：只在接近最优的几个候选之间抽。unit = 1 命对应的效用。 */
function softmaxPick<T extends { ev: number }>(cands: T[], rng: Rng, unit: number, temp = TEMP, margin = MIX_MARGIN, keep = 4): T {
  const sorted = cands.slice().sort((a, b) => b.ev - a.ev);
  const best = sorted[0].ev;
  const near = sorted.filter((c) => c.ev >= best - margin * unit).slice(0, keep);
  const weights = near.map((c) => Math.exp((c.ev - best) / (temp * unit)));
  const total = weights.reduce((s, w) => s + w, 0);
  let x = rng() * total;
  for (let i = 0; i < near.length; i += 1) {
    x -= weights[i];
    if (x <= 0) return near[i];
  }
  return near[near.length - 1];
}

// ---------- 求解器接口 ----------

/**
 * 组装一次求解的输入。
 *
 * `myPrior` 是**开司眼中我打出的那张牌**的分布：按我方指示灯的 UP/DOWN 比例加权，
 * 类内再按他看得到的牌池分配（和 `perceivedWin` 用的是同一套视角）。这是求解器与旧下注树
 * 最本质的区别 —— 旧树只问「我这张牌该怎么打」，求解器解的是「我这条范围整体该怎么打」。
 *
 * RNR 权重 `p` 直接取对手模型的置信度：越了解对手越敢按模型剥削，样本不足时退回纳什。
 */
function solveInput(view: BotView, A: Analysis, val: (d: number) => number): SolveInput {
  const LMe = view.lives.ai;
  const LOpp = view.lives.player;
  return {
    myPrior: perceivedRange(view.lights.ai, A.theirs),
    oppPrior: A.played,
    q: A.q,
    model: A.model,
    p: A.model.confidence,
    M: view.maxStake,
    meFirst: view.firstMover === AI,
    LOpp,
    // 求解器现在是严格零和（开司效用 = −我方效用），风险态度由求解专用的 `PARAMS.solveEdge` 给：
    // 把 `makeVal` 里的本局效用项换成 solveEdge 版本，留牌的下一局增益仍沿用 matchEdge
    //（Stage C 会把它一并改成按点数分档的范围估值，那时 `val` 的第一个参数才真正用起来）。
    val: solveVal(val, LMe, LMe + LOpp),
    valOpp: oppVal(LOpp, LMe + LOpp),
    edge: PARAMS.solveEdge,
    actions: view.actions
  };
}

/**
 * 开司复制体自己的效用曲线（一般和求解）：`PARAMS.oppEdge > 0` 时按他的命数与该风险态度取凹曲线，
 * 0 则回到严格零和（返回 undefined）。
 */
function oppVal(LOpp: number, T: number): ((dOpp: number) => number) | undefined {
  const edge = PARAMS.oppEdge;
  if (!(edge > 0)) return undefined;
  return (dOpp) => uWithEdge(dOpp, LOpp, T, edge);
}

/** 把「本局命数变化 → 效用」的曲率从 matchEdge 换成 solveEdge；两者相等时是逐位的恒等变换。 */
function solveVal(val: (d: number) => number, LMe: number, T: number): (rank: number, d: number) => number {
  const edge = PARAMS.solveEdge;
  if (edge === PARAMS.matchEdge) return (_rank, d) => val(d);
  return (_rank, d) => val(d) - u(d, LMe, T) + uWithEdge(d, LMe, T, edge);
}

/**
 * 同一个局面在一次决策里可能被问到两次（比如展示用的重算），这里做个极小的记忆化。
 * 树的形状取决于本局已发生的动作，所以键里必须带上完整的动作序列；跨局面不可复用。
 */
let memoKey = "";
let memoSol: Solved | null = null;

function solveRound(tag: string, view: BotView, A: Analysis, val: (d: number) => number): Solved {
  const acts = view.actions.map((a) => `${a.side[0]}${a.type[0]}${a.raiseTo ?? ""}`).join("");
  const key = [
    tag,
    view.round,
    view.lives.ai,
    view.lives.player,
    view.stakes.ai,
    view.stakes.player,
    view.maxStake,
    view.chosen?.rank ?? 0,
    // 留在手里的牌决定终局估值（下一局增益），必须进键：否则新一局若开局签名相同会拿到上一局的解。
    view.hand.map((c) => c.rank).join(","),
    view.lights.ai.up,
    view.lights.player.up,
    view.history.length,
    acts
  ].join("|");
  if (key === memoKey && memoSol) return memoSol;
  memoSol = solve(solveInput(view, A, val));
  memoKey = key;
  return memoSol;
}

/** 动作的中文标签。 */
function actLabel(a: SolvedAction, M: number): string {
  if (a.type === "check") return "过牌";
  if (a.type === "call") return "跟注";
  if (a.type === "fold") return "弃牌";
  return a.raiseTo === M ? `全下 ${M}` : `加注至 ${a.raiseTo}`;
}

/** 把某个点数在节点 n 上的平均策略写成一行（只留前几项）。 */
function stratText(sol: Solved, n: number, rank: number, M: number, max = 3): string {
  const acts = sol.actionsOf(n);
  const st = sol.strategyAt(n, rank);
  const items = acts
    .map((a, i) => ({ a, p: st[i] }))
    .filter((x) => x.p >= SOLVER_PARAMS.displayPrune)
    .sort((x, y) => y.p - x.p)
    .slice(0, max)
    .map((x) => `${actLabel(x.a, M)} ${pct(x.p)}`);
  return items.join("/") || "—";
}

/**
 * 从平均策略里抽一个动作。
 *
 * 先剔掉概率低于 `SOLVER_PARAMS.executionPrune` 的噪声动作再归一化，然后**按概率从大到小**排序后抽样：
 * 这样 `rng = () => 0` 就等于「取最可能的动作」，测试和复盘都能拿到确定性的结果。
 */
function pickAction(idx: number[], strat: number[], rng: Rng): { pick: number; probs: Map<number, number> } {
  let pool = idx.map((i) => ({ i, p: strat[i] })).filter((x) => x.p >= SOLVER_PARAMS.executionPrune);
  if (pool.length === 0) pool = idx.map((i) => ({ i, p: strat[i] }));
  const total = pool.reduce((a, x) => a + x.p, 0);
  if (total > 0) for (const x of pool) x.p /= total;
  else for (const x of pool) x.p = 1 / pool.length;
  pool.sort((a, b) => b.p - a.p);
  const probs = new Map<number, number>(pool.map((x) => [x.i, x.p]));
  let r = rng();
  for (const x of pool) {
    r -= x.p;
    if (r <= 0) return { pick: x.i, probs };
  }
  return { pick: pool[pool.length - 1].i, probs };
}

export function botSelect(view: BotView, rng: Rng = Math.random): BotDecision {
  const A = analyze(view);
  const hand = view.hand;
  if (hand.length === 1) {
    return { kind: "select", cardId: hand[0].id, say: pickLine(LINES.select, rng), reasoning: "只剩一张牌，没有选择。" };
  }
  const iAmFirst = view.firstMover === AI;
  const M = view.maxStake;
  const LMe = view.lives.ai;
  const LOpp = view.lives.player;
  const T = LMe + LOpp;
  const unit = unitUtility(LMe, T);
  const lines: string[] = [
    modelText(A.model),
    poolText(view, A),
    handText(view, A),
    `【我方候选】先手：${iAmFirst ? "我" : "开司"}，本局上限 ${M} 命（EV 以命计，已按整场胜率折算；留牌增益按本局各种结局分别估算，输光则没有下一局）。`
  ];
  // 两张候选各求解一次：留牌的下一局价值会改变终局估值，进而改变整条范围的打法，
  // 所以不能「解一次再补一项」。`FutureCache` 在两次之间共享，重算的只是 CFR 迭代本身。
  const cache: FutureCache = new Map();
  // 与求解用的 `val` 同一条曲线（solveEdge），这样「合计 − 本局 = 留牌增益」才是同一把尺子。
  const valNow = (_rank: number, d: number) => uWithEdge(d, LMe, T, PARAMS.solveEdge);
  const cands = hand.map((card, i) => {
    const keep = hand[1 - i];
    const sol = solveRound(`sel${i}`, view, A, makeVal(view, A, keep, cache));
    const ev = sol.rootValue(card.rank);
    // 同一套策略换一套终局估值再走一遍，就能把「留牌增益」单独摘出来给人看。
    const evNow = sol.evaluate(valNow)(card.rank);
    const o = zeros();
    for (const c of RANKS) o[c] = cmpRank(card.rank, c);
    const oc = outcomes(A.played, o);
    lines.push(
      `${cardLabel(card)}：本局胜 ${pct(oc.win)} / 平 ${pct(oc.draw)} / 负 ${pct(oc.lose)} → 本局 EV ${inLives(evNow, unit)} 命；留 ${cardLabel(keep)} 对下一局的增益 ${inLives(ev - evNow, unit)} → 合计 ${inLives(ev, unit)}；范围策略下我打 ${cardLabel(card)} 的开局动作：${stratText(sol, sol.cur, card.rank, M)}`
    );
    return { card, keep, ev, win: oc.win, sol };
  });
  const pick = softmaxPick(cands, rng, unit, TEMP, 0.25, 2);
  lines.push(
    `【范围策略】开司照模型出牌的权重 p=${pct(A.model.confidence)}（剩下的按纳什求解）；树 ${pick.sol.nodeCount} 节点 × ${pick.sol.iters} 次 CFR+ 迭代。`,
    `【决定】打出 ${cardLabel(pick.card)}，留 ${cardLabel(pick.keep)}。`
  );
  const say = pickLine(LINES.select, rng);
  return { kind: "select", cardId: pick.card.id, say, reasoning: lines.join("\n") };
}

export function botBet(view: BotView, rng: Rng = Math.random): BotDecision {
  const A = analyze(view);
  const mine = view.chosen;
  if (!mine) throw new Error("和也尚未出牌。");
  const legal = view.legal;
  const keep = view.hand[0] ?? null;
  const M = view.maxStake;
  const sMe = view.stakes.ai;
  const sOpp = view.stakes.player;
  const unit = unitUtility(view.lives.ai, view.lives.ai + view.lives.player);
  const D = A.posterior;
  const o = zeros();
  for (const c of RANKS) o[c] = cmpRank(mine.rank, c);
  const oc = outcomes(D, o);
  const opening = view.actions.length === 0;

  const sol = solveRound("bet", view, A, makeVal(view, A, keep, new Map()));
  // 求解器的动作集来自引擎的状态机，正常情况下和 `legal` 完全一致；
  // 这里再筛一道纯属兜底 —— 机器人绝不能返回非法动作。
  const isLegal = (a: SolvedAction) =>
    a.type === "check"
      ? legal.canCheck
      : a.type === "call"
        ? legal.canCall
        : a.type === "fold"
          ? legal.canFold
          : legal.canRaise && a.raiseTo! >= legal.minRaiseTo && a.raiseTo! <= legal.maxRaiseTo;
  const acts = sol.kindOf(sol.cur) === 0 ? sol.actionsOf(sol.cur) : [];
  const idx = acts.map((_, i) => i).filter((i) => isLegal(acts[i]));
  const strat = idx.length > 0 ? sol.strategyAt(sol.cur, mine.rank) : [];
  const chosen = idx.length > 0 ? pickAction(idx, strat, rng) : null;
  const bet: BetInput = chosen
    ? acts[chosen.pick].type === "raise"
      ? { type: "raise", raiseTo: acts[chosen.pick].raiseTo! }
      : { type: acts[chosen.pick].type as "check" | "call" | "fold" }
    : legal.canCheck
      ? { type: "check" }
      : legal.canCall
        ? { type: "call" }
        : { type: "fold" };

  /** 开司在我打出某个动作之后的弃牌率（按他本局的出牌后验加权，供展示）。 */
  const foldRate = (kid: number): number | undefined => {
    if (sol.kindOf(kid) !== 1) return undefined;
    const a2 = sol.actionsOf(kid);
    const fi = a2.findIndex((x) => x.type === "fold");
    if (fi < 0) return undefined;
    let s = 0;
    let tot = 0;
    for (const c of RANKS) {
      const w = D[c];
      if (!w) continue;
      tot += w;
      s += w * sol.strategyAt(kid, c)[fi];
    }
    return tot > 0 ? s / tot : undefined;
  };

  const actionText = idx
    .map((i) => ({ i, ev: sol.actionValue(sol.cur, i, mine.rank) }))
    .sort((a, b) => b.ev - a.ev)
    .slice(0, 6)
    .map(({ i, ev }) => {
      const f = foldRate(sol.childOf(sol.cur, i));
      return `${actLabel(acts[i], M)} ${inLives(ev, unit)}${f != null ? `（弃牌率 ${pct(f)}）` : ""}`;
    })
    .join("；");

  // 范围里权重最高的几个点数各自怎么打 —— 看得出「同一个额度里既有价值牌也有诈唬牌」。
  const range = sol.rangeAt(sol.cur);
  const byRange = RANKS.filter((c) => range[c] > 0.02)
    .sort((a, b) => range[b] - range[a])
    .slice(0, 5)
    .map((c) => `${RANK_LABEL[c]} ${stratText(sol, sol.cur, c, M, 2)}`)
    .join("；");

  const actsText = view.actions.map((a) => `${a.side === AI ? "我" : "开司"} ${a.type}${a.type === "raise" ? `→${a.raiseTo}` : ""}`).join("，") || "无";
  const lines = [
    modelText(A.model),
    `【局面】我打出 ${cardLabel(mine)}（我灯 ${lightsText(view.lights.ai)}），开司灯 ${lightsText(view.lights.player)}，先手 ${view.firstMover === AI ? "我" : "开司"}；押注 我 ${sMe} / 开司 ${sOpp}，上限 ${M}；本局动作：${actsText}。${keep ? `手里还留着 ${cardLabel(keep)}，它对下一局的增益已按各种结局计入。` : ""}`,
    poolText(view, A),
    handText(view, A),
    `【开司出牌分布】按其本局下注修正后：${distText(D)}。我方胜 ${pct(oc.win)} / 平 ${pct(oc.draw)} / 负 ${pct(oc.lose)}。`,
    `【范围策略】开司照模型出牌的权重 p=${pct(A.model.confidence)}（剩下的按纳什求解）；树 ${sol.nodeCount} 节点 × ${sol.iters} 次 CFR+ 迭代。`,
    `　我方 ${cardLabel(mine)} 的动作分布：${stratText(sol, sol.cur, mine.rank, M, 4)}。范围里其他点数：${byRange || "—"}。`,
    `【动作评估】（含后续加注 / 再加注的推演）${actionText}。`,
    `【开司眼中我方范围】本动作前：${distText(range)}${chosen ? `；打出「${actLabel(acts[chosen.pick], M)}」之后：${distText(sol.rangeAfter(sol.cur, chosen.pick))}` : ""}。`,
    `【决定】${chosen ? actLabel(acts[chosen.pick], M) : "（兜底）"}${chosen ? `（该动作在范围策略里的概率 ${pct(chosen.probs.get(chosen.pick) ?? 1)}）` : ""}。`
  ];

  let say: string;
  if (bet.type === "check") say = pickLine(opening ? LINES.checkOpen : LINES.checkClose, rng);
  else if (bet.type === "call") say = pickLine(LINES.call, rng);
  else if (bet.type === "fold") say = pickLine(LINES.fold, rng);
  else if (bet.raiseTo === M) say = pickLine(LINES.allIn, rng);
  else say = pickLine(LINES.raise(bet.raiseTo!), rng);
  return { kind: "bet", bet, say, reasoning: lines.join("\n") };
}

/** 我方某张牌对上开司本局打出的牌的胜率估计（含本局下注证据）。 */
export function estimateWin(view: BotView, mine: Card): { win: number; lose: number; draw: number } {
  const A = analyze(view);
  const o = zeros();
  for (const c of RANKS) o[c] = cmpRank(mine.rank, c);
  return outcomes(A.posterior, o);
}
