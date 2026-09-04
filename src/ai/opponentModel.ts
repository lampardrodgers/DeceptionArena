/**
 * 开司的行为模型 V2：从对局历史里统计他的选牌偏好与下注偏好。
 *
 * 全部样本都来自公开信息（每局结束双方的牌都会翻开）。相比 V1 的改动：
 *  - 主动加注拆成三种情境（先手开局 / 我过牌后偷注 / 被跟注后连续开火），不再混为一谈；
 *  - 自认胜率从 3 档细分到 5 档，档内斜率降到 1，先验总量压到 3 个伪样本，并向 3 档收缩以对抗稀疏；
 *  - 加注额度按「小 / 中 / 大」三桶建 Dirichlet 模型，既作为读牌证据，也用于预测他会加到多少；
 *  - 同时维护快（0.80）慢（0.97）两套记忆，按最近若干局的预测对数似然融合，并导出置信度。
 *
 * 与 analysis.ts 相互引用，但只在函数体里互相调用，模块初始化阶段没有依赖。
 */
import { type Card } from "../game/cards.js";
import { type Side, other } from "../game/engine.js";
import {
  type BotView,
  type Cat,
  type Ctx,
  HUMAN,
  catOf,
  catOfRank,
  cmpRank,
  ctxOf,
  historyPools,
  livesBefore,
  otherCat,
  perceivedWin
} from "./analysis.js";

/** 开司自认为的胜率粗分档（用于 5 档的层级收缩）。 */
export type Bin = "weak" | "mid" | "strong";
/** 开司自认为的胜率细分档：<0.2 / <0.4 / <0.6 / <0.8 / ≥0.8。 */
export type Bin5 = "vweak" | "weak" | "mid" | "strong" | "vstrong";
/** 双方押注相同时他能主动加注的三种情境。 */
export type AggCtx = "openFirst" | "stabAfterBotCheck" | "barrel";
/** 加注额度桶：0 小 / 1 中 / 2 大（含全下）。 */
export type SizeBucket = 0 | 1 | 2;

const BINS5: Bin5[] = ["vweak", "weak", "mid", "strong", "vstrong"];
const AGG_CTXS: AggCtx[] = ["openFirst", "stabAfterBotCheck", "barrel"];
const CTXS: Ctx[] = ["UP2", "MIX", "DOWN2"];

/** 5 档 → 3 档的归组，用于层级收缩。 */
const COARSE: Record<Bin5, Bin> = { vweak: "weak", weak: "weak", mid: "mid", strong: "strong", vstrong: "strong" };
const BIN5_CENTER: Record<Bin5, number> = { vweak: 0.1, weak: 0.3, mid: 0.5, strong: 0.7, vstrong: 0.9 };

/**
 * 档内按胜率微调的 logit 斜率。V1 用 3，会把「档内单调」强行写死，
 * 极化型对手（最强 + 最弱都加注）根本表达不出来；细分到 5 档后降到 1。
 */
const SLOPE = 1;
/** 加注额占对方命数的比例越大，对方越可能弃牌（logit 斜率）。 */
const KAPPA = 1.5;
/** 对方已押注越多越不愿弃牌。 */
const MU = 1.2;

/** 可调参数，阶段 B 调参时集中改这里。 */
export const MODEL_PARAMS = {
  /** 慢记忆的每局衰减（半衰期约 23 局）。 */
  decaySlow: 0.97,
  /** 快记忆的每局衰减（半衰期约 3 局）。 */
  decayFast: 0.8,
  /** 融合权重 wFast = sigmoid(gain · (LL_fast − LL_slow))。 */
  fusionGain: 3,
  /** 评估快慢记忆时只看最近这么多局。 */
  recentRounds: 8,
  /** 5 档向 3 档收缩的强度（伪样本数）。 */
  shrinkBin: 2,
  /** 加注额度 5 档向 3 档收缩的强度。 */
  shrinkSize: 2,
  /** 置信度上限。 */
  pMax: 0.8,
  /** 置信度的半饱和样本数。 */
  n0: 8,
  /** 置信度下限（没有历史时就是这个值）。 */
  p0: 0.35
};

// ---------- 先验（「普通人」，总量 ≤ 4 个伪样本，10~15 局就能被数据推翻） ----------

