/**
 * 下注子博弈的有限深度期望值搜索。
 *
 * 我方节点取最大值（在给定对手模型下的最佳回应），开司节点按行为模型的概率加权。
 * 叶节点的效用是「赢下整场的概率」，并按结局折算留在手里那张牌的下一局价值。
 */
import { type Card } from "../game/cards.js";
import { type Lights } from "../game/engine.js";
import {
  type Analysis,
  type BotView,
  AI,
  CATS,
  RANKS,
  catOfRank,
  cmpRank,
  ctxOf,
  normalize,
  perceivedWin,
  u,
  zeros
} from "./analysis.js";
import {
  type AggCtx,
  type OppModel,
  type SizeBucket,
  aggressionProb,
  chooseProb,
  foldProb,
  predictRaise,
  raiseOptions,
  reraiseProb,
  sizeProb
} from "./opponentModel.js";

/** 留牌的未来价值折扣（下一局未必真按估计打出去）。 */
const GAMMA = 0.7;
/** 下注树搜索深度：双方合计还能有几次加注被纳入考虑。 */
export const DEPTH = 3;
/** 估算下一局（留牌价值）时用的深度。 */
export const DEPTH_FUTURE = 1;

export interface Spot {
  /** 我的牌对上各点数的结果：+1 胜 / -1 负 / 0 平。 */
  o: number[];
  /** 开司拿各点数时自认为的胜率。 */
  q: number[];
  model: OppModel;
  /** 本局押注上限。 */
  M: number;
  /** 开司的命数（影响他对加注额的敏感度）。 */
  LOpp: number;
  /** 叶节点估值：本局我的命数变化 → 效用（可含留牌的下一局价值）。 */
  val: (delta: number) => number;
  /** 顶层深度：顶层枚举全部加注额，更深的节点只看几个代表额。 */
  top: number;
}

export function makeSpot(myRank: number, q: number[], model: OppModel, M: number, LOpp: number, val: (d: number) => number, top: number): Spot {
  const o = zeros();
  for (const c of RANKS) o[c] = cmpRank(myRank, c);
  return { o, q, model, M, LOpp, val, top };
}

export function outcomes(D: number[], o: number[]): { win: number; lose: number; draw: number } {
  let win = 0;
  let lose = 0;
  let draw = 0;
  for (const c of RANKS) {
    if (o[c] > 0) win += D[c];
    else if (o[c] < 0) lose += D[c];
    else draw += D[c];
  }
  return { win, lose, draw };
}

/** 按似然 f 修正分布，返回归一化后的分布和该分支的总概率。 */
function condition(D: number[], f: (c: number) => number): { D: number[]; mass: number } {
  const out = zeros();
  let mass = 0;
  for (const c of RANKS) {
    if (!D[c]) continue;
    out[c] = D[c] * f(c);
    mass += out[c];
  }
  if (mass > 0) for (const c of RANKS) out[c] /= mass;
  return { D: out, mass };
}

export function showdown(D: number[], spot: Spot, S: number): number {
  let ev = 0;
  for (const c of RANKS) if (D[c]) ev += D[c] * spot.val(spot.o[c] * S);
  return ev;
}

/** 我可以考虑的加注额：顶层全部枚举，深层只看最小、中等、全下。 */
function raiseSizes(spot: Spot, from: number, depth: number): number[] {
  if (from >= spot.M) return [];
  if (depth >= spot.top) {
    const all: number[] = [];
    for (let R = from + 1; R <= spot.M; R += 1) all.push(R);
    return all;
  }
  const mid = Math.round((from + 1 + spot.M) / 2);
  return Array.from(new Set([from + 1, mid, spot.M])).sort((a, b) => a - b);
}

/**
 * 开司从 from 加注时的代表额度及其权重。
 *
 * 顶层几层按「小 / 中 / 大」三个代表额分支（额度模型认为他各多常用），
 * 更深的节点和「估算下一局」只取单一代表额，避免搜索规模乘以 3。
 */
function hisRaiseBranches(spot: Spot, from: number, depth: number): { to: number; w: (c: number) => number }[] {
  const { model, M } = spot;
  if (from >= M) return [];
  if (spot.top < DEPTH || depth < spot.top - 1) return [{ to: predictRaise(model, from, M), w: () => 1 }];
  const merged = new Map<number, SizeBucket[]>();
  for (const o of raiseOptions(from, M)) {
    const list = merged.get(o.to);
    if (list) list.push(o.bucket);
    else merged.set(o.to, [o.bucket]);
  }
  return [...merged.entries()].map(([to, buckets]) => ({
    to,
    w: (c: number) => buckets.reduce<number>((acc, b) => acc + sizeProb(model, spot.q[c], b), 0)
  }));
}

