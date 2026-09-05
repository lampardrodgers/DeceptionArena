/**
 * 内置算法机器人（不用大模型的和也）。
 *
 * 只使用公开信息决策：自己的手牌、双方指示灯、本局下注过程、历史开牌记录、
 * 弃牌堆（所有打出的牌都翻开过）、牌堆重洗的时刻。绝不读取开司的手牌、牌堆顺序或被切掉的牌。
 *
 * 决策分四块：
 *  1. 记牌 + 读牌：`analysis.ts`。当前牌靴减去已翻开的牌和自己的牌 = 未知牌池；
 *     对开司「留在手里那张牌」做贝叶斯滤波，再结合本局下注行为修正他打出的牌的分布。
 *  2. 对手建模：`opponentModel.ts`。选牌偏好与下注偏好全部从对局历史中统计
 *     （带先验、随时间衰减的 Beta / Dirichlet 计数），越打越了解对手。
 *  3. 算账：`solver.ts`。在本局的下注子博弈上跑 CFR+ / Restricted Nash Response，
 *     解出的是**整条范围的混合策略**而不是单张牌的最优动作，所以同一个额度里既有价值牌也有诈唬牌。
 *     `futureValue.ts` 负责终局估值：把命数变化折成整场风险效用，并按**打出的点数**分档
 *     计入留牌对下一局的增益（下一局同样用求解器估，不再是最佳回应的上界）。
 *  4. 选牌与下注是**同一个策略的两半**（D3）：`selectionPolicy` 从开司视角枚举所有与我方指示灯
 *     一致的两牌组合，用 regret matching 迭代出「打哪一张」的混合策略，求解器用的 `myPrior`
 *     正是它聚合出来的；`botSelect` 从它抽样，`botBet` 复用同一份先验。这样开司眼中我方的范围
 *     和我方真实的选牌频率是自洽的 —— 求解器里的诈唬组合在现实中真的会出现。
 *
 * RNR 里「照模型打」的权重 `p` 由 `confidenceFor` 按**当前情境**给出（D6）：
 * 只数当前信息集真正会查到的那几格样本，没见过的局面自动退回接近均衡的打法。
 *
 * 本文件只保留决策入口（选牌 / 下注）、台词与人类可读的推理文本，并 re-export 全部公开 API。
 */
import { type Card, cardLabel, RANK_LABEL, type Rng } from "../game/cards.js";
import { type BetInput, type Lights, type Side } from "../game/engine.js";
import {
  type Analysis,
  type BotView,
  type Ctx,
  AI,
  HUMAN,
  PARAMS,
  RANKS,
  analyze,
  catOfRank,
  cmpRank,
  ctxOf,
  normalize,
  outcomes,
  oppVal,
  uWithEdge,
  unitUtility,
  unknownPool,
  zeros
} from "./analysis.js";
import { type AggCtx, type Beta, type Bin5, type OppModel, aggCtxOf, contextConfidence, rate } from "./opponentModel.js";
import { type FvTable, buildFvTable, makeValByRank, oneHot } from "./futureValue.js";
import { type SolveInput, type Solved, type SolvedAction, SOLVER_PARAMS, solve } from "./solver.js";
import { bettingConstraint } from "./strategyConstraints.js";

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
export { FV_ITERS, GAMMA, buildFvTable, makeValByRank } from "./futureValue.js";
export type { FvTable } from "./futureValue.js";

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
    `持 UP+DOWN 时出 DOWN：我灯 UP2 ${betaText(pd.UP2)} · 混合 ${betaText(pd.MIX)} · DOWN2 ${betaText(pd.DOWN2)}；同类牌先出强牌总体 ${betaText(m.playStrongerSameCat)}（${m.pairSamples} 个样本）。`,
    `同类牌按情境出强牌：两张必赢 ${betaText(m.playStrongerByContext.saveWinner)} · A 对双小避开 2 ${betaText(m.playStrongerByContext.avoidAce)} · 同类争胜 ${betaText(m.playStrongerByContext.contest)}；必胜牌弃牌失误 ${betaText(m.foldCertainWin)}。`,
    `下注倾向（按他自认胜率 <20%/<40%/<60%/<80%/≥80% 分档）：先手开局加注 ${binsText(m.agg.openFirst)}；我过牌后偷注 ${binsText(m.agg.stabAfterBotCheck)}；被跟注后连续开火 ${binsText(m.agg.barrel)}。`,
    `面对加注弃牌 ${binsText(m.foldToRaise)}；再加注 ${binsText(m.reraise)}；加注额度小/中/大 ${pct(sz[0] / szTotal)}/${pct(sz[1] / szTotal)}/${pct(sz[2] / szTotal)}，全档位可选时平均幅度约 ${pct(m.raiseFrac.sum / m.raiseFrac.n)}。`
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