/** 每个胜率档 Beta 的先验伪样本总量。 */
const PRIOR_N = 3;
const AGG_PRIOR: Record<AggCtx, Record<Bin5, number>> = {
  openFirst: { vweak: 0.1, weak: 0.18, mid: 0.3, strong: 0.48, vstrong: 0.68 },
  // 对手看到我过牌，普通人会比自己开局时更敢偷。
  stabAfterBotCheck: { vweak: 0.16, weak: 0.24, mid: 0.36, strong: 0.54, vstrong: 0.74 },
  // 已经开过一枪又被跟注，第二枪普遍更收敛。
  barrel: { vweak: 0.07, weak: 0.12, mid: 0.22, strong: 0.4, vstrong: 0.6 }
};
const FOLD_PRIOR: Record<Bin5, number> = { vweak: 0.8, weak: 0.66, mid: 0.46, strong: 0.26, vstrong: 0.12 };
const RERAISE_PRIOR: Record<Bin5, number> = { vweak: 0.05, weak: 0.09, mid: 0.16, strong: 0.32, vstrong: 0.55 };
/**
 * 额度桶的 Dirichlet 先验（总量 4.5 个伪样本）：普通人加注以小注居多。
 * **刻意与牌力无关** —— 「加得大 = 牌强」还是「加得大 = 诈唬」因人而异，
 * 没数据时凭空假设只会误读；所以在学到东西之前额度不构成任何读牌证据。
 */
const SIZE_PRIOR: [number, number, number] = [2, 1.5, 1];

export interface Beta {
  a: number;
  b: number;
}
export const rate = (x: Beta) => x.a / (x.a + x.b);
const hit = (x: Beta, ok: boolean, w = 1) => (ok ? (x.a += w) : (x.b += w));
export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const safeLog = (p: number) => Math.log(Math.max(p, 1e-9));

/** 一套记忆（单一衰减系数）学到的全部统计量。 */
export interface OppStats {
  /** 手持 UP+DOWN 时打出 DOWN 的概率，按他看到的我方指示灯分类。 */
  playDownWhenMixed: Record<Ctx, Beta>;
  /** 两张同类牌时先打出较强那张的概率（只统计能确认留牌身份的样本）。 */
  playStrongerSameCat: Beta;
  pairSamples: number;
  /** 三种情境下主动加注的概率，按他自认为的胜率分 5 档。 */
  agg: Record<AggCtx, Record<Bin5, Beta>>;
  /** 面对加注时弃牌的概率。 */
  foldToRaise: Record<Bin5, Beta>;
  /** 面对加注、没弃牌、还能再加注的前提下再加注的概率。 */
  reraise: Record<Bin5, Beta>;
  /** 加注额度落在小 / 中 / 大三桶的 Dirichlet 计数。 */
  raiseSize: Record<Bin5, [number, number, number]>;
  /** 加注幅度：(加注到 - 当前) / (上限 - 当前) 的平均。 */
  raiseFrac: { sum: number; n: number };
  /** 开司的下注决策样本数（已衰减）。 */
  nEff: number;
}

export interface OppModel extends OppStats {
  rounds: number;
  /** 快记忆（decayFast）单独的统计量。 */
  fast: OppStats;
  /** 慢记忆（decaySlow）单独的统计量。 */
  slow: OppStats;
  /** 快记忆在融合里的权重（按最近若干局的预测对数似然决定）。 */
  wFast: number;
  /** 快慢两套记忆的一致程度：1 = 完全一致（对手稳定），0 = 完全不同。 */
  stability: number;
  /** 对手模型可信度，阶段 B 用作「安全剥削」的权重。 */
  confidence: number;
}

// ---------- 分档 ----------

export function binOf(q: number): Bin {
  return q < 0.35 ? "weak" : q > 0.65 ? "strong" : "mid";
}

export function bin5Of(q: number): Bin5 {
  return q < 0.2 ? "vweak" : q < 0.4 ? "weak" : q < 0.6 ? "mid" : q < 0.8 ? "strong" : "vstrong";
}

/** 加注额度落在哪个桶：f = (加注到 − 当前) / (上限 − 当前)。 */
export function sizeBucketOf(from: number, raiseTo: number, M: number): SizeBucket {
  const span = M - from;
  if (span <= 0) return 2;
  const f = (raiseTo - from) / span;
  return f < 1 / 3 ? 0 : f < 2 / 3 ? 1 : 2;
}

