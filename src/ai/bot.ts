/**
 * 内置算法机器人（不用大模型的和也）。
 *
 * 只使用公开信息决策：自己的手牌、双方指示灯、本局下注过程、历史开牌记录、
 * 弃牌堆（所有打出的牌都翻开过）、牌堆重洗的时刻。绝不读取开司的手牌、牌堆顺序或被切掉的牌。
 *
 * 决策分三层：
 *  1. 记牌：当前牌靴（3 副牌，或重洗后的弃牌堆）减去已翻开的牌和自己的牌 = 未知牌池。
 *  2. 读牌：对开司「留在手里那张牌」做贝叶斯滤波——每局按他的出牌偏好和当时的牌池更新后验；
 *     再结合本局他的下注行为（主动加注 / 弃牌 / 跟注的倾向）修正他打出的牌的分布。
 *     偏好全部从对局历史中统计（带先验、随时间衰减的 Beta 计数），越打越了解对手。
 *  3. 算账：在下注树上做有限深度的期望值搜索——我加注后他弃 / 跟 / 再加注，跟注之后还能继续加注……
 *     效用是「赢下整场的概率」而非命数，所以领先时不为微小优势梭哈、落后时敢搏。
 *     选牌时按本局每种结局分别折算下一局：输光了就没有下一局，赢了下一局先手也不同。
 */
import { type Card, cardLabel, createDeck, isUp, RANK_LABEL, type Rng } from "../game/cards.js";
import {
  type BetAction,
  type BetInput,
  type GameState,
  type LegalBets,
  type Lights,
  type RoundRecord,
  type Side,
  legalBets,
  lightsOf,
  other
} from "../game/engine.js";

const AI: Side = "ai";
const HUMAN: Side = "player";

export type Cat = "UP" | "DOWN";
/** 开司看到的我方指示灯类型：决定他怎么选牌 / 怎么估自己的胜率。 */
export type Ctx = "UP2" | "MIX" | "DOWN2";
/** 开司自认为的胜率分档。 */
export type Bin = "weak" | "mid" | "strong";

export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const CATS: Cat[] = ["UP", "DOWN"];
const catOfRank = (r: number): Cat => (r >= 8 ? "UP" : "DOWN");
const catOf = (c: Card): Cat => (isUp(c) ? "UP" : "DOWN");

// ---------- 可调参数 ----------

/** 加注额占对方命数的比例越大，对方越可能弃牌（logit 斜率）。 */
const KAPPA = 1.5;
/** 对方已押注越多越不愿弃牌。 */
const MU = 1.2;
/** 同一档内按胜率微调（logit 斜率）。 */
const SLOPE = 3;
/**
 * 效用曲线（赌徒破产模型）：效用 = 从当前命数出发最终赢下整场的概率。
 *  matchEdge：在 12 对 12 的参考局里，双方命数相等时我们自认为赢下整场的概率。越高越厌恶波动。
 *  edgeScaling：命数总量变化时曲线弯曲程度怎么变。0 = 与总量无关（60 对 60 和 12 对 12 态度一致）；
 *    1 = 每一命的折算比例固定（总量越大越谨慎，因为剩下的局数越多、越值得靠每局的小优势磨）。
 * 实测（见 CHANGELOG）：机器人每局有真实优势，所以较强的谨慎在各种命数下都更能赢。
 */
export const PARAMS = { matchEdge: 0.9, edgeScaling: 1 };
const REF_T = 24;
const rho = (T: number) => Math.pow(Math.pow((1 - PARAMS.matchEdge) / PARAMS.matchEdge, 2), Math.pow(T / REF_T, PARAMS.edgeScaling));
/** 留牌的未来价值折扣（下一局未必真按估计打出去）。 */
const GAMMA = 0.7;
/** 动作选择的 softmax 温度（单位：命，按当前效用斜率换算）。 */
const TEMP = 0.2;
/** 只在与最优动作 EV 相差不超过此值（单位：命）的动作之间随机。 */
const MIX_MARGIN = 0.35;
/** 对手模型的记忆衰减：每过一局，旧样本的权重乘以该系数（半衰期约 23 局）。 */
const DECAY = 0.97;
/** 下注树搜索深度：双方合计还能有几次加注被纳入考虑。 */
const DEPTH = 3;
/** 估算下一局（留牌价值）时用的深度。 */
const DEPTH_FUTURE = 1;

const BIN_CENTER: Record<Bin, number> = { weak: 0.17, mid: 0.5, strong: 0.83 };