// ---------- 情境置信度（D6） ----------

/**
 * RNR 权重 `p`：开司照对手模型出牌的概率。
 *
 * 旧实现直接取全局的 `model.confidence`，于是「先手开局加注」的 30 个样本会被算进
 * 「面对全下要不要跟」的自信里 —— 在一个从没见过的局面上照样敢按模型剥削。
 * 这里改成按**当前信息集下开司最近的那个决策**去数样本（`contextConfidence`）：
 *   - 开司先手且本局尚无动作 → 他马上要做的就是 `openFirst`；
 *   - 我先手且我尚未行动 → 他要么在我过牌后偷注，要么面对我的加注，两者各半；
 *   - 我正面对他的加注 → 他接下来只会在「面对我的再加注」那几格里出现。
 * 胜率档 `bin` 传 null：他的点数在我们眼里是一整条分布（`A.q` 覆盖多个档），不该只数一格。
 *
 * 除了「他下一步」，还要数**他本局已经做过的那几个决策**：求解器是从本局开局重放到当前节点的，
 * 他此刻手里这条范围完全是那些动作筛出来的。只看「下一步」会漏掉最重要的一类读牌 ——
 * 他先手开火时我永远没有「他面对我再加注」的样本，于是 p 永远钉在 p0，
 * 哪怕我已经看了他八局用垃圾牌最小加注，求解器读到的仍是一条均衡的（很强的）加注范围。
 * 两半各占一半：过去那几格解释「他为什么会在这里」，未来那格解释「我打下去他会怎么应」。
 */
export function confidenceFor(view: BotView, A: Analysis): number {
  const kaijiIsMix = ctxOf(view.lights.player) === "MIX";
  const cc = (facing: boolean, aggCtx: AggCtx) =>
    contextConfidence(A.model, { kaijiIsMix, facing, aggCtx, bucket: null, bin: null });

  // (1) 他接下来那个决策落在哪几格。
  let next: number;
  if (view.stakes.player > view.stakes.ai) {
    // 我在面对加注：他下一次决策是「面对我的再加注」，查的是 fold / reraise 那几格。
    next = cc(true, "barrel");
  } else if (view.actions.length === 0) {
    next = view.firstMover !== AI ? cc(false, "openFirst") : 0.5 * cc(false, "stabAfterBotCheck") + 0.5 * cc(true, "stabAfterBotCheck");
  } else {
    const heRaised = view.actions.some((a) => a.side !== AI && a.type === "raise");
    const agg: AggCtx = heRaised ? "barrel" : "stabAfterBotCheck";
    next = 0.5 * cc(false, agg) + 0.5 * cc(true, agg);
  }

  // (2) 他本局已经做过的决策各自落在哪几格（重放方式与 opponentModel 的学习端一致）。
  const past: number[] = [];
  const st: Record<Side, number> = { player: 1, ai: 1 };
  let heRaisedBefore = false;
  view.actions.forEach((a, idx) => {
    if (a.side !== AI) {
      past.push(cc(st[AI] > st[a.side], aggCtxOf(idx === 0, heRaisedBefore)));
      if (a.type === "raise") heRaisedBefore = true;
    }
    if (a.type === "raise") st[a.side] = a.raiseTo ?? st[a.side];
    else if (a.type === "call") st[a.side] = st[a.side === AI ? HUMAN : AI];
  });
  if (past.length === 0) return next;
  return 0.5 * next + 0.5 * (past.reduce((x, y) => x + y, 0) / past.length);
}

