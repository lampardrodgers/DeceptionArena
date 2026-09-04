/**
 * 公开信息视图、记牌、读牌（贝叶斯滤波）与效用曲线。
 *
 * 这一层只依赖「和也有权知道的信息」：自己的手牌、双方指示灯、本局下注过程、
 * 历史开牌记录、弃牌堆、牌堆重洗的时刻。绝不读取开司的手牌、牌堆顺序或被切掉的牌。
 *
 * 与 opponentModel.ts 是相互引用的关系（读牌要用对手模型，建模要用记牌结果），
 * 两边都只在函数体里互相调用，模块初始化阶段没有依赖，循环引用是安全的。
 */
import { type Card, createDeck, isUp } from "../game/cards.js";
import {
  type BetAction,
  type GameState,
  type LegalBets,
  type Lights,
  type RoundRecord,
  type Side,
  legalBets,
  lightsOf,
  other
} from "../game/engine.js";
import {
  type OppModel,
  aggCtxOf,
  aggressionProb,
  chooseProb,
  foldProb,
  learnOpponent,
  reraiseProb,
  sizeBucketOf,
  sizeProb
} from "./opponentModel.js";

export const AI: Side = "ai";
export const HUMAN: Side = "player";

export type Cat = "UP" | "DOWN";
/** 开司看到的我方指示灯类型：决定他怎么选牌 / 怎么估自己的胜率。 */
export type Ctx = "UP2" | "MIX" | "DOWN2";

export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const CATS: Cat[] = ["UP", "DOWN"];
export const catOfRank = (r: number): Cat => (r >= 8 ? "UP" : "DOWN");
export const catOf = (c: Card): Cat => (isUp(c) ? "UP" : "DOWN");

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

export const zeros = () => new Array<number>(15).fill(0);

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
export function historyPools(view: BotView): number[][] {
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

export function normalize(d: number[]): number[] {
  let s = 0;
  for (const v of d) s += v;
  if (!(s > 0)) return d;
  return d.map((v) => v / s);
}

/** 某一类别内按牌池张数的分布；该类已无未知牌时退化为均匀分布。 */
export function catDist(pool: number[], cat: Cat): number[] {
  const d = zeros();
  let s = 0;
  for (const r of RANKS) if (catOfRank(r) === cat) s += pool[r];
  for (const r of RANKS) if (catOfRank(r) === cat) d[r] = s > 0 ? pool[r] / s : 1 / 6;
  return normalize(d);
}

export function ctxOf(l: Lights): Ctx {
  return l.up === 2 ? "UP2" : l.down === 2 ? "DOWN2" : "MIX";
}

/** 指示灯对应的两张牌类别。 */
export function catsOf(l: Lights): [Cat, Cat] {
  return l.up === 2 ? ["UP", "UP"] : l.down === 2 ? ["DOWN", "DOWN"] : ["UP", "DOWN"];
}

/** 已知一张的类别，由指示灯推出另一张的类别。 */
export function otherCat(l: Lights, known: Cat): Cat {
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

/**
 * 开司视角：我打出的那张牌的点数分布。
 * 与 `perceivedWin` 用的是同一套假设（按灯的 UP/DOWN 比例加权、类别内按他眼中的牌池分布），
 * 所以 `perceivedWin(c, l, pool) = Σ_k perceivedRange(l, pool)[k] · [c 赢 k]`（平局算半个），两者天然一致。
 */
export function perceivedRange(myLights: Lights, poolTheirs: number[]): number[] {
  const total = myLights.up + myLights.down || 1;
  const out = zeros();
  for (const cat of CATS) {
    const w = (cat === "UP" ? myLights.up : myLights.down) / total;
    if (!w) continue;
    const d = catDist(poolTheirs, cat);
    for (const k of RANKS) out[k] += w * d[k];
  }
  return normalize(out);
}

/** 某一局开打前双方的命数（从结算后的命数反推）。 */
export function livesBefore(r: RoundRecord): Record<Side, number> {
  const p = r.livesAfter.player + (r.result === "ai" ? r.livesMoved : r.result === "player" ? -r.livesMoved : 0);
  const a = r.livesAfter.ai + (r.result === "player" ? r.livesMoved : r.result === "ai" ? -r.livesMoved : 0);
  return { player: p, ai: a };
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
  /** 开司眼中的未知牌池（含我的手牌与已打出的牌，他都不知道）。 */
  theirs: number[];
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
  view.actions.forEach((a, idx) => {
    const op = other(a.side);
    if (a.side === HUMAN) {
      const facing = st[op] > st[a.side];
      const canRaise = st[op] < M;
      // 加注额度本身也是证据：他把注加到多大，各档牌力的习惯并不相同。
      const bucket = a.type === "raise" && a.raiseTo != null ? sizeBucketOf(st[op], a.raiseTo, M) : null;
      const aggCtx = aggCtxOf(idx === 0, heRaised);
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
          const pr = aggressionProb(model, aggCtx, q[c]);
          lik = a.type === "raise" ? pr : 1 - pr;
        }
        if (bucket !== null) lik *= sizeProb(model, q[c], bucket);
        posterior[c] *= Math.max(lik, 1e-6);
      }
      if (a.type === "raise") heRaised = true;
    }
    if (a.type === "raise") st[a.side] = a.raiseTo ?? st[a.side];
    else if (a.type === "call") st[a.side] = st[op];
  });
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
    q,
    theirs
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
export function u(delta: number, LMe: number, T: number): number {
  return matchWinProb(LMe + delta, T) - matchWinProb(LMe, T);
}

/** 当前局面下 1 命大约值多少效用，用来把以命为单位的参数换算成效用。 */
export function unitUtility(LMe: number, T: number): number {
  return Math.max(1e-6, (matchWinProb(LMe + 1, T) - matchWinProb(LMe - 1, T)) / 2);
}