/** One Poker 比大小（只看点数）：1 = a 胜，-1 = b 胜，0 = 平。唯一例外：2 克 A。 */
export function cmpRank(a: number, b: number): -1 | 0 | 1 {
  if (a === b) return 0;
  if (a === 2 && b === 14) return 1;
  if (a === 14 && b === 2) return -1;
  return a > b ? 1 : -1;
}

// ---------- 公开信息视图 ----------

export interface BotView {
  round: number;
  decks: number;
  firstMover: Side;
  lives: Record<Side, number>;
  stakes: Record<Side, number>;
  maxStake: number;
  /** 和也尚未打出的手牌。 */
  hand: Card[];
  /** 和也本局已盖出的牌。 */
  chosen: Card | null;
  /** 双方指示灯（含已盖出的牌，即对方看到的样子）。 */
  lights: Record<Side, Lights>;
  actions: BetAction[];
  history: RoundRecord[];
  /** 弃牌堆：自上次重洗以来所有翻开过的牌，人人可见。 */
  discard: Card[];
  /** 牌堆重洗发生在哪几局的发牌时（重洗的正是当时的弃牌堆，所以牌靴组成是公开的）。 */
  reshuffles: number[];
  legal: LegalBets;
}

function lightsWithChosen(p: GameState["players"][Side]): Lights {
  const l = lightsOf(p);
  if (p.chosen) (isUp(p.chosen) ? (l.up += 1) : (l.down += 1));
  return l;
}

/** 从完整对局状态里只抽出和也有权知道的部分。 */
export function publicView(state: GameState): BotView {
  const me = state.players[AI];
  const opp = state.players[HUMAN];
  return {
    round: state.round,
    decks: state.decks,
    firstMover: state.firstMover,
    lives: { ai: me.lives, player: opp.lives },
    stakes: { ai: me.stake, player: opp.stake },
    maxStake: state.maxStake,
    hand: me.hand.slice(),
    chosen: me.chosen,
    lights: { ai: lightsWithChosen(me), player: lightsWithChosen(opp) },
    actions: state.actions.slice(),
    history: state.history,
    discard: state.discard,
    reshuffles: state.reshuffles ?? [],
    legal: legalBets(state, AI)
  };
}

// ---------- 记牌 ----------

const zeros = () => new Array<number>(15).fill(0);

/** 当前牌靴里有哪些牌（按 id）。首次重洗前返回 null：整副牌（含被切掉的未知部分）。 */
function shoeIds(view: BotView): Set<string> | null {
  const rs = view.reshuffles;
  if (rs.length === 0) return null;
  const last = rs[rs.length - 1];
  const prev = rs.length > 1 ? rs[rs.length - 2] : 0;
  const ids = new Set<string>();
  for (const r of view.history) {
    if (r.round < prev || r.round >= last) continue;
    if (r.cards.player) ids.add(r.cards.player.id);
    if (r.cards.ai) ids.add(r.cards.ai.id);
  }
  return ids;
}

function countUnknown(view: BotView, shoe: Set<string> | null): number[] {
  const known = new Set<string>();
  for (const c of view.discard) known.add(c.id);
  for (const c of view.hand) known.add(c.id);
  if (view.chosen) known.add(view.chosen.id);
  const pool = zeros();
  for (const c of createDeck(view.decks)) {
    if (shoe && !shoe.has(c.id)) continue;
    if (known.has(c.id)) continue;
    pool[c.rank] += 1;
  }
  return pool;
}

/** 牌堆里可能出现的未知牌（新发的牌从这里来），下标 = 点数。 */
export function unknownPool(view: BotView): number[] {
  return countUnknown(view, shoeIds(view));
}

/** 所有位置不明的牌：牌堆、切牌区或开司手里（重洗前留在他手里的牌不在当前牌靴里）。 */
export function unknownAnywhere(view: BotView): number[] {
  return countUnknown(view, null);
}

/** 整副牌的点数分布（不记牌时的先验）。 */
function genericPool(decks: number): number[] {
  const pool = zeros();
  for (const r of RANKS) pool[r] = 4 * decks;
  return pool;
}

/** 历史上每一局发牌前的未知牌池（近似：忽略当时我手里的牌），用于回放式读牌。 */
function historyPools(view: BotView): number[][] {
  const reshuffled = new Set(view.reshuffles);
  let pool = genericPool(view.decks);
  let since = zeros();
  const out: number[][] = [];
  for (const r of view.history) {
    if (reshuffled.has(r.round)) {
      pool = since;
      since = zeros();
    }
    out.push(pool.slice());
    for (const c of [r.cards.player, r.cards.ai]) {
      if (!c) continue;
      pool[c.rank] = Math.max(0, pool[c.rank] - 1);
      since[c.rank] += 1;
    }
  }
  return out;
}