/** 他这次动作属于哪种主动加注情境。 */
export function aggCtxOf(isFirstActionOfRound: boolean, heRaisedBefore: boolean): AggCtx {
  if (heRaisedBefore) return "barrel";
  return isFirstActionOfRound ? "openFirst" : "stabAfterBotCheck";
}

// ---------- 累加器（只存数据，先验在 finalize 时才加上） ----------

interface Acc {
  playDown: Record<Ctx, Beta>;
  playStronger: Beta;
  pairSamples: number;
  agg: Record<AggCtx, Record<Bin5, Beta>>;
  fold: Record<Bin5, Beta>;
  rer: Record<Bin5, Beta>;
  size: Record<Bin5, [number, number, number]>;
  raiseFrac: { sum: number; n: number };
  nEff: number;
}

const zeroBeta = (): Beta => ({ a: 0, b: 0 });
const zeroBins = (): Record<Bin5, Beta> => ({ vweak: zeroBeta(), weak: zeroBeta(), mid: zeroBeta(), strong: zeroBeta(), vstrong: zeroBeta() });

function newAcc(): Acc {
  return {
    playDown: { UP2: zeroBeta(), MIX: zeroBeta(), DOWN2: zeroBeta() },
    playStronger: zeroBeta(),
    pairSamples: 0,
    agg: { openFirst: zeroBins(), stabAfterBotCheck: zeroBins(), barrel: zeroBins() },
    fold: zeroBins(),
    rer: zeroBins(),
    size: { vweak: [0, 0, 0], weak: [0, 0, 0], mid: [0, 0, 0], strong: [0, 0, 0], vstrong: [0, 0, 0] },
    raiseFrac: { sum: 0, n: 0 },
    nEff: 0
  };
}

/** 时间衰减：把已有的全部样本权重乘以 f。先验不参与衰减，所以只作用在数据上。 */
function scaleAcc(x: Acc, f: number): void {
  if (f === 1) return;
  for (const c of CTXS) {
    x.playDown[c].a *= f;
    x.playDown[c].b *= f;
  }
  x.playStronger.a *= f;
  x.playStronger.b *= f;
  for (const ctx of AGG_CTXS) for (const b of BINS5) {
    x.agg[ctx][b].a *= f;
    x.agg[ctx][b].b *= f;
  }
  for (const b of BINS5) {
    x.fold[b].a *= f;
    x.fold[b].b *= f;
    x.rer[b].a *= f;
    x.rer[b].b *= f;
    for (let i = 0; i < 3; i += 1) x.size[b][i] *= f;
  }
  x.raiseFrac.sum *= f;
  x.raiseFrac.n *= f;
  x.nEff *= f;
}

const withPrior = (d: Beta, p: number, n: number): Beta => ({ a: d.a + p * n, b: d.b + (1 - p) * n });

/**
 * 5 档 Beta 加先验后再向 3 档粗粒度收缩：rate = (a + κ·rate_coarse) / (a + b + κ)。
 *
 * 粗粒度比率只用**真实数据**估计（不含先验），组内没有任何样本时才退回该档自己的先验
 * ——这样「完全没数据」时模型恰好等于先验，而「同组邻档有数据」时空档能借到力。
 * 返回的 Beta 已经把收缩后的比率烘进计数里，下游直接 rate() 即可。
 */
function shrinkBins(data: Record<Bin5, Beta>, prior: Record<Bin5, number>): Record<Bin5, Beta> {
  const coarseA: Record<Bin, number> = { weak: 0, mid: 0, strong: 0 };
  const coarseN: Record<Bin, number> = { weak: 0, mid: 0, strong: 0 };
  for (const b of BINS5) {
    const g = COARSE[b];
    coarseA[g] += data[b].a;
    coarseN[g] += data[b].a + data[b].b;
  }
  const k = MODEL_PARAMS.shrinkBin;
  const out = {} as Record<Bin5, Beta>;
  for (const b of BINS5) {
    const a = data[b].a + prior[b] * PRIOR_N;
    const n = data[b].a + data[b].b + PRIOR_N;
    const g = COARSE[b];
    const coarse = coarseN[g] > 0 ? coarseA[g] / coarseN[g] : prior[b];
    const r = (a + k * coarse) / (n + k);
    out[b] = { a: r * n, b: (1 - r) * n };
  }
  return out;
}

