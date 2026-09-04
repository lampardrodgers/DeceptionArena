/**
 * 留在手里那张牌的下一局价值（D9'）。
 *
 * 旧实现（`bettingTree.ts` 的 `Math.max` 树）在我方节点一律取最大值，等于假设「下一局我会用
 * 这张牌打出对手模型下的最佳回应」—— 纯最佳回应会把留大牌的收益系统性抬高：Stage M 的基线里
 * 「8+2 对 DOWN2、我先手」两个候选的合计 EV 分别是 +0.64 / +0.79 命，其中留牌项超过 1 命，
 * 而这一局的全部筹码也才 1 命。于是机器人为了「留下那张 8」宁可打出必输的 2，
 * MIX 灯下出小牌的比例被推到 70.4%。
 *
 * 现在改成用同一个范围求解器估下一局：
 *   - 每局只解一次表：(先手 ∈ {我, 开司}) × (我下一局的灯 ∈ UP2/MIX/DOWN2)
 *     × (开司下一局的灯 ∈ UP2/MIX/DOWN2)，最多 18 次求解，结果按局缓存、选牌与下注共用。
 *   - 下一局的估值以**命**计（外层 `makeValByRank` 再用 `slope(L')` 换算成当前命数下的效用），
 *     但不能用线性的 `d`：那样下一局的求解器会为了期望值毫无顾忌地放大方差，而真正下注时
 *     用的是凹的 `uWithEdge`，根本不会那样打。这里改成**确定性等价命数**
 *     `uWithEdge(d) / uWithEdge 的单位`，同一条风险曲线上折一次再换回来。
 *   - 一次求解就同时给出 13 个点数的值：`rootValue(k)` 是「我下一局打出 k」的期望值，
 *     它已经含了整条范围的混合策略（诈唬、慢打、按赔率防守），不再是最佳回应的上界。
 *   - 「留 k」的价值不是 `V[k]`：下一局我手里是 k 加一张新牌，打哪张由我决定，
 *     所以对新牌取期望、对两张取较优的那张（见 `hold`）。
 *
 * 近似（都是为了「每局只解一次」）：
 *   - 下一局的押注上限 M 用**本局**的 `min(L, T−L)`：真实的 M 取决于本局输赢多少命。
 *   - 开司的命数同样用本局的值。
 *   - 开司眼中的牌池用 `A.theirs`（本局的），没有按「我留下 k + 摸一张新牌」再更新。
 */
import { type Lights } from "../game/engine.js";
import {
  type Analysis,
  type BotView,
  type Cat,
  type Ctx,
  AI,
  PARAMS,
  RANKS,
  catOfRank,
  normalize,
  perceivedRange,
  perceivedWin,
  uWithEdge,
  zeros
} from "./analysis.js";
import { type OppModel, chooseProb, contextConfidence } from "./opponentModel.js";
import { type Solved, solve } from "./solver.js";

/** 留牌未来价值的折扣（下一局未必真按估计打出去，牌池也还会变）。 */
export const GAMMA = 0.7;
/**
 * 估值表的 CFR+ 迭代数。比生产用的 200 低：这张表要解最多 18 次，而它只需要给出
 * 13 个点数**之间**的相对高低（绝对值会被 `mean()` 减掉），对收敛精度的要求比当前局面低得多。
 */
export const FV_ITERS = 100;
/** 开司指示灯组合的权重低于这个值就跳过（剩下的重新归一）。 */
const CTX_FLOOR = 0.05;

const ALL_CTX: Ctx[] = ["UP2", "MIX", "DOWN2"];

/** 由两张牌的类别推出指示灯类型。 */
export function ctxOfCats(a: Cat, b: Cat): Ctx {
  if (a === "UP" && b === "UP") return "UP2";
  if (a === "DOWN" && b === "DOWN") return "DOWN2";
  return "MIX";
}

const lightsOfCtx = (c: Ctx): Lights => (c === "UP2" ? { up: 2, down: 0 } : c === "DOWN2" ? { up: 0, down: 2 } : { up: 1, down: 1 });

/**
 * 「一局刚开始、还没有任何动作」时的情境置信度（D6）。
 * 开司先手 → 他的第一个决策就是 `openFirst`；我先手 → 他要么在我过牌后偷注（`stabAfterBotCheck`），
 * 要么面对我的加注（查 fold / reraise 那几格），两者各半。
 */
export function freshRoundConfidence(model: OppModel, kaijiIsMix: boolean, meFirst: boolean): number {
  const cc = (facing: boolean, aggCtx: "openFirst" | "stabAfterBotCheck") =>
    contextConfidence(model, { kaijiIsMix, facing, aggCtx, bucket: null, bin: null });
  if (!meFirst) return cc(false, "openFirst");
  return 0.5 * cc(false, "stabAfterBotCheck") + 0.5 * cc(true, "stabAfterBotCheck");
}