function normalize(d: number[]): number[] {
  let s = 0;
  for (const v of d) s += v;
  if (!(s > 0)) return d;
  return d.map((v) => v / s);
}

/** 某一类别内按牌池张数的分布；该类已无未知牌时退化为均匀分布。 */
function catDist(pool: number[], cat: Cat): number[] {
  const d = zeros();
  let s = 0;
  for (const r of RANKS) if (catOfRank(r) === cat) s += pool[r];
  for (const r of RANKS) if (catOfRank(r) === cat) d[r] = s > 0 ? pool[r] / s : 1 / 6;
  return normalize(d);
}

function ctxOf(l: Lights): Ctx {
  return l.up === 2 ? "UP2" : l.down === 2 ? "DOWN2" : "MIX";
}

/** 指示灯对应的两张牌类别。 */
function catsOf(l: Lights): [Cat, Cat] {
  return l.up === 2 ? ["UP", "UP"] : l.down === 2 ? ["DOWN", "DOWN"] : ["UP", "DOWN"];
}

/** 已知一张的类别，由指示灯推出另一张的类别。 */
function otherCat(l: Lights, known: Cat): Cat {
  if (l.up === 2) return "UP";
  if (l.down === 2) return "DOWN";
  return known === "UP" ? "DOWN" : "UP";
}

/**
 * 开司视角：拿点数 c 对上我的指示灯时他自认为的胜率（平局算半个）。
 * 他不知道我打出的是哪张，按灯的 UP/DOWN 比例猜；类别内按牌池分布。
 */
export function perceivedWin(c: number, myLights: Lights, poolTheirs: number[]): number {
  const total = myLights.up + myLights.down || 1;
  let q = 0;
  for (const cat of CATS) {
    const w = (cat === "UP" ? myLights.up : myLights.down) / total;
    if (!w) continue;
    const d = catDist(poolTheirs, cat);
    let win = 0;
    for (const k of RANKS) {
      if (!d[k]) continue;
      const cmp = cmpRank(c, k);
      if (cmp > 0) win += d[k];
      else if (cmp === 0) win += d[k] / 2;
    }
    q += w * win;
  }
  return q;
}

function binOf(q: number): Bin {
  return q < 0.35 ? "weak" : q > 0.65 ? "strong" : "mid";
}

// ---------- 对手模型（从历史统计） ----------

export interface Beta {
  a: number;
  b: number;
}
const rate = (x: Beta) => x.a / (x.a + x.b);
const hit = (x: Beta, ok: boolean, w = 1) => (ok ? (x.a += w) : (x.b += w));
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface OppModel {
  rounds: number;
  /** 手持 UP+DOWN 时打出 DOWN 的概率，按他看到的我方指示灯分类。 */
  playDownWhenMixed: Record<Ctx, Beta>;
  /** 两张同类牌时先打出较强那张的概率（只统计能确认留牌身份的样本）。 */
  playStrongerSameCat: Beta;
  pairSamples: number;
  /** 有机会主动加注（先手、或我过牌之后）时加注的概率，按他自认为的胜率分档。 */
  raiseOpen: Record<Bin, Beta>;
  /** 他加注、我跟注之后，他继续加注（连续开火）的概率。 */
  barrel: Record<Bin, Beta>;
  /** 面对加注时弃牌的概率。 */
  foldToRaise: Record<Bin, Beta>;
  /** 面对加注、没弃牌、还能再加注的前提下再加注的概率。 */
  reraise: Record<Bin, Beta>;
  /** 加注幅度：(加注到 - 当前) / (上限 - 当前) 的平均。 */
  raiseFrac: { sum: number; n: number };
}

function livesBefore(r: RoundRecord): Record<Side, number> {
  const p = r.livesAfter.player + (r.result === "ai" ? r.livesMoved : r.result === "player" ? -r.livesMoved : 0);
  const a = r.livesAfter.ai + (r.result === "player" ? r.livesMoved : r.result === "ai" ? -r.livesMoved : 0);
  return { player: p, ai: a };
}