/** 额度桶的 Dirichlet：同样加先验后向 3 档收缩（粗粒度同样只由数据估计）。 */
function shrinkSizes(data: Record<Bin5, [number, number, number]>): Record<Bin5, [number, number, number]> {
  const coarse: Record<Bin, [number, number, number]> = { weak: [0, 0, 0], mid: [0, 0, 0], strong: [0, 0, 0] };
  for (const b of BINS5) {
    const g = COARSE[b];
    for (let i = 0; i < 3; i += 1) coarse[g][i] += data[b][i];
  }
  const k = MODEL_PARAMS.shrinkSize;
  const out = {} as Record<Bin5, [number, number, number]>;
  for (const b of BINS5) {
    const g = COARSE[b];
    const pr = SIZE_PRIOR;
    const prTotal = pr[0] + pr[1] + pr[2];
    const cTotal = coarse[g][0] + coarse[g][1] + coarse[g][2];
    const c = [0, 1, 2].map((i) => (cTotal > 0 ? coarse[g][i] / cTotal : pr[i] / prTotal));
    const n = data[b][0] + data[b][1] + data[b][2] + prTotal;
    const p = [0, 1, 2].map((i) => (data[b][i] + pr[i] + k * c[i]) / (n + k));
    out[b] = [p[0] * n, p[1] * n, p[2] * n];
  }
  return out;
}

function finalize(x: Acc): OppStats {
  const agg = {} as Record<AggCtx, Record<Bin5, Beta>>;
  for (const ctx of AGG_CTXS) agg[ctx] = shrinkBins(x.agg[ctx], AGG_PRIOR[ctx]);
  return {
    playDownWhenMixed: {
      UP2: withPrior(x.playDown.UP2, 0.6, 5),
      MIX: withPrior(x.playDown.MIX, 0.4, 5),
      DOWN2: withPrior(x.playDown.DOWN2, 0.3, 5)
    },
    playStrongerSameCat: withPrior(x.playStronger, 0.5, 4),
    pairSamples: x.pairSamples,
    agg,
    foldToRaise: shrinkBins(x.fold, FOLD_PRIOR),
    reraise: shrinkBins(x.rer, RERAISE_PRIOR),
    raiseSize: shrinkSizes(x.size),
    raiseFrac: { sum: x.raiseFrac.sum + 0.8, n: x.raiseFrac.n + 2 },
    nEff: x.nEff
  };
}

// ---------- 概率查询 ----------

/** 开司手持 {x, k} 时打出 x 的概率。 */
export function chooseProb(m: OppStats, x: number, k: number, ctx: Ctx): number {
  if (x === k) return 0.5;
  const cx = catOfRank(x);
  const ck = catOfRank(k);
  if (cx !== ck) {
    const pd = rate(m.playDownWhenMixed[ctx]);
    return cx === "DOWN" ? pd : 1 - pd;
  }
  const ps = rate(m.playStrongerSameCat);
  return cmpRank(x, k) > 0 ? ps : 1 - ps;
}

export function foldProb(m: OppStats, q: number, R: number, sOpp: number, LOpp: number): number {
  const bin = bin5Of(q);
  const l =
    logit(clamp01(rate(m.foldToRaise[bin]))) +
    SLOPE * (BIN5_CENTER[bin] - q) +
    (KAPPA * (R - sOpp)) / Math.max(1, LOpp) -
    (MU * (sOpp - 1)) / Math.max(1, R);
  return sigmoid(l);
}

/** 双方押注相同时，他在给定情境下主动加注的概率。 */
export function aggressionProb(m: OppStats, ctx: AggCtx, q: number): number {
  const bin = bin5Of(q);
  return sigmoid(logit(clamp01(rate(m.agg[ctx][bin]))) + SLOPE * (q - BIN5_CENTER[bin]));
}

export function reraiseProb(m: OppStats, q: number): number {
  const bin = bin5Of(q);
  return sigmoid(logit(clamp01(rate(m.reraise[bin]))) + SLOPE * (q - BIN5_CENTER[bin]));
}