// ---------- 每局一次的缓存：留牌价值表 + 选牌策略 ----------

/**
 * 留牌价值表和选牌策略都只依赖「本局开打时的公开信息」（牌池、指示灯、命数、历史），
 * 牌池已扣除我方手牌；盖牌前后未知牌池不变，不使用本局下注证据，所以选牌与下注可以共用。
 * 键里带上牌池是必须的：同一局号、同一命数下不同的牌池是完全不同的局面（测试里尤其常见）。
 */
interface RoundCache {
  key: string;
  fv: FvTable;
  policy: SelectionPolicy | null;
}
let roundCache: RoundCache | null = null;

function roundKey(view: BotView, A: Analysis): string {
  return [
    view.round,
    view.lives.ai,
    view.lives.player,
    view.maxStake,
    view.firstMover,
    view.lights.ai.up,
    view.lights.player.up,
    view.history.length,
    PARAMS.solveEdge,
    PARAMS.oppEdge,
    PARAMS.edgeScaling,
    SOLVER_PARAMS.iters,
    SOLVER_PARAMS.maxRaises,
    A.pool.join(","),
    A.theirs.join(","),
    A.played.join(","),
    A.kept.join(","),
    // 同长度历史也可能学出不同支付习惯；不能跨对局误复用策略。
    JSON.stringify(A.model)
  ].join("|");
}

function cacheOf(view: BotView, A: Analysis): RoundCache {
  const key = roundKey(view, A);
  if (roundCache && roundCache.key === key) return roundCache;
  roundCache = { key, fv: buildFvTable(view, A), policy: null };
  return roundCache;
}

// ---------- 选牌—下注固定点（D3） ----------

/** 迭代预算。每轮一次求解 + 13 次 `evaluate`；有限轮数是实时近似，不保证所有组合收敛。 */
const SELECT_ITERS = 6;

/** 组合的键：MIX 时 a 是 UP 那张，否则 a 是点数较小的那张（与 `pairsOf` 一致）。 */
export const pairKey = (a: number, b: number) => a * 16 + b;

export interface SelectionPolicy {
  /** 与我方指示灯一致的两牌组合（开司视角），w = 该组合的先验权重。 */
  pairs: { a: number; b: number; w: number }[];
  /** pairKey → P(打出 a)。 */
  sigma: Map<number, number>;
  /** pairKey → 两个选择各自的效用（最后一轮）。 */
  evPairs: Map<number, { evA: number; evB: number }>;
  /** σ 聚合出来的「开司眼中我打出的牌」的分布。 */
  myPrior: number[];
  /** 打出 rank 时留在手里的牌的条件分布。 */
  keptGiven: (rank: number) => number[];
  /** 最后一轮的求解结果（供展示 / 复用）。 */
  sol: Solved;
  fv: FvTable;
}

/** 与指示灯一致的两牌组合：UP2 → 两张都 ≥8；DOWN2 → 两张都 <8；MIX → 一 UP 一 DOWN。 */
export function pairsOf(ctx: Ctx, theirs: number[]): { a: number; b: number; w: number }[] {
  const UP = RANKS.filter((r) => catOfRank(r) === "UP");
  const DOWN = RANKS.filter((r) => catOfRank(r) === "DOWN");
  const out: { a: number; b: number; w: number }[] = [];
  if (ctx === "MIX") {
    for (const a of UP) for (const b of DOWN) if (theirs[a] > 0 && theirs[b] > 0) out.push({ a, b, w: theirs[a] * theirs[b] });
  } else {
    const S = ctx === "UP2" ? UP : DOWN;
    for (let i = 0; i < S.length; i += 1) {
      for (let j = i; j < S.length; j += 1) {
        const a = S[i];
        const b = S[j];
        const w = a === b ? theirs[a] * (theirs[a] - 1) / 2 : theirs[a] * theirs[b];
        if (w > 0) out.push({ a, b, w });
      }
    }
  }
  const total = out.reduce((s, x) => s + x.w, 0);
  if (total > 0) for (const x of out) x.w /= total;
  return out;
}