export function learnOpponent(view: BotView): OppModel {
  const m: OppModel = {
    rounds: view.history.length,
    playDownWhenMixed: { UP2: { a: 3, b: 2 }, MIX: { a: 2, b: 3 }, DOWN2: { a: 1.5, b: 3.5 } },
    playStrongerSameCat: { a: 2, b: 2 },
    pairSamples: 0,
    raiseOpen: { weak: { a: 1, b: 5 }, mid: { a: 2, b: 3 }, strong: { a: 4, b: 2 } },
    barrel: { weak: { a: 1, b: 11 }, mid: { a: 1, b: 4 }, strong: { a: 2, b: 2 } },
    foldToRaise: { weak: { a: 5, b: 2 }, mid: { a: 2, b: 3 }, strong: { a: 1, b: 7 } },
    reraise: { weak: { a: 1, b: 9 }, mid: { a: 1, b: 6 }, strong: { a: 3, b: 4 } },
    raiseFrac: { sum: 0.8, n: 2 }
  };
  const pools = historyPools(view);
  // 追踪开司留在手里的那张牌：类别，以及它被留下期间他打出过哪些牌。
  let held: { cat: Cat; plays: Card[] } | null = null;
  view.history.forEach((r, i) => {
    const X = r.cards.player;
    if (!X) return;
    // 越久远的样本权重越低。
    const w = Math.pow(DECAY, Math.max(0, view.round - r.round - 1));
    const L = r.lights.player;
    const ctx = ctxOf(r.lights.ai);
    const xCat = catOf(X);

    // ---- 选牌偏好 ----
    if (L.up === 1 && L.down === 1) hit(m.playDownWhenMixed[ctx], xCat === "DOWN", w);
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
            hit(m.playStrongerSameCat, cmp > 0, w);
            m.pairSamples += 1;
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
    const bin = binOf(q);
    let heRaised = false;
    for (const a of r.actions) {
      const op = other(a.side);
      const facing = st[op] > st[a.side];
      const canRaise = st[op] < M;
      if (a.side === HUMAN) {
        if (facing) {
          hit(m.foldToRaise[bin], a.type === "fold", w);
          if (a.type !== "fold" && canRaise) hit(m.reraise[bin], a.type === "raise", w);
        } else if (canRaise) {
          hit(heRaised ? m.barrel[bin] : m.raiseOpen[bin], a.type === "raise", w);
        }
        if (a.type === "raise") heRaised = true;
        if (a.type === "raise" && a.raiseTo != null && M - st[op] > 0) {
          m.raiseFrac.sum += (w * (a.raiseTo - st[op])) / (M - st[op]);
          m.raiseFrac.n += w;
        }
      }
      if (a.type === "raise") st[a.side] = a.raiseTo ?? st[a.side];
      else if (a.type === "call") st[a.side] = st[op];
    }
  });
  return m;
}