/** 他拿自认胜率 q 的牌加注时，额度落在某个桶的概率。 */
export function sizeProb(m: OppStats, q: number, bucket: SizeBucket): number {
  const c = m.raiseSize[bin5Of(q)];
  const total = c[0] + c[1] + c[2];
  return total > 0 ? c[bucket] / total : 1 / 3;
}

/**
 * 他从 from 加注时的三个代表额度：最小、中码、全下。
 * 第 i 项对应第 i 个额度桶（桶的频率就是该额度的权重）；上限很近时会退化成同一个数，
 * 调用方按额度合并权重即可。
 */
export function raiseOptions(from: number, M: number): { to: number; bucket: SizeBucket }[] {
  if (from >= M) return [];
  const raw = [from + 1, Math.round((from + 1 + M) / 2), M];
  return raw.map((v, i) => ({ to: Math.min(M, Math.max(from + 1, v)), bucket: i as SizeBucket }));
}

/** 预计开司从当前押注 from 加注到多少（深层节点用的单一代表额）。 */
export function predictRaise(m: OppStats, from: number, M: number): number {
  const frac = m.raiseFrac.sum / m.raiseFrac.n;
  return Math.min(M, from + Math.max(1, Math.round(frac * (M - from))));
}

/** 对手模型的可信度：样本量越多、快慢记忆越一致就越可信。 */
export function opponentConfidence(m: { nEff: number; stability: number }): number {
  const { pMax, n0, p0 } = MODEL_PARAMS;
  return Math.max(p0, (pMax * m.nEff * m.stability) / (m.nEff + n0));
}

// ---------- 学习 ----------

/** 回放历史时用到的、每一局的下注上下文。 */
interface BetSample {
  /** 面对加注：他弃牌 / 跟注 / 再加注。 */
  facing: boolean;
  canRaise: boolean;
  type: string;
  bin: Bin5;
  q: number;
  ctx: AggCtx;
  /** 他面对的加注额（facing 时）。 */
  R: number;
  /** 他自己的押注。 */
  s: number;
  /** 他的命数。 */
  lives: number;
  /** 加注时的额度桶。 */
  bucket: SizeBucket | null;
  /** 加注幅度。 */
  frac: number | null;
}

/** 一次动作在给定模型下的预测对数似然。 */
function actionLogLik(m: OppStats, x: BetSample): number {
  if (x.facing) {
    const pf = foldProb(m, x.q, x.R, x.s, x.lives);
    const rr = x.canRaise ? reraiseProb(m, x.q) : 0;
    let p: number;
    if (x.type === "fold") p = pf;
    else if (x.type === "raise") p = (1 - pf) * rr;
    else p = (1 - pf) * (1 - rr);
    if (x.type === "raise" && x.bucket !== null) p *= sizeProb(m, x.q, x.bucket);
    return safeLog(p);
  }
  if (!x.canRaise) return 0;
  const pr = aggressionProb(m, x.ctx, x.q);
  let p = x.type === "raise" ? pr : 1 - pr;
  if (x.type === "raise" && x.bucket !== null) p *= sizeProb(m, x.q, x.bucket);
  return safeLog(p);
}

function addSample(x: Acc, s: BetSample, w: number): void {
  if (s.facing) {
    hit(x.fold[s.bin], s.type === "fold", w);
    if (s.type !== "fold" && s.canRaise) hit(x.rer[s.bin], s.type === "raise", w);
  } else if (s.canRaise) {
    hit(x.agg[s.ctx][s.bin], s.type === "raise", w);
  }
  if (s.bucket !== null) x.size[s.bin][s.bucket] += w;
  if (s.frac !== null) {
    x.raiseFrac.sum += w * s.frac;
    x.raiseFrac.n += w;
  }
  // 只有真正需要做决定的动作才算样本（押到上限时的「跟注」是被迫的）。
  if (s.facing || s.canRaise) x.nEff += w;
}

/**
 * 从历史里学出对手模型。
 *  - 不传 decay：同时训练快慢两套记忆并融合（正常用法）。
 *  - 传 decay：只训练这一套记忆（测试 / 对照用）。
 */