/** 两个动作的 regret matching+ 状态。 */
interface PairState {
  ra: number;
  rb: number;
  /** 只累计实际迭代产生的策略；初始化的 50/50 不参与最终平均。 */
  sum: number;
  wSum: number;
  /** 本轮策略。 */
  sigma: number;
  /** 训练时为平滑后的平均策略，执行前恢复为实际迭代平均；用于聚合 `myPrior`。 */
  avg: number;
}

/**
 * 选牌—下注固定点。
 *
 * 「打哪一张」和「怎么下注」互相依赖：下注策略要知道开司眼中我方范围的形状，而这条范围
 * 完全由选牌频率决定；反过来选牌的收益又要靠下注子博弈才算得出来。旧实现把两者割裂 ——
 * `myPrior` 用的是「按指示灯的 UP/DOWN 比例 + 牌池」这条与真实选牌无关的分布，
 * 于是求解器里出现的诈唬组合在现实中根本不会发生。
 *
 * 这里迭代到自洽：给一组选牌频率 σ → 聚合出 `myPrior` 与「打 r 留 k」的条件分布 → 解一次
 * 下注子博弈 → 用 13 次 `evaluate`（同一套策略、只换终局估值）读出「打 r 留 k」的价值 →
 * regret matching+ 更新 σ。返回求解得到的平均策略，不额外给劣势选择注入概率。
 */