/** 开司手持 {x, k} 时打出 x 的概率。 */
function chooseProb(m: OppModel, x: number, k: number, ctx: Ctx): number {
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

function foldProb(m: OppModel, q: number, R: number, sOpp: number, LOpp: number): number {
  const bin = binOf(q);
  const l =
    logit(rate(m.foldToRaise[bin])) +
    SLOPE * (BIN_CENTER[bin] - q) +
    (KAPPA * (R - sOpp)) / Math.max(1, LOpp) -
    (MU * (sOpp - 1)) / Math.max(1, R);
  return sigmoid(l);
}

function raiseOpenProb(m: OppModel, q: number): number {
  const bin = binOf(q);
  return sigmoid(logit(rate(m.raiseOpen[bin])) + SLOPE * (q - BIN_CENTER[bin]));
}

/** 他加注被我跟注后再次加注的概率。 */
function barrelProb(m: OppModel, q: number): number {
  const bin = binOf(q);
  return sigmoid(logit(rate(m.barrel[bin])) + SLOPE * (q - BIN_CENTER[bin]));
}

function reraiseProb(m: OppModel, q: number): number {
  const bin = binOf(q);
  return sigmoid(logit(rate(m.reraise[bin])) + SLOPE * (q - BIN_CENTER[bin]));
}

/** 预计开司从当前押注 from 加注到多少。 */
function predictRaise(m: OppModel, from: number, M: number): number {
  const frac = m.raiseFrac.sum / m.raiseFrac.n;
  return Math.min(M, from + Math.max(1, Math.round(frac * (M - from))));
}

// ---------- 读牌 ----------

/**
 * 对开司「留在手里那张牌」的点数做贝叶斯滤波。
 * 每局：他手里是旧牌 h（后验 B）和新牌 n（按类别在当时的牌池分布），打出了 X，则留下的牌 k 满足
 *   B'(k) ∝ P(打 X 而不打 k) · [ B(k)·U(X) + B(X)·U(k) ]
 * 两项分别对应「打出新牌、留下旧牌」和「打出旧牌、留下新牌」，同类时自动混合。
 */
function heldBelief(view: BotView, m: OppModel): { B: number[] | null; heldCat: Cat | null; since: number } {
  const pools = historyPools(view);
  let B: number[] | null = null;
  let heldCat: Cat | null = null;
  let since = 1;
  view.history.forEach((r, i) => {
    const X = r.cards.player;
    if (!X) return;
    const pool = pools[i];
    const L = r.lights.player;
    const ctx = ctxOf(r.lights.ai);
    let newCat: Cat;
    if (!B || !heldCat) {
      const [c1, c2] = catsOf(L);
      heldCat = c1;
      newCat = c2;
      B = catDist(pool, c1);
    } else {
      newCat = otherCat(L, heldCat);
    }
    const U = catDist(pool, newCat);
    const next = zeros();
    let oldW = 0;
    let newW = 0;
    for (const k of RANKS) {
      const pc = chooseProb(m, X.rank, k, ctx);
      const wOld = B[k] * U[X.rank];
      const wNew = B[X.rank] * U[k];
      next[k] = pc * (wOld + wNew);
      oldW += pc * wOld;
      newW += pc * wNew;
    }
    const keptCat = otherCat(L, catOf(X));
    const sum = oldW + newW;
    B = sum > 0 ? next.map((v) => v / sum) : catDist(pool, keptCat);
    heldCat = keptCat;
    if (newW >= oldW) since = r.round;
  });
  return { B, heldCat, since };
}

export interface Analysis {
  /** 牌堆里的未知牌（新牌从这里来）。 */
  pool: number[];
  /** 所有位置不明的牌。 */
  unknown: number[];
  model: OppModel;
  ctx: Ctx;
  heldCat: Cat;
  newCat: Cat;
  /** 留牌的点数后验。 */
  held: number[];
  /** 留牌自第几局起在他手里。 */
  heldSince: number;
  /** 本局开司打出的牌的点数分布（只看选牌偏好）。 */
  played: number[];
  /** 本局他留下（下一局手里）的牌的点数分布。 */
  kept: number[];
  /** 再按本局他的下注行为修正后的分布。 */
  posterior: number[];
  /** 开司拿每个点数时自认为的胜率。 */
  q: number[];
}

/** 把后验限制在还可能存在的点数上。 */
function restrictToPool(B: number[], pool: number[], cat: Cat): number[] {
  const d = B.map((v, r) => (pool[r] > 0 ? v : 0));
  let s = 0;
  for (const v of d) s += v;
  return s > 0 ? d.map((v) => v / s) : catDist(pool, cat);
}

export function analyze(view: BotView): Analysis {
  const pool = unknownPool(view);
  const unknown = unknownAnywhere(view);
  const model = learnOpponent(view);
  const ctx = ctxOf(view.lights.ai);
  const L = view.lights.player;
  const hb = heldBelief(view, model);
  let heldCat: Cat;
  let newCat: Cat;
  let H: number[];
  let heldSince = hb.since;
  const consistent = hb.B && hb.heldCat && (hb.heldCat === "UP" ? L.up >= 1 : L.down >= 1);
  if (consistent && hb.B && hb.heldCat) {
    heldCat = hb.heldCat;
    newCat = otherCat(L, heldCat);
    H = restrictToPool(hb.B, unknown, heldCat);
  } else {
    [heldCat, newCat] = catsOf(L);
    H = catDist(pool, heldCat);
    heldSince = view.round;
  }
  const U = catDist(pool, newCat);
  const played = zeros();
  const kept = zeros();
  for (const h of RANKS) {
    if (!H[h]) continue;
    for (const n of RANKS) {
      const w = H[h] * U[n];
      if (!w) continue;
      const p = chooseProb(model, h, n, ctx);
      played[h] += w * p;
      kept[n] += w * p;
      played[n] += w * (1 - p);
      kept[h] += w * (1 - p);
    }
  }
  // 开司视角的牌池：他不知道我的牌，所以我的牌对他而言也是未知的。
  const theirs = pool.slice();
  for (const c of view.hand) theirs[c.rank] += 1;
  if (view.chosen) theirs[view.chosen.rank] += 1;
  const q = zeros();
  for (const c of RANKS) q[c] = perceivedWin(c, view.lights.ai, theirs);

  // 本局下注行为作为证据
  const posterior = played.slice();
  const st: Record<Side, number> = { player: 1, ai: 1 };
  const M = view.maxStake;
  let heRaised = false;
  for (const a of view.actions) {
    const op = other(a.side);
    if (a.side === HUMAN) {
      const facing = st[op] > st[a.side];
      const canRaise = st[op] < M;
      for (const c of RANKS) {
        if (!posterior[c]) continue;
        let lik = 1;
        if (facing) {
          const pf = foldProb(model, q[c], st[op], st[a.side], view.lives.player);
          const rr = canRaise ? reraiseProb(model, q[c]) : 0;
          if (a.type === "fold") lik = pf;
          else if (a.type === "raise") lik = (1 - pf) * rr;
          else lik = (1 - pf) * (1 - rr);
        } else if (canRaise) {
          const pr = heRaised ? barrelProb(model, q[c]) : raiseOpenProb(model, q[c]);
          lik = a.type === "raise" ? pr : 1 - pr;
        }
        posterior[c] *= Math.max(lik, 1e-6);
      }
      if (a.type === "raise") heRaised = true;
    }
    if (a.type === "raise") st[a.side] = a.raiseTo ?? st[a.side];
    else if (a.type === "call") st[a.side] = st[op];
  }
  return {
    pool,
    unknown,
    model,
    ctx,
    heldCat,
    newCat,
    held: H,
    heldSince,
    played: normalize(played),
    kept: normalize(kept),
    posterior: normalize(posterior),
    q
  };
}

// ---------- 效用 ----------

/** 持有 L 命（总共 T 命）时最终赢下整场的概率。 */
export function matchWinProb(L: number, T: number): number {
  if (L <= 0) return 0;
  if (L >= T) return 1;
  const r = rho(T);
  return (1 - Math.pow(r, L / T)) / (1 - r);
}

/** 命数变化 delta 带来的效用变化：以「赢下整场的概率」计。 */
function u(delta: number, LMe: number, T: number): number {
  return matchWinProb(LMe + delta, T) - matchWinProb(LMe, T);
}

/** 当前局面下 1 命大约值多少效用，用来把以命为单位的参数换算成效用。 */
function unitUtility(LMe: number, T: number): number {
  return Math.max(1e-6, (matchWinProb(LMe + 1, T) - matchWinProb(LMe - 1, T)) / 2);
}

// ---------- 下注树 ----------

interface Spot {
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

function makeSpot(myRank: number, q: number[], model: OppModel, M: number, LOpp: number, val: (d: number) => number, top: number): Spot {
  const o = zeros();
  for (const c of RANKS) o[c] = cmpRank(myRank, c);
  return { o, q, model, M, LOpp, val, top };
}

function outcomes(D: number[], o: number[]): { win: number; lose: number; draw: number } {
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

function showdown(D: number[], spot: Spot, S: number): number {
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

/** 我加注到 R（对方已押 sOpp）后对方的响应：弃牌 / 跟注 / 再加注。 */
function hisResponse(D: number[], spot: Spot, R: number, sOpp: number, depth: number): { ev: number; fold: number } {
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
    const rr = condition(D, (c) => prr[c]);
    if (rr.mass > 0) ev += rr.mass * myFacing(rr.D, spot, R, predictRaise(model, R, M), depth - 1).ev;
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
function afterMyCall(D: number[], spot: Spot, S: number, depth: number): number {
  if (S >= spot.M) return showdown(D, spot, S);
  return hisTurn(D, spot, S, depth, "barrel");
}

/**
 * 对方在双方押注相同（S）时行动：加注（我再应对）或过牌。
 *  open：他是本局第一个行动的人，过牌后轮到我；
 *  afterCheck：我过牌给他，他过牌即开牌；
 *  barrel：他的加注被我跟注，他继续加注或过牌开牌。
 */
function hisTurn(D: number[], spot: Spot, S: number, depth: number, mode: "open" | "afterCheck" | "barrel"): number {
  const { q, model, M } = spot;
  if (S >= M || depth < 0) return showdown(D, spot, S);
  const pr = zeros();
  for (const c of RANKS) pr[c] = mode === "barrel" ? barrelProb(model, q[c]) : raiseOpenProb(model, q[c]);
  const Rp = predictRaise(model, S, M);
  const raise = condition(D, (c) => pr[c]);
  const check = condition(D, (c) => 1 - pr[c]);
  let ev = 0;
  if (raise.mass > 0) ev += raise.mass * myFacing(raise.D, spot, S, Rp, depth - 1).ev;
  if (check.mass > 0) ev += check.mass * (mode === "open" ? myClosing(check.D, spot, S, depth) : showdown(check.D, spot, S));
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
  let best = hisTurn(D, spot, S, depth, "afterCheck");
  if (depth > 0) for (const R of raiseSizes(spot, S, depth)) best = Math.max(best, hisResponse(D, spot, R, S, depth - 1).ev);
  return best;
}

/** 一局从下注开始算起的期望（双方各押 1 命，尚无动作）。 */
function roundEV(D: number[], spot: Spot, iAmFirst: boolean, depth: number): number {
  return iAmFirst ? myOpening(D, spot, 1, depth) : hisTurn(D, spot, 1, depth, "open");
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
type FutureCache = Map<string, number>;

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
function makeVal(view: BotView, A: Analysis, K: Card | null, cache: FutureCache): (d: number) => number {
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

// ---------- 台词 ----------

const LINES = {
  selectStrong: ["クク……置いたぞ。", "……この一枚で十分だ。", "ざわ……さあ、乗ってこい。"],
  selectNeutral: ["さあ、始めようか。", "……出せ。お前の牌を。", "早く決めろ、カイジ。"],
  selectWeak: ["フン……好きに読め。", "……退屈だな。", "ククク……賭けてみるか？"],
  checkOpen: ["チェック。", "……様子見だ。", "急ぐ必要はない。チェック。"],
  checkClose: ["……開けろ。", "ここまでだ。開牌。", "見せてもらおう、お前の牌を。"],
  call: ["コール。見せてもらおうか、お前の牌を。", "……乗ってやる。コール。", "コール。逃げはしない。"],
  raiseValue: (n: number) => [`レイズ。${n} 命だ。`, `${n} 命……付いてこれるか？`, `クク……${n} 命だ。`],
  raiseBluff: (n: number) => [`……${n} 命。降りるなら今だぞ。`, `${n} 命。お前の覚悟を見せてみろ。`, `ざわ……${n} 命だ。`],
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

function modelText(m: OppModel): string {
  const pd = m.playDownWhenMixed;
  return [
    `【对手模型】已观察 ${m.rounds} 局（越近的局权重越高）。`,
    `持 UP+DOWN 时出 DOWN：我灯 UP2 ${betaText(pd.UP2)} · 混合 ${betaText(pd.MIX)} · DOWN2 ${betaText(pd.DOWN2)}；同类牌先出强牌 ${betaText(m.playStrongerSameCat)}（${m.pairSamples} 个样本）。`,
    `主动加注 弱${betaText(m.raiseOpen.weak)}/中${betaText(m.raiseOpen.mid)}/强${betaText(m.raiseOpen.strong)}；被跟注后继续加注 弱${betaText(m.barrel.weak)}/中${betaText(m.barrel.mid)}/强${betaText(m.barrel.strong)}；面对加注弃牌 弱${betaText(m.foldToRaise.weak)}/中${betaText(m.foldToRaise.mid)}/强${betaText(m.foldToRaise.strong)}；再加注 弱${betaText(m.reraise.weak)}/中${betaText(m.reraise.mid)}/强${betaText(m.reraise.strong)}；加注幅度约 ${pct(m.raiseFrac.sum / m.raiseFrac.n)}。`
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

export function botSelect(view: BotView, rng: Rng = Math.random): BotDecision {
  const A = analyze(view);
  const hand = view.hand;
  if (hand.length === 1) {
    return { kind: "select", cardId: hand[0].id, say: pickLine(LINES.selectNeutral, rng), reasoning: "只剩一张牌，没有选择。" };
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
  const cache: FutureCache = new Map();
  const cands = hand.map((card, i) => {
    const keep = hand[1 - i];
    const valNow = (d: number) => u(d, LMe, T);
    const now = makeSpot(card.rank, A.q, A.model, M, LOpp, valNow, DEPTH);
    const evNow = roundEV(A.played, now, iAmFirst, DEPTH);
    const full = makeSpot(card.rank, A.q, A.model, M, LOpp, makeVal(view, A, keep, cache), DEPTH);
    const ev = roundEV(A.played, full, iAmFirst, DEPTH);
    const oc = outcomes(A.played, now.o);
    lines.push(
      `${cardLabel(card)}：本局胜 ${pct(oc.win)} / 平 ${pct(oc.draw)} / 负 ${pct(oc.lose)} → 本局 EV ${inLives(evNow, unit)} 命；留 ${cardLabel(keep)} 对下一局的增益 ${inLives(ev - evNow, unit)} → 合计 ${inLives(ev, unit)}`
    );
    return { card, keep, ev, win: oc.win };
  });
  const pick = softmaxPick(cands, rng, unit, TEMP, 0.25, 2);
  lines.push(`【决定】打出 ${cardLabel(pick.card)}，留 ${cardLabel(pick.keep)}。`);
  const say = pickLine(pick.win >= 0.75 ? LINES.selectStrong : pick.win <= 0.35 ? LINES.selectWeak : LINES.selectNeutral, rng);
  return { kind: "select", cardId: pick.card.id, say, reasoning: lines.join("\n") };
}

interface BetCand {
  bet: BetInput;
  ev: number;
  label: string;
  fold?: number;
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
  const spot = makeSpot(mine.rank, A.q, A.model, M, view.lives.player, makeVal(view, A, keep, new Map()), DEPTH);
  const D = A.posterior;
  const oc = outcomes(D, spot.o);
  const opening = view.actions.length === 0;
  const cands: BetCand[] = [];
  if (legal.canCheck) {
    cands.push({ bet: { type: "check" }, ev: opening ? hisTurn(D, spot, sMe, DEPTH, "afterCheck") : showdown(D, spot, sMe), label: opening ? "过牌（看开司动作）" : "过牌开牌" });
  }
  if (legal.canCall) cands.push({ bet: { type: "call" }, ev: afterMyCall(D, spot, sOpp, DEPTH), label: `跟注至 ${sOpp}` });
  if (legal.canFold) cands.push({ bet: { type: "fold" }, ev: spot.val(-sMe), label: "弃牌" });
  if (legal.canRaise) {
    for (let R = legal.minRaiseTo; R <= legal.maxRaiseTo; R += 1) {
      const { ev, fold } = hisResponse(D, spot, R, sOpp, DEPTH - 1);
      cands.push({ bet: { type: "raise", raiseTo: R }, ev, fold, label: R === M ? `全下 ${R}` : `加注至 ${R}` });
    }
  }
  const unit = unitUtility(view.lives.ai, view.lives.ai + view.lives.player);
  const pick = softmaxPick(cands, rng, unit);

  const acts = view.actions.map((a) => `${a.side === AI ? "我" : "开司"} ${a.type}${a.type === "raise" ? `→${a.raiseTo}` : ""}`).join("，") || "无";
  const lines = [
    modelText(A.model),
    `【局面】我打出 ${cardLabel(mine)}（我灯 ${lightsText(view.lights.ai)}），开司灯 ${lightsText(view.lights.player)}，先手 ${view.firstMover === AI ? "我" : "开司"}；押注 我 ${sMe} / 开司 ${sOpp}，上限 ${M}；本局动作：${acts}。${keep ? `手里还留着 ${cardLabel(keep)}，它对下一局的增益已按各种结局计入。` : ""}`,
    poolText(view, A),
    handText(view, A),
    `【开司出牌分布】按其本局下注修正后：${distText(D)}。我方胜 ${pct(oc.win)} / 平 ${pct(oc.draw)} / 负 ${pct(oc.lose)}。`,
    `【动作评估】（含后续加注 / 再加注的推演）${cands
      .slice()
      .sort((a, b) => b.ev - a.ev)
      .slice(0, 6)
      .map((c) => `${c.label} ${inLives(c.ev, unit)}${c.fold != null ? `（弃牌率 ${pct(c.fold)}）` : ""}`)
      .join("；")}。`,
    `【决定】${pick.label}。`
  ];

  let say: string;
  const b = pick.bet;
  if (b.type === "check") say = pickLine(opening ? LINES.checkOpen : LINES.checkClose, rng);
  else if (b.type === "call") say = pickLine(LINES.call, rng);
  else if (b.type === "fold") say = pickLine(LINES.fold, rng);
  else if (b.raiseTo === M) say = pickLine(LINES.allIn, rng);
  else say = pickLine(oc.win < 0.45 ? LINES.raiseBluff(b.raiseTo!) : LINES.raiseValue(b.raiseTo!), rng);
  return { kind: "bet", bet: b, say, reasoning: lines.join("\n") };
}

/** 我方某张牌对上开司本局打出的牌的胜率估计（含本局下注证据）。 */
export function estimateWin(view: BotView, mine: Card): { win: number; lose: number; draw: number } {
  const A = analyze(view);
  const o = zeros();
  for (const c of RANKS) o[c] = cmpRank(mine.rank, c);
  return outcomes(A.posterior, o);
}