export function learnOpponent(view: BotView, decay?: number): OppModel {
  const decays = decay === undefined ? [MODEL_PARAMS.decayFast, MODEL_PARAMS.decaySlow] : [decay];
  const accs = decays.map(() => newAcc());
  const lls = decays.map(() => 0);
  const pools = historyPools(view);
  const recentFrom = view.history.length - MODEL_PARAMS.recentRounds;
  // 追踪开司留在手里的那张牌：类别，以及它被留下期间他打出过哪些牌。
  let held: { cat: Cat; plays: Card[] } | null = null;
  let prevRound: number | null = null;
  let lastRound = 0;

  view.history.forEach((r, i) => {
    const X = r.cards.player;
    if (!X) return;
    // 先把已有样本按经过的局数衰减，再加入本局样本 —— 这样任一时刻的模型都只含「该局之前」的信息。
    if (prevRound !== null) {
      const gap = Math.max(0, r.round - prevRound);
      for (let k = 0; k < accs.length; k += 1) scaleAcc(accs[k], Math.pow(decays[k], gap));
    }
    prevRound = r.round;
    lastRound = r.round;

    const L = r.lights.player;
    const ctx = ctxOf(r.lights.ai);
    const xCat = catOf(X);

    // ---- 选牌偏好 ----
    for (const acc of accs) if (L.up === 1 && L.down === 1) hit(acc.playDown[ctx], xCat === "DOWN", 1);
    if (!held) {
      held = { cat: otherCat(L, xCat), plays: [X] };
    } else {
      const newCat = otherCat(L, held.cat);
      if (newCat !== held.cat) {
        if (xCat === held.cat) {
          // 打出的正是留了几局的那张：身份确认，之前每次「宁可打别的也不打它」都是样本。
          for (const Y of held.plays) {
            if (catOf(Y) !== xCat) continue;
            const cmp = cmpRank(Y.rank, X.rank);
            if (cmp === 0) continue;
            for (const acc of accs) {
              hit(acc.playStronger, cmp > 0, 1);
              acc.pairSamples += 1;
            }
          }
          held = { cat: newCat, plays: [X] };
        } else {
          held.plays.push(X);
        }
      } else {
        // 新旧两张同类，分不清留下的是哪张：之前的留牌历史作废，
        // 但本局「打 X 而留另一张同类牌」本身是一次有效的同类取舍。
        held = { cat: held.cat, plays: [X] };
      }
    }

    // ---- 下注偏好 ----
    const before = livesBefore(r);
    const M = Math.min(before.player, before.ai);
    const st: Record<Side, number> = { player: 1, ai: 1 };
    const q = perceivedWin(X.rank, r.lights.ai, pools[i]);
    const bin = bin5Of(q);
    const samples: BetSample[] = [];
    let heRaised = false;
    r.actions.forEach((a, idx) => {
      const op = other(a.side);
      if (a.side === HUMAN) {
        const raiseTo = a.type === "raise" ? a.raiseTo ?? st[a.side] : null;
        samples.push({
          facing: st[op] > st[a.side],
          canRaise: st[op] < M,
          type: a.type,
          bin,
          q,
          ctx: aggCtxOf(idx === 0, heRaised),
          R: st[op],
          s: st[a.side],
          lives: before.player,
          bucket: raiseTo !== null ? sizeBucketOf(st[op], raiseTo, M) : null,
          frac: raiseTo !== null && M - st[op] > 0 ? (raiseTo - st[op]) / (M - st[op]) : null
        });
        if (a.type === "raise") heRaised = true;
      }
      if (a.type === "raise") st[a.side] = a.raiseTo ?? st[a.side];
      else if (a.type === "call") st[a.side] = st[op];
    });

    // 先预测（只用该局之前的历史）再计入，一次遍历就能得到两条 log-loss 曲线。
    if (i >= recentFrom && samples.length) {
      for (let k = 0; k < accs.length; k += 1) {
        const snapshot = finalize(accs[k]);
        for (const s of samples) lls[k] += actionLogLik(snapshot, s);
      }
    }
    for (let k = 0; k < accs.length; k += 1) for (const s of samples) addSample(accs[k], s, 1);
  });

  // 把权重锚回「当前局」：第 r 局的样本最终权重 = decay^(view.round − r − 1)，与 V1 一致。
  const tail = Math.max(0, view.round - lastRound - 1);
  for (let k = 0; k < accs.length; k += 1) scaleAcc(accs[k], Math.pow(decays[k], tail));

  const stats = accs.map(finalize);
  if (decays.length === 1) {
    const only = stats[0];
    return { ...only, rounds: view.history.length, fast: only, slow: only, wFast: 0, stability: 1, confidence: opponentConfidence({ nEff: only.nEff, stability: 1 }) };
  }
  const [fast, slow] = stats;
  const wFast = lls[0] === 0 && lls[1] === 0 ? 0 : sigmoid(MODEL_PARAMS.fusionGain * (lls[0] - lls[1]));
  const stability = stabilityOf(accs[1], fast, slow);
  const fused = fuse(fast, slow, wFast);
  return { ...fused, rounds: view.history.length, fast, slow, wFast, stability, confidence: opponentConfidence({ nEff: slow.nEff, stability }) };
}