export interface FvTable {
  /** V[先手][我下一局的灯][点数]：下一局的期望命数变化（已按开司灯的权重加权）。 */
  value(meFirst: boolean, ctx: Ctx, rank: number): number;
  /** 留 k 的下一局价值：按新牌的类别混合 `value`（决定下一局我方的灯）。单位：命。 */
  hold(meFirst: boolean, k: number): number;
  /** 按牌池加权的平均留牌价值 V̄。 */
  mean(meFirst: boolean): number;
  /** 留 k 相对平均值的增量，换算成「命数 L2、先手 meFirst」这一局的效用。 */
  fv(k: number, L2: number, meFirst: boolean): number;
  /** 实际跑了几次求解（性能分析用）。 */
  solves: number;
}

/** 开司下一局的手牌分档：他的指示灯类型、该档的权重、以及他在该档里打出的牌的分布。 */
interface OppBucket {
  ctx: Ctx;
  w: number;
  D: number[];
}

/**
 * 开司下一局：手里是他本局留下的牌 h（分布 `A.kept`）加一张新牌 n（按牌池分布），
 * 按 (cat h, cat n) 分成三档指示灯；每档里他打出的牌的分布用 `chooseProb` 展开。
 * `chooseProb` 的 ctx 是**我方**的指示灯（他看着我的灯决定打哪张），所以整张表按 myCtx 分别算。
 */
function oppBuckets(A: Analysis, myCtx: Ctx, newDist: number[]): OppBucket[] {
  const acc = new Map<Ctx, { w: number; D: number[] }>();
  for (const c of ALL_CTX) acc.set(c, { w: 0, D: zeros() });
  for (const h of RANKS) {
    const wh = A.kept[h];
    if (!wh) continue;
    for (const n of RANKS) {
      const w = wh * newDist[n];
      if (!w) continue;
      const cell = acc.get(ctxOfCats(catOfRank(h), catOfRank(n)))!;
      const ph = chooseProb(A.model, h, n, myCtx);
      cell.w += w;
      cell.D[h] += w * ph;
      cell.D[n] += w * (1 - ph);
    }
  }
  let total = 0;
  for (const c of ALL_CTX) total += acc.get(c)!.w;
  const out: OppBucket[] = [];
  let kept = 0;
  for (const c of ALL_CTX) {
    const cell = acc.get(c)!;
    const w = total > 0 ? cell.w / total : 0;
    if (w < CTX_FLOOR) continue;
    out.push({ ctx: c, w, D: normalize(cell.D) });
    kept += w;
  }
  if (out.length === 0) return [{ ctx: myCtx, w: 1, D: normalize(A.played.slice()) }];
  for (const b of out) b.w /= kept; // 跳过的低权重档按比例摊回
  return out;
}