export function selectionPolicy(view: BotView, A: Analysis, fv: FvTable, iters = SELECT_ITERS): SelectionPolicy {
  iters = Math.max(1, Math.floor(iters));
  const ctx = ctxOf(view.lights.ai);
  const pairs = pairsOf(ctx, A.theirs);
  const st = new Map<number, PairState>();
  // 50/50 用于训练初始化和平滑，不记入 sum/wSum，不能永久留在实际选牌概率里。
  for (const p of pairs) st.set(pairKey(p.a, p.b), { ra: 0, rb: 0, sum: 0, wSum: 0, sigma: 0.5, avg: 0.5 });
  const poolFallback = normalize(A.pool.slice());

  let myPrior = zeros();
  let keptTable: number[][] = [];
  let sol!: Solved;
  const evPairs = new Map<number, { evA: number; evB: number }>();

  /** 由 σ 聚合出 `myPrior` 与 keptGiven。 */
  const aggregate = (): void => {
    const my = zeros();
    const kept: number[][] = RANKS.map(() => zeros());
    const idx = new Map<number, number>();
    RANKS.forEach((r, i) => idx.set(r, i));
    for (const p of pairs) {
      const s = st.get(pairKey(p.a, p.b))!.avg;
      my[p.a] += p.w * s;
      my[p.b] += p.w * (1 - s);
      kept[idx.get(p.a)!][p.b] += p.w * s;
      kept[idx.get(p.b)!][p.a] += p.w * (1 - s);
    }
    myPrior = normalize(my);
    keptTable = kept.map((row) => {
      const sum = row.reduce((x, y) => x + y, 0);
      return sum > 0 ? row.map((v) => v / sum) : poolFallback.slice();
    });
  };
  const keptGiven = (rank: number): number[] => keptTable[RANKS.indexOf(rank)] ?? poolFallback;

  const base = {
    oppPrior: A.played,
    q: A.q,
    model: A.model,
    p: confidenceFor(view, A),
    M: view.maxStake,
    meFirst: view.firstMover === AI,
    LOpp: view.lives.player,
    oppMix: ctxOf(view.lights.player) === "MIX",
    valOpp: oppVal(view.lives.player, view.lives.ai + view.lives.player),
    edge: PARAMS.solveEdge,
    allowAction: constraintOf(view, A),
    // 选牌时本局还没有任何下注动作，树从根开始。
    actions: []
  };

  for (let t = 1; t <= iters; t += 1) {
    aggregate();
    sol = solve({ ...base, myPrior, val: makeValByRank(view, keptGiven, fv) } as SolveInput);
    // 「打 r 留 k」的价值：同一套策略换一套终局估值再走一遍，13 个点数一次出。
    const held = new Map<number, (rank: number) => number>();
    for (const k of RANKS) if (A.theirs[k] > 0) held.set(k, sol.evaluate(makeValByRank(view, () => oneHot(k), fv)));
    const fallback = (rank: number) => sol.rootValue(rank);
    for (const p of pairs) {
      const key = pairKey(p.a, p.b);
      const s = st.get(key)!;
      const evA = (held.get(p.b) ?? fallback)(p.a);
      const evB = (held.get(p.a) ?? fallback)(p.b);
      evPairs.set(key, { evA, evB });
      const cur = s.sigma * evA + (1 - s.sigma) * evB;
      // Linear CFR：第 t 轮的即时遗憾乘 t；平均策略按 t² 加权（与 solver.ts 同一套加权）。
      s.ra = Math.max(0, s.ra + (evA - cur) * t);
      s.rb = Math.max(0, s.rb + (evB - cur) * t);
      const tot = s.ra + s.rb;
      s.sigma = tot > 0 ? s.ra / tot : 0.5;
      // 先更新再累加：这样最后一轮改进过的策略也进得了平均，而第一轮那个「面对 50/50 范围」
      // 的最佳回应只以 1/91 的权重出现。虚拟对局对的是**平均策略**（`avg`），迭代之间不会来回甩。
      s.sum += t * t * s.sigma;
      s.wSum += t * t;
      // 训练时保留一份轻微的 50/50 平滑，避免第一轮纯策略使后续范围过早塌缩。
      // 它只影响下一轮求解输入；最终执行前必须剥离，不能形成隐含选牌下限。
      s.avg = (s.sum + 0.5) / (s.wSum + 1);
    }
  }
  for (const s of st.values()) s.avg = s.sum / s.wSum;
  // M=1 没有下注空间，可以精确比较开牌+留牌效用，清除早期探索留下的严格劣势选择。
  if (view.maxStake === 1) for (const pair of pairs) {
    const value = (play: number, keep: number) => {
      const val = makeValByRank(view, () => oneHot(keep), fv);
      return RANKS.reduce((sum, rank) => sum + A.played[rank] * val(play, cmpRank(play, rank)), 0);
    };
    const a = value(pair.a, pair.b), b = value(pair.b, pair.a);
    if (Math.abs(a - b) > 1e-12) st.get(pairKey(pair.a, pair.b))!.avg = a > b ? 1 : 0;
  }
  // 保留求解得到的混合，不强行为较差选择补足 2%。
  const sigma = new Map<number, number>();
  for (const p of pairs) {
    const key = pairKey(p.a, p.b);
    sigma.set(key, st.get(key)!.avg);
  }
  aggregate();
  // 最后一轮选牌更新也必须反馈到下注树，展示和 evaluate 与返回的范围一致。
  sol = solve({ ...base, myPrior, val: makeValByRank(view, keptGiven, fv) } as SolveInput);
  const values = new Map<number, (rank: number) => number>();
  for (const p of pairs) for (const k of [p.a, p.b]) {
    if (!values.has(k)) values.set(k, sol.evaluate(makeValByRank(view, () => oneHot(k), fv)));
  }
  for (const p of pairs) evPairs.set(pairKey(p.a, p.b), {
    evA: values.get(p.b)!(p.a), evB: values.get(p.a)!(p.b)
  });
  return { pairs, sigma, evPairs, myPrior, keptGiven, sol, fv };
}