/** 按比率融合两套记忆（样本量以慢记忆为准，快记忆的有效样本本来就少）。 */
function fuseBeta(f: Beta, s: Beta, w: number): Beta {
  const r = w * rate(f) + (1 - w) * rate(s);
  const n = s.a + s.b;
  return { a: r * n, b: (1 - r) * n };
}

function fuse(fast: OppStats, slow: OppStats, w: number): OppStats {
  const agg = {} as Record<AggCtx, Record<Bin5, Beta>>;
  for (const ctx of AGG_CTXS) {
    const rec = {} as Record<Bin5, Beta>;
    for (const b of BINS5) rec[b] = fuseBeta(fast.agg[ctx][b], slow.agg[ctx][b], w);
    agg[ctx] = rec;
  }
  const bins = (pick: (s: OppStats) => Record<Bin5, Beta>) => {
    const rec = {} as Record<Bin5, Beta>;
    for (const b of BINS5) rec[b] = fuseBeta(pick(fast)[b], pick(slow)[b], w);
    return rec;
  };
  const size = {} as Record<Bin5, [number, number, number]>;
  for (const b of BINS5) {
    const fc = fast.raiseSize[b];
    const sc = slow.raiseSize[b];
    const ft = fc[0] + fc[1] + fc[2];
    const stt = sc[0] + sc[1] + sc[2];
    const p = [0, 1, 2].map((i) => w * (ft > 0 ? fc[i] / ft : 1 / 3) + (1 - w) * (stt > 0 ? sc[i] / stt : 1 / 3));
    size[b] = [p[0] * stt, p[1] * stt, p[2] * stt];
  }
  const pd = {} as Record<Ctx, Beta>;
  for (const c of CTXS) pd[c] = fuseBeta(fast.playDownWhenMixed[c], slow.playDownWhenMixed[c], w);
  return {
    playDownWhenMixed: pd,
    playStrongerSameCat: fuseBeta(fast.playStrongerSameCat, slow.playStrongerSameCat, w),
    pairSamples: slow.pairSamples,
    agg,
    foldToRaise: bins((s) => s.foldToRaise),
    reraise: bins((s) => s.reraise),
    raiseSize: size,
    raiseFrac: {
      sum: (w * (fast.raiseFrac.sum / fast.raiseFrac.n) + (1 - w) * (slow.raiseFrac.sum / slow.raiseFrac.n)) * slow.raiseFrac.n,
      n: slow.raiseFrac.n
    },
    nEff: slow.nEff
  };
}

/** 稳定度：只看有 ≥2 个真实样本的格子上快慢两套记忆的比率差。 */
function stabilityOf(slowAcc: Acc, fast: OppStats, slow: OppStats): number {
  let sum = 0;
  let n = 0;
  const cell = (data: Beta, f: Beta, s: Beta) => {
    if (data.a + data.b < 2) return;
    sum += Math.abs(rate(f) - rate(s));
    n += 1;
  };
  for (const ctx of AGG_CTXS) for (const b of BINS5) cell(slowAcc.agg[ctx][b], fast.agg[ctx][b], slow.agg[ctx][b]);
  for (const b of BINS5) {
    cell(slowAcc.fold[b], fast.foldToRaise[b], slow.foldToRaise[b]);
    cell(slowAcc.rer[b], fast.reraise[b], slow.reraise[b]);
  }
  for (const c of CTXS) cell(slowAcc.playDown[c], fast.playDownWhenMixed[c], slow.playDownWhenMixed[c]);
  cell(slowAcc.playStronger, fast.playStrongerSameCat, slow.playStrongerSameCat);
  if (n === 0) return 1;
  return 1 - Math.min(1, Math.max(0, sum / n));
}