/** 建一张「下一局各点数留在手里值多少命」的表。每局一次，选牌与下注共用。 */
export function buildFvTable(view: BotView, A: Analysis, iters = FV_ITERS): FvTable {
  const LMe = view.lives.ai;
  const LOpp = view.lives.player;
  const T = LMe + LOpp;
  const M = Math.max(1, Math.min(LMe, LOpp));
  const pool = A.pool;
  let total = 0;
  for (const r of RANKS) total += pool[r];
  const newDist = normalize(pool.slice());
  /** 当前命数下「一命」的效用（= slope(LMe)），用来把效用换回命。 */
  const unit0 = Math.max(1e-9, (uWithEdge(1, LMe, T, PARAMS.solveEdge) - uWithEdge(-1, LMe, T, PARAMS.solveEdge)) / 2);
  let solves = 0;

  // V[先手 ? 0 : 1][ctx] = 13 个点数的期望命数变化。
  const V: Record<Ctx, number[]>[] = [
    { UP2: zeros(), MIX: zeros(), DOWN2: zeros() },
    { UP2: zeros(), MIX: zeros(), DOWN2: zeros() }
  ];
  for (const meFirst of [true, false]) {
    const slot = V[meFirst ? 0 : 1];
    for (const myCtx of ALL_CTX) {
      const lights = lightsOfCtx(myCtx);
      const myPrior = perceivedRange(lights, A.theirs);
      const q = zeros();
      for (const c of RANKS) q[c] = perceivedWin(c, lights, A.theirs);
      for (const b of oppBuckets(A, myCtx, newDist)) {
        const sol: Solved = solve({
          myPrior,
          oppPrior: b.D,
          q,
          model: A.model,
          p: freshRoundConfidence(A.model, b.ctx === "MIX", meFirst),
          M,
          meFirst,
          LOpp,
          oppMix: b.ctx === "MIX",
          // 下一局的终局值：先按**同一条风险曲线**折成效用，再除以当前命数下「一命」的效用，
          // 换回「确定性等价命数」。为什么不能直接用 `d`（线性、风险中性）：那样下一局的求解器
          // 会为了期望值毫无顾忌地放大方差，一张 A 被记成 +3.0 命、一张 2 被记成 −1.1 命，
          // 而我们真正下注时用的是凹的 `uWithEdge`，根本不会那样打。实测线性版把
          // 「留大牌」的价值抬高约一倍，扫描里「大牌必胜、小牌必败」的格子会出现 80% 以上的送牌率。
          // 除以 `unit0` 之后单位仍是命，外层的 slope(L') 照旧负责换算到结局后的命数上。
          val: (_rank, d) => uWithEdge(d, LMe, T, PARAMS.solveEdge) / unit0,
          edge: PARAMS.solveEdge,
          actions: [],
          iters
        });
        solves += 1;
        for (const k of RANKS) slot[myCtx][k] += b.w * sol.rootValue(k);
      }
    }
  }

  const holdMemo: (number[] | null)[] = [null, null];
  /**
   * 「留 k 进入下一局」值多少命。
   *
   * 注意这里**不是** `V[k]`（那是「下一局打出 k」的值）：下一局我手里是 k 加一张新牌 n，
   * 到时候打哪一张是我自己选的。只按 `V[k]` 计价等于假设我被迫打出留下的那张，
   * 于是留一张 2 被记成 −1.06 命（其实我会改打新牌），留牌价值的高低差被整整拉大了三到四成，
   * 「送掉稳输的小牌去保住大牌」就成了划算买卖 —— 扫描里「大牌必胜、小牌必败」那几格
   * 会出现 50% 以上的送牌率。所以这里对新牌取期望、对两张牌取较优的那张。
   * （取 max 会有一点乐观偏差：真正的下一局是混合策略，不会永远选中事后更好的那张。）
   */
  const hold = (meFirst: boolean, k: number): number => {
    const i = meFirst ? 0 : 1;
    let arr = holdMemo[i];
    if (!arr) {
      arr = zeros();
      const slot = V[i];
      for (const r of RANKS) {
        const cat = catOfRank(r);
        let acc = 0;
        for (const n of RANKS) {
          const w = newDist[n];
          if (!w) continue;
          const tbl = slot[ctxOfCats(cat, catOfRank(n))];
          acc += w * Math.max(tbl[r], tbl[n]);
        }
        arr[r] = acc;
      }
      holdMemo[i] = arr;
    }
    return arr[k] ?? 0;
  };
  const meanMemo: (number | null)[] = [null, null];
  const mean = (meFirst: boolean): number => {
    const i = meFirst ? 0 : 1;
    let m = meanMemo[i];
    if (m === null) {
      m = 0;
      if (total > 0) for (const r of RANKS) if (pool[r]) m += (pool[r] / total) * hold(meFirst, r);
      meanMemo[i] = m;
    }
    return m;
  };
  /** slope(L') = 下一局多赢一命 / 少赢一命的效用差之半；命数出界（输光 / 赢下整场）时没有下一局。 */
  const slopeMemo = new Map<number, number>();
  const slope = (L2: number): number => {
    if (L2 <= 0 || L2 >= T) return 0;
    const hit = slopeMemo.get(L2);
    if (hit !== undefined) return hit;
    const v = (uWithEdge(1, L2, T, PARAMS.solveEdge) - uWithEdge(-1, L2, T, PARAMS.solveEdge)) / 2;
    slopeMemo.set(L2, v);
    return v;
  };

  return {
    value: (meFirst, ctx, rank) => V[meFirst ? 0 : 1][ctx][rank] ?? 0,
    hold,
    mean,
    fv: (k, L2, meFirst) => {
      const s = slope(L2);
      return s === 0 ? 0 : GAMMA * (hold(meFirst, k) - mean(meFirst)) * s;
    },
    solves
  };
}

/**
 * 本局的终局估值，按**我方打出的点数**分档：
 *   val(rank, d) = u(d) + Σ_k P(留 k | 打 rank) · fv(k, L + d, 该结局下谁先手)
 *
 * `keptGiven(rank)` 是「打出 rank 时留在手里的牌」的条件分布 —— 这正是求解器需要的东西：
 * 开司看不到我留了什么，他眼中我方每个点数背后都是一整条留牌分布，13 个点数的终局值因此不同。
 * 下一局的先手按本局结果定（赢的一方先手），平局沿用本局先手。
 */
export function makeValByRank(
  view: BotView,
  keptGiven: (rank: number) => number[],
  table: FvTable
): (rank: number, d: number) => number {
  const LMe = view.lives.ai;
  const T = LMe + view.lives.player;
  const meFirstNow = view.firstMover === AI;
  const sparse = new Map<number, { k: number; w: number }[]>();
  const memo = new Map<number, number>();
  return (rank, d) => {
    const key = rank * 4096 + (d + 2048);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let list = sparse.get(rank);
    if (!list) {
      list = [];
      const g = keptGiven(rank);
      for (const k of RANKS) if (g[k] > 1e-9) list.push({ k, w: g[k] });
      sparse.set(rank, list);
    }
    const meFirst = d > 0 ? true : d < 0 ? false : meFirstNow;
    let v = uWithEdge(d, LMe, T, PARAMS.solveEdge);
    for (const x of list) v += x.w * table.fv(x.k, LMe + d, meFirst);
    memo.set(key, v);
    return v;
  };
}

/** 只留一张牌 k 的「条件分布」：`botBet` 里我自己知道留的是什么，用它替换聚合分布。 */
export function oneHot(k: number | null): number[] {
  const out = zeros();
  if (k !== null) out[k] = 1;
  return out;
}