/** 我加注到 R（对方已押 sOpp）后对方的响应：弃牌 / 跟注 / 再加注。 */
export function hisResponse(D: number[], spot: Spot, R: number, sOpp: number, depth: number): { ev: number; fold: number } {
  const { q, model, M, LOpp, val } = spot;
  const pf = zeros();
  const prr = zeros();
  for (const c of RANKS) {
    pf[c] = foldProb(model, q[c], R, sOpp, LOpp);
    prr[c] = R < M && depth >= 0 ? (1 - pf[c]) * reraiseProb(model, q[c]) : 0;
  }
  let ev = 0;
  let fold = 0;
  for (const c of RANKS) {
    if (!D[c]) continue;
    fold += D[c] * pf[c];
  }
  ev += fold * val(sOpp);
  const call = condition(D, (c) => 1 - pf[c] - prr[c]);
  if (call.mass > 0) ev += call.mass * (R >= M ? showdown(call.D, spot, R) : afterHisCall(call.D, spot, R, depth));
  if (R < M && depth >= 0) {
    for (const br of hisRaiseBranches(spot, R, depth)) {
      const rr = condition(D, (c) => prr[c] * br.w(c));
      if (rr.mass > 0) ev += rr.mass * myFacing(rr.D, spot, R, br.to, depth - 1).ev;
    }
  }
  return { ev, fold };
}

/** 对方跟注了我的加注（未到上限）：我可以过牌开牌，或继续加注。 */
function afterHisCall(D: number[], spot: Spot, S: number, depth: number): number {
  let best = showdown(D, spot, S);
  if (depth > 0) for (const R of raiseSizes(spot, S, depth)) best = Math.max(best, hisResponse(D, spot, R, S, depth - 1).ev);
  return best;
}

/** 我面对对方加注到 R（我已押 s）：弃牌 / 跟注 / 再加注。 */
function myFacing(D: number[], spot: Spot, s: number, R: number, depth: number): { ev: number; choice: string } {
  let best = { ev: spot.val(-s), choice: "fold" };
  const call = afterMyCall(D, spot, R, depth);
  if (call > best.ev) best = { ev: call, choice: "call" };
  if (depth > 0) {
    for (const R2 of raiseSizes(spot, R, depth)) {
      const ev = hisResponse(D, spot, R2, R, depth - 1).ev;
      if (ev > best.ev) best = { ev, choice: `raise${R2}` };
    }
  }
  return best;
}

/** 我跟注到 S 之后：到上限则开牌；否则行动回到刚加注的对方，他可以过牌开牌或继续加注。 */
export function afterMyCall(D: number[], spot: Spot, S: number, depth: number): number {
  if (S >= spot.M) return showdown(D, spot, S);
  return hisTurn(D, spot, S, depth, "barrel");
}

/**
 * 对方在双方押注相同（S）时行动：加注（我再应对）或过牌。
 *  openFirst：他是本局第一个行动的人，过牌后轮到我；
 *  stabAfterBotCheck：我过牌给他，他过牌即开牌；
 *  barrel：他的加注被我跟注，他继续加注或过牌开牌。
 * 三种情境的加注倾向是分开统计的（同一个人先手开局和「看到对手示弱后偷注」完全是两回事）。
 */
export function hisTurn(D: number[], spot: Spot, S: number, depth: number, mode: AggCtx): number {
  const { q, model, M } = spot;
  if (S >= M || depth < 0) return showdown(D, spot, S);
  const pr = zeros();
  for (const c of RANKS) pr[c] = aggressionProb(model, mode, q[c]);
  let ev = 0;
  for (const br of hisRaiseBranches(spot, S, depth)) {
    const raise = condition(D, (c) => pr[c] * br.w(c));
    if (raise.mass > 0) ev += raise.mass * myFacing(raise.D, spot, S, br.to, depth - 1).ev;
  }
  const check = condition(D, (c) => 1 - pr[c]);
  if (check.mass > 0) ev += check.mass * (mode === "openFirst" ? myClosing(check.D, spot, S, depth) : showdown(check.D, spot, S));
  return ev;
}

/** 对方先手过牌之后轮到我：过牌开牌，或加注。 */
function myClosing(D: number[], spot: Spot, S: number, depth: number): number {
  let best = showdown(D, spot, S);
  if (depth > 0) for (const R of raiseSizes(spot, S, depth)) best = Math.max(best, hisResponse(D, spot, R, S, depth - 1).ev);
  return best;
}