/** 取（或算）本局的选牌策略。`botSelect` 与 `botBet` 拿到的是同一个对象（每局一份缓存）。 */
export function policyOf(view: BotView, A: Analysis): SelectionPolicy {
  const c = cacheOf(view, A);
  if (!c.policy) c.policy = selectionPolicy(view, A, c.fv);
  return c.policy;
}

// ---------- 求解器接口 ----------

/**
 * 组装一次求解的输入。
 *
 * `myPrior` 来自选牌策略（D3）：开司眼中我打出的那张牌的分布，就是我方真实选牌频率的聚合，
 * 两者自洽。`val` 按打出的点数分档（D9'）：开司看不到我留了什么，他眼中每个点数背后都是
 * 一整条留牌分布，13 个点数的终局值因此不同。
 */
function solveInput(view: BotView, A: Analysis, pol: SelectionPolicy, keptGiven: (rank: number) => number[]): SolveInput {
  return {
    myPrior: pol.myPrior,
    oppPrior: A.played,
    q: A.q,
    model: A.model,
    p: confidenceFor(view, A),
    M: view.maxStake,
    meFirst: view.firstMover === AI,
    LOpp: view.lives.player,
    oppMix: ctxOf(view.lights.player) === "MIX",
    val: makeValByRank(view, keptGiven, pol.fv),
    valOpp: oppVal(view.lives.player, view.lives.ai + view.lives.player),
    edge: PARAMS.solveEdge,
    allowAction: constraintOf(view, A),
    actions: view.actions
  };
}

function constraintOf(view: BotView, A: Analysis): NonNullable<SolveInput["allowAction"]> {
  return bettingConstraint(ctxOf(view.lights.ai), ctxOf(view.lights.player), A.played,
    (d) => uWithEdge(d, view.lives.ai, view.lives.ai + view.lives.player, PARAMS.solveEdge));
}

/**
 * 同一个局面在一次决策里可能被问到两次（比如展示用的重算），这里做个极小的记忆化。
 * 树的形状取决于本局已发生的动作，所以键里必须带上完整的动作序列；跨局面不可复用。
 */
let memoKey = "";
let memoSol: Solved | null = null;