/** 我先手：过牌看他反应，或加注。 */
function myOpening(D: number[], spot: Spot, S: number, depth: number): number {
  let best = hisTurn(D, spot, S, depth, "stabAfterBotCheck");
  if (depth > 0) for (const R of raiseSizes(spot, S, depth)) best = Math.max(best, hisResponse(D, spot, R, S, depth - 1).ev);
  return best;
}

/** 一局从下注开始算起的期望（双方各押 1 命，尚无动作）。 */
export function roundEV(D: number[], spot: Spot, iAmFirst: boolean, depth: number): number {
  return iAmFirst ? myOpening(D, spot, 1, depth) : hisTurn(D, spot, 1, depth, "openFirst");
}

// ---------- 留牌的下一局价值 ----------

/**
 * 下一局：我手里留着点数 k，命数变为 L，先手为 iFirst，这一局对我的期望效用。
 * 开司手里是他本局留下的牌加一张新牌，我的指示灯取决于 k 和我的新牌（按牌池概率混合）。
 */
function nextRoundEV(A: Analysis, k: number, L: number, T: number, iFirst: boolean): number {
  const M = Math.min(L, T - L);
  const pool = A.pool;
  let total = 0;
  let upCount = 0;
  for (const r of RANKS) {
    total += pool[r];
    if (r >= 8) upCount += pool[r];
  }
  const pUp = total > 0 ? upCount / total : 0.5;
  const newDist = normalize(pool.slice());
  const theirs = pool.slice();
  theirs[k] += 1;
  const val = (d: number) => u(d, L, T);
  let ev = 0;
  for (const newCat of CATS) {
    const w = newCat === "UP" ? pUp : 1 - pUp;
    if (w <= 0) continue;
    const up = (catOfRank(k) === "UP" ? 1 : 0) + (newCat === "UP" ? 1 : 0);
    const lights: Lights = { up, down: 2 - up };
    const ctx = ctxOf(lights);
    const D = zeros();
    for (const h of RANKS) {
      if (!A.kept[h]) continue;
      for (const n of RANKS) {
        const p = A.kept[h] * newDist[n];
        if (!p) continue;
        const ph = chooseProb(A.model, h, n, ctx);
        D[h] += p * ph;
        D[n] += p * (1 - ph);
      }
    }
    const q = zeros();
    for (const c of RANKS) q[c] = perceivedWin(c, lights, theirs);
    const spot = makeSpot(k, q, A.model, M, T - L, val, DEPTH_FUTURE);
    ev += w * roundEV(normalize(D), spot, iFirst, DEPTH_FUTURE);
  }
  return ev;
}

/** 留牌缓存：同一次决策里多个候选共用，避免重复算「平均下一局」。 */
export type FutureCache = Map<string, number>;

/**
 * 留着 K 相比「随便一张牌」在下一局多赚多少效用。
 * 效用曲线 U(L) 已经包含了之后所有「平均水平」的对局，所以这里只计增量；输光或赢下整场则为 0。
 */
function futureValue(A: Analysis, K: Card, L: number, T: number, iFirst: boolean, cache: FutureCache): number {
  if (L <= 0 || L >= T) return 0;
  const key = `${L}:${iFirst}`;
  let base = cache.get(key);
  if (base === undefined) {
    let total = 0;
    for (const r of RANKS) total += A.pool[r];
    base = 0;
    if (total > 0) for (const r of RANKS) if (A.pool[r]) base += (A.pool[r] / total) * nextRoundEV(A, r, L, T, iFirst);
    cache.set(key, base);
  }
  return nextRoundEV(A, K.rank, L, T, iFirst) - base;
}

/**
 * 本局叶节点估值：命数变化 delta → 效用。
 * 先按整场胜率折算本局输赢，再按该结局下的命数与先手估算留牌 K 的下一局增量价值；输光或赢下整场则没有下一局。
 */
export function makeVal(view: BotView, A: Analysis, K: Card | null, cache: FutureCache): (d: number) => number {
  const LMe = view.lives.ai;
  const T = LMe + view.lives.player;
  const memo = new Map<number, number>();
  return (d: number) => {
    const hitv = memo.get(d);
    if (hitv !== undefined) return hitv;
    let v = u(d, LMe, T);
    if (K) {
      const iFirst = d > 0 ? true : d < 0 ? false : view.firstMover === AI;
      v += GAMMA * futureValue(A, K, LMe + d, T, iFirst, cache);
    }
    memo.set(d, v);
    return v;
  };
}