function solveRound(view: BotView, A: Analysis, pol: SelectionPolicy, keptGiven: (rank: number) => number[]): Solved {
  const acts = view.actions.map((a) => `${a.side[0]}${a.type[0]}${a.raiseTo ?? ""}`).join("");
  const key = [
    roundKey(view, A),
    view.stakes.ai,
    view.stakes.player,
    view.chosen?.rank ?? 0,
    // 留在手里的牌决定终局估值（下一局增益），必须进键。
    view.hand.map((c) => c.rank).join(","),
    acts
  ].join("|");
  if (key === memoKey && memoSol) return memoSol;
  memoSol = solve(solveInput(view, A, pol, keptGiven));
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
 * 某个点数在节点 n 上**执行时真正会用**的完整混合（不做展示剪枝，只滤掉执行剪枝那 0.5%）。
 * 展示剪枝 2% 会把低频诈唬和慢打整条藏起来，看着像「加注 = 强牌」；这一行专门让人看见它们。
 */
function fullMixText(sol: Solved, n: number, rank: number, M: number): string {
  const acts = sol.actionsOf(n);
  const st = sol.strategyAt(n, rank);
  const kept = acts.map((a, i) => ({ a, p: st[i] })).filter((x) => x.p >= SOLVER_PARAMS.executionPrune);
  const total = kept.reduce((s, x) => s + x.p, 0);
  if (!(total > 0)) return "—";
  return kept
    .sort((x, y) => y.p - x.p)
    .map((x) => `${actLabel(x.a, M)} ${(100 * (x.p / total)).toFixed(1)}%`)
    .join(" / ");
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
  const pol = policyOf(view, A);
  const sol = pol.sol;
  // 与求解用的 `val` 同一条曲线（solveEdge），这样「合计 − 本局 = 留牌增益」才是同一把尺子。
  const valNow = (_rank: number, d: number) => uWithEdge(d, LMe, T, PARAMS.solveEdge);
  const evNowOf = sol.evaluate(valNow);

  // 我手里这两张对应的组合，方向与 `pairsOf` 一致：MIX 时 a 是 UP 那张，否则 a 是点数较小的那张。
  const mix = ctxOf(view.lights.ai) === "MIX";
  const [ca, cb] = mix
    ? catOfRank(hand[0].rank) === "UP"
      ? [hand[0], hand[1]]
      : [hand[1], hand[0]]
    : hand[0].rank <= hand[1].rank
      ? [hand[0], hand[1]]
      : [hand[1], hand[0]];
  const pA = pol.sigma.get(pairKey(ca.rank, cb.rank)) ?? 0.5;

  const lines: string[] = [
    modelText(A.model),
    poolText(view, A),
    handText(view, A),
    `【我方候选】先手：${iAmFirst ? "我" : "开司"}，本局上限 ${M} 命（EV 以命计，已按命数风险效用折算；留牌价值由下一局的范围求解器估算，输光则没有下一局）。`
  ];
  const cands = [
    { card: ca, keep: cb, p: pA },
    { card: cb, keep: ca, p: 1 - pA }
  ].map(({ card, keep, p }) => {
    // 同一套策略换两套终局估值各走一遍，就能把「本局」和「留牌增益」分开给人看。
    const ev = sol.evaluate(makeValByRank(view, () => oneHot(keep.rank), pol.fv))(card.rank);
    const evNow = evNowOf(card.rank);
    const o = zeros();
    for (const c of RANKS) o[c] = cmpRank(card.rank, c);
    const oc = outcomes(A.played, o);
    lines.push(
      `${cardLabel(card)}：本局胜 ${pct(oc.win)} / 平 ${pct(oc.draw)} / 负 ${pct(oc.lose)} → 本局 EV ${inLives(evNow, unit)} 命；留 ${cardLabel(keep)} 对下一局的增益 ${inLives(ev - evNow, unit)} → 合计 ${inLives(ev, unit)}；打出它的概率 ${pct(p)}；范围策略下的开局动作：${stratText(sol, sol.cur, card.rank, M)}`
    );
    return { card, keep, p };
  });

  // 按 σ 抽样：只消耗一次 rng，且按概率从大到小排序，`rng = () => 0` 就是「取最可能的那张」。
  const order = cands.slice().sort((x, y) => y.p - x.p);
  let r = rng();
  let pick = order[order.length - 1];
  for (const c of order) {
    r -= c.p;
    if (r <= 0) {
      pick = c;
      break;
    }
  }

  lines.push(rangeViewText(A, pol), decisionText(view, A, pol, sol));
  lines.push(`【决定】打出 ${cardLabel(pick.card)}，留 ${cardLabel(pick.keep)}（该选择的概率 ${pct(pick.p)}）。`);
  const say = pickLine(LINES.select, rng);
  return { kind: "select", cardId: pick.card.id, say, reasoning: lines.join("\n") };
}

/** 思考面板里「开司眼中我方选牌范围长什么样」的一行。 */
function rangeViewText(A: Analysis, pol: SelectionPolicy): string {
  let up = 0;
  for (const r of RANKS) if (catOfRank(r) === "UP") up += pol.myPrior[r];
  // 「诈唬组合」= 打出那张对上他的出牌分布胜率更低的牌，按组合权重 × 打出它的概率排序。
  const winOf = (rank: number) => {
    const o = zeros();
    for (const c of RANKS) o[c] = cmpRank(rank, c);
    const oc = outcomes(A.played, o);
    return oc.win + oc.draw / 2;
  };
  const bluffs = pol.pairs
    .map((p) => {
      const s = pol.sigma.get(pairKey(p.a, p.b)) ?? 0.5;
      const aWeak = winOf(p.a) <= winOf(p.b);
      const weak = aWeak ? p.a : p.b;
      const strong = aWeak ? p.b : p.a;
      const prob = aWeak ? s : 1 - s;
      return { weak, strong, score: p.w * prob, prob };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .map((x) => `${RANK_LABEL[x.weak]}（留 ${RANK_LABEL[x.strong]}）${pct(x.prob)}`)
    .join(" · ");
  return `【范围视角】开司眼中我打 UP 牌的概率 ${pct(up)}；我方出牌分布 ${distText(pol.myPrior)}。最可能的诈唬组合：${bluffs || "（无）"}。`;
}

/** 思考面板里「这次求解用了什么参数」的一行。 */
function decisionText(view: BotView, A: Analysis, pol: SelectionPolicy, sol: Solved): string {
  return (
    `【范围策略】开司照模型出牌的权重 p=${pct(confidenceFor(view, A))}（本情境；全局可信度 ${pct(A.model.confidence)}）；` +
    `树 ${sol.nodeCount} 节点 × ${sol.iters} 次 CFR+ 迭代；选牌固定点迭代 ${SELECT_ITERS} 轮 × ${pol.pairs.length} 个组合，留牌估值表 ${pol.fv.solves} 次求解。`
  );
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
  const opening = view.actions.length === 0;

  const pol = policyOf(view, A);
  // 终局估值按打出的点数分档：范围里**其它**点数用选牌策略聚合出来的留牌分布（开司只能知道这个），
  // 实际打出的点数换成真实留牌（one-hot），用于本手牌估值。
  // 仍是按出牌点数聚合的近似：重解会间接影响复制体的回应，完整一致性需扩展为出牌+留牌私有类型。
  const keptGiven = (rank: number) => (rank === mine.rank ? oneHot(keep?.rank ?? null) : pol.keptGiven(rank));
  const sol = solveRound(view, A, pol, keptGiven);
  const D = sol.opponentRangeAt(sol.cur);
  const o = zeros();
  for (const c of RANKS) o[c] = cmpRank(mine.rank, c);
  const oc = outcomes(D, o);
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
  const allowed = constraintOf(view, A);
  const idx = acts.map((_, i) => i).filter((i) => isLegal(acts[i]) && allowed(mine.rank, acts[i], sMe, sOpp, D));
  const strat = idx.length > 0 ? sol.strategyAt(sol.cur, mine.rank) : [];
  const chosen = idx.length > 0 ? pickAction(idx, strat, rng) : null;
  const bet: BetInput = chosen
    ? acts[chosen.pick].type === "raise"
      ? { type: "raise", raiseTo: acts[chosen.pick].raiseTo! }
      : { type: acts[chosen.pick].type as "check" | "call" | "fold" }
    : legal.canCheck
      ? { type: "check" }
      : legal.canFold
        ? { type: "fold" }
        : { type: "call" };

  // 到达当前节点后模型/自由复制体的比例可能改变，展示必须与收益计算使用同一份混合。
  const foldRate = (kid: number): number | undefined => sol.opponentActionProb(kid, "fold");

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
    `【开司出牌分布】求解器当前节点的条件范围（模型与自由策略混合）：${distText(D)}。我方胜 ${pct(oc.win)} / 平 ${pct(oc.draw)} / 负 ${pct(oc.lose)}。`,
    ...(ctxOf(view.lights.ai) === "DOWN2" && ctxOf(view.lights.player) === "UP2"
      ? ["【保守边界】双小对双大，3～7 只过牌或弃牌；2 仅在公开的 A 范围和本局风险收益都支持时追加。"] : []),
    decisionText(view, A, pol, sol),
    `　我方 ${cardLabel(mine)} 的动作分布：${stratText(sol, sol.cur, mine.rank, M, 4)}。范围里其他点数：${byRange || "—"}。`,
    `　本手牌的完整混合：${sol.kindOf(sol.cur) === 0 ? fullMixText(sol, sol.cur, mine.rank, M) : "—"}（执行剪枝 ${(100 * SOLVER_PARAMS.executionPrune).toFixed(1)}%；上面一行按展示剪枝 ${(100 * SOLVER_PARAMS.displayPrune).toFixed(0)}% 只列前几项）。`,
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
