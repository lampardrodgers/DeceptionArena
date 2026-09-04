/**
 * 单街下注子博弈的 CFR+ / Restricted Nash Response 求解器。
 *
 * 为什么需要它：旧的 `bettingTree.ts` 在我方节点一律取 max，等于「给定对手模型的纯最佳回应」，
 * 于是「手牌 → 动作」几乎是确定映射（过牌 = 弱牌、加注 = 强牌、加注越大牌越强），
 * 真人打十几局就能反过来读穿。这里改成在**整条我方范围**上解一个近似均衡：
 * 同一个额度里既有价值牌也有诈唬牌，强牌偶尔过牌设陷阱，面对加注按范围最低防守。
 *
 * Restricted Nash Response 的实现（方案里给的两条路，这里选的是**标准 RNR**）：
 * 根部有一个机会节点，以概率 p 把开司换成「照对手模型出牌的复制体」，以 1−p 换成
 * 「自由复制体」（自己用 regret matching+ 学）。两个复制体共用同一棵公开树、但信息集互不共享，
 * 我方只有一套信息集、必须同时对两者负责。
 *   p = 0 → 纯均衡（不可被反读）；p = 1 → 纯最佳回应（等价于旧树）；中间就是「安全剥削」。
 * 实现上不必真的把树复制两份：给开司带两条到达概率向量（rM / rF）即可 —— 我方的反事实值用
 * rM + rF，自由复制体的反事实值只用我方到达概率，天然与 rM 无关。
 *
 * 效用仍是「赢下整场的概率」（`makeVal` 给的 `val`，已含留牌的下一局价值）。
 *
 * 迭代方案：regret matching+（遗憾截断在 0）+ 交替更新 + 第 t 轮的即时遗憾乘 t（Linear CFR）
 * + 平均策略按 t² 加权（DCFR 的 γ=2）。后两条是为了在 200 次迭代的预算内收敛：几个加注额
 * 的 EV 只差千分之几时，等权平均要上千次迭代才能把前几轮的探索噪声稀释掉，实测「必胜牌该加多大」
 * 这类局面 200 次就选错额度；加权之后同样 200 次就稳定选中最优额度，耗时不变。
 *
 * 注意：**这里刻意不是严格零和**。若令「开司效用 = −我方效用」，那么在 `matchEdge = 0.9` 之下
 * 开司就成了自知只有 10% 胜算的绝对劣势方 —— 他的效用曲线是凸的、极度爱好波动，最优策略退化成
 * 「每手全下」，而我方要跟一个 12 命的全下需要 83% 的胜率、于是「每手弃牌」。这个均衡在数学上没错，
 * 但它只是把 `matchEdge` 这条启发式当成了开司的真实认知。所以求解器给双方各自的风险厌恶效用
 * （`val` / `valOpp`，都以「我的命数变化」为自变量），两人都不愿意为 1 命的底池赌上整场。
 */
import { type BetAction, type BetActionType } from "../game/engine.js";
import {
  type AggCtx,
  type OppModel,
  type SizeBucket,
  aggCtxOf,
  aggressionProb,
  foldProb,
  raiseOptions,
  reraiseProb,
  sizeBucketOf,
  sizeProb
} from "./opponentModel.js";

/** 点数只有 13 种；求解器内部一律用 0..12 的下标，点数 = 下标 + 2。 */
const N = 13;
const toIdx = (rank: number) => rank - 2;

/** 可调参数，调参时集中改这里。 */
export const SOLVER_PARAMS = {
  /** CFR+ 迭代次数。 */
  iters: 200,
  /** 双方合计的加注次数上限，超过之后只剩 fold / call / check。 */
  maxRaises: 3,
  /** 输出策略时低于这个概率的动作直接剔除（去噪，避免万分之一概率的怪动作）。 */
  prune: 0.03
};

export interface SolvedAction {
  type: BetActionType;
  /** 加注动作的目标押注额。 */
  raiseTo?: number;
  /** 便于比较 / 展示的键。 */
  key: string;
}

export interface SolveInput {
  /** 开司眼中「我打出的那张牌」的分布（下标 = 点数 2..14）。 */
  myPrior: number[];
  /** 开司本局打出的牌的分布（只看选牌偏好；下注证据交给树自己解释）。 */
  oppPrior: number[];
  /** 开司拿各点数时自认为的胜率，喂给行为模型。 */
  q: number[];
  model: OppModel;
  /** RNR 权重：开司照对手模型出牌的概率。 */
  p: number;
  /** 本局押注上限。 */
  M: number;
  /** 我是否先手。 */
  meFirst: boolean;
  /** 开司的命数（影响他对加注额的敏感度）。 */
  LOpp: number;
  /** 终局估值：本局我的命数变化 → 我方效用（已含留牌的下一局价值）。 */
  val: (delta: number) => number;
  /** 终局估值：同样以「我的命数变化」为自变量，返回开司的效用（他赢就是我输，所以是递减的）。 */
  valOpp: (deltaMe: number) => number;
  /** 本局已发生的动作。真实额度会并入抽象，保证现实这条线上的押注额精确。 */
  actions: BetAction[];
  iters?: number;
}

export interface Solved {
  /** 树的节点数（调参 / 耗时分析用）。 */
  nodeCount: number;
  iters: number;
  root: number;
  /** 沿本局真实动作回放到达的节点：我方当前信息集就在这里。 */
  cur: number;
  actionsOf(n: number): SolvedAction[];
  /** 节点 n 打出第 a 个动作之后到达的节点。 */
  childOf(n: number, a: number): number;
  /** 节点 n 是谁的决策：0 = 我方，1 = 开司，2 = 终局。 */
  kindOf(n: number): 0 | 1 | 2;
  /** 节点 n 上我方点数 rank 的平均策略（顺序同 actionsOf）。 */
  strategyAt(n: number, rank: number): number[];
  /** 我方各点数在根节点的期望效用。 */
  rootValue(rank: number): number;
  /** 换一套终局估值重新求期望（策略不变）：用于「同一次求解、两张候选留牌」。 */
  evaluate(val2: (d: number) => number): (rank: number) => number;
  /** 在节点 n 打出第 a 个动作之后，开司眼中我方的点数分布（长度 15，按点数下标）。 */
  rangeAfter(n: number, a: number): number[];
  /** 节点 n 处开司眼中我方的范围（未按动作细分）。 */
  rangeAt(n: number): number[];
  /** 平均策略下，在节点 n 拿 rank 打出第 a 个动作的期望效用（已按到达概率归一，可直接和 `val` 比）。 */
  actionValue(n: number, a: number, rank: number): number;
}

// ---------- 额度抽象 ----------

/**
 * 我方的加注额抽象。
 * 首次加注按方案枚举六个代表额（空间 ≤ 6 命时干脆全枚举）；再往深处只留「最小 / 全下」两档
 * —— 树规模是 (我方档数 × 开司档数)^深度，深层不收敛的话 200 次 CFR 迭代跑不进 30 ms。
 */
export function mySizes(from: number, M: number, raises: number): number[] {
  if (from >= M) return [];
  const span = M - from;
  const out = new Set<number>();
  if (raises > 0) {
    out.add(from + 1);
    out.add(M);
  } else if (span <= 6) {
    for (let R = from + 1; R <= M; R += 1) out.add(R);
  } else {
    out.add(from + 1);
    out.add(from + 2);
    out.add(from + Math.ceil(span / 4));
    out.add(from + Math.ceil(span / 2));
    out.add(from + Math.ceil((span * 3) / 4));
    out.add(M);
  }
  return [...out].filter((v) => v > from && v <= M).sort((a, b) => a - b);
}

/** 开司的加注额抽象：`raiseOptions` 的三个代表额（与额度模型的三个桶一一对应），去重后合并桶。 */
function oppSizes(from: number, M: number): { to: number; buckets: SizeBucket[] }[] {
  const merged = new Map<number, SizeBucket[]>();
  for (const o of raiseOptions(from, M)) {
    const list = merged.get(o.to);
    if (list) list.push(o.bucket);
    else merged.set(o.to, [o.bucket]);
  }
  return [...merged.entries()].map(([to, buckets]) => ({ to, buckets })).sort((a, b) => a.to - b.to);
}

// ---------- 公开树 ----------

interface Node {
  /** 0 = 我方决策，1 = 开司决策，2 = 终局。 */
  kind: 0 | 1 | 2;
  /** 终局类型：0 = 开牌，1 = 我弃牌，2 = 开司弃牌。 */
  term: 0 | 1 | 2;
  /** 终局时的押注额（开牌 = 双方相同的押注；弃牌 = 弃牌方已押的命）。 */
  stake: number;
  sMe: number;
  sOpp: number;
  acts: SolvedAction[];
  kids: number[];
  nA: number;
  /** 策略 / 遗憾数组里的起始偏移（每个节点占 N × nA）。 */
  off: number;
  /** 开司节点：他是不是在面对我的加注。 */
  facing: boolean;
  /** 开司节点：主动加注的情境。 */
  aggCtx: AggCtx;
  /** 每个动作对应的额度桶（只有开司的加注动作非空）。 */
  buckets: SizeBucket[][];
}

interface Tree {
  nodes: Node[];
  stratSize: number;
  root: number;
  cur: number;
}

function buildTree(inp: SolveInput): Tree {
  const { M, actions } = inp;
  const maxR = SOLVER_PARAMS.maxRaises;
  const nodes: Node[] = [];
  let stratSize = 0;

  const terminal = (term: 0 | 1 | 2, stake: number): number => {
    nodes.push({
      kind: 2, term, stake, sMe: 0, sOpp: 0, acts: [], kids: [], nA: 0, off: 0,
      facing: false, aggCtx: "openFirst", buckets: []
    });
    return nodes.length - 1;
  };

  /**
   * turn: 0 = 轮到我，1 = 轮到开司。acted：本局是否已经有人行动过（决定「过牌」是让牌还是开牌）。
   * path：这个节点在真实动作史上的下标，−1 表示已经偏离现实。
   */
  const rec = (sMe: number, sOpp: number, turn: 0 | 1, acted: boolean, raises: number, oppRaised: boolean, path: number): number => {
    const meActs = turn === 0;
    const mine = meActs ? sMe : sOpp;
    const theirs = meActs ? sOpp : sMe;
    const facing = theirs > mine;
    const pa = path >= 0 && path < actions.length ? actions[path] : null;
    const onPath = pa && (pa.side === "ai") === meActs ? pa : null;

    const acts: SolvedAction[] = [];
    const buckets: SizeBucket[][] = [];
    if (!facing) {
      acts.push({ type: "check", key: "check" });
      buckets.push([]);
    } else {
      acts.push({ type: "call", key: "call" });
      buckets.push([]);
      acts.push({ type: "fold", key: "fold" });
      buckets.push([]);
    }
    // 加注：以对方的押注为基准（引擎规定 raiseTo > 对方押注，上限 M）。
    const sizes: { to: number; buckets: SizeBucket[] }[] = [];
    if (theirs < M && raises < maxR) {
      if (meActs) for (const to of mySizes(theirs, M, raises)) sizes.push({ to, buckets: [] });
      else sizes.push(...oppSizes(theirs, M));
    }
    if (onPath && onPath.type === "raise" && onPath.raiseTo != null && !sizes.some((s) => s.to === onPath.raiseTo)) {
      // 真实历史上的额度一定要在树里，否则现实这条线上的押注额会被抽象挪走。
      sizes.push({ to: onPath.raiseTo, buckets: meActs ? [] : [sizeBucketOf(theirs, onPath.raiseTo, M)] });
      sizes.sort((a, b) => a.to - b.to);
    }
    for (const s of sizes) {
      acts.push({ type: "raise", raiseTo: s.to, key: `raise${s.to}` });
      buckets.push(s.buckets);
    }

    const self: Node = {
      kind: meActs ? 0 : 1,
      term: 0,
      stake: 0,
      sMe,
      sOpp,
      acts,
      kids: [],
      nA: acts.length,
      off: stratSize,
      facing,
      aggCtx: aggCtxOf(!acted, oppRaised),
      buckets
    };
    stratSize += N * self.nA;
    nodes.push(self);
    const idx = nodes.length - 1;

    const next = (matched: boolean) => (onPath && matched ? path + 1 : -1);
    for (const a of acts) {
      if (a.type === "check") {
        // 引擎：本局已经有人行动过时，过牌即开牌。
        self.kids.push(acted ? terminal(0, mine) : rec(sMe, sOpp, meActs ? 1 : 0, true, raises, oppRaised, next(onPath?.type === "check")));
      } else if (a.type === "call") {
        const to = theirs;
        if (to >= M) self.kids.push(terminal(0, to));
        else {
          const nMe = meActs ? to : sMe;
          const nOpp = meActs ? sOpp : to;
          self.kids.push(rec(nMe, nOpp, meActs ? 1 : 0, true, raises, oppRaised, next(onPath?.type === "call")));
        }
      } else if (a.type === "fold") {
        self.kids.push(terminal(meActs ? 1 : 2, mine));
      } else {
        const to = a.raiseTo!;
        const nMe = meActs ? to : sMe;
        const nOpp = meActs ? sOpp : to;
        self.kids.push(
          rec(nMe, nOpp, meActs ? 1 : 0, true, raises + 1, oppRaised || !meActs, next(onPath?.type === "raise" && onPath.raiseTo === to))
        );
      }
    }
    return idx;
  };

  const root = rec(1, 1, inp.meFirst ? 0 : 1, false, 0, false, 0);

  // 沿真实动作回放，找出「当前信息集」所在的节点。
  let cur = root;
  for (const a of actions) {
    const nd = nodes[cur];
    if (nd.kind === 2) break;
    let hit = -1;
    for (let i = 0; i < nd.acts.length; i += 1) {
      const x = nd.acts[i];
      if (x.type !== a.type) continue;
      if (x.type === "raise" && x.raiseTo !== a.raiseTo) continue;
      hit = i;
      break;
    }
    if (hit < 0) break;
    cur = nd.kids[hit];
  }
  return { nodes, stratSize, root, cur };
}

// ---------- 行为模型（开司的「模型复制体」） ----------

function fillModelStrategy(nodes: Node[], strat: Float64Array, inp: SolveInput): void {
  const { model, q, M, LOpp } = inp;
  for (const nd of nodes) {
    if (nd.kind !== 1) continue;
    const A = nd.nA;
    const first = nd.facing ? 2 : 1; // 加注动作从这里开始
    const nR = A - first;
    for (let i = 0; i < N; i += 1) {
      const qq = q[i + 2] ?? 0.5;
      const base = nd.off + i * A;
      // 各加注额的相对权重来自额度模型（他拿这种牌力时习惯加多大）。
      let wSum = 0;
      for (let r = 0; r < nR; r += 1) {
        let w = 0;
        for (const b of nd.buckets[first + r]) w += sizeProb(model, qq, b);
        strat[base + first + r] = w;
        wSum += w;
      }
      if (nR > 0 && !(wSum > 0)) {
        for (let r = 0; r < nR; r += 1) strat[base + first + r] = 1 / nR;
        wSum = 1;
      }
      if (nd.facing) {
        const pf = foldProb(model, qq, nd.sMe, nd.sOpp, LOpp);
        const rr = nR > 0 ? (1 - pf) * reraiseProb(model, qq) : 0;
        strat[base] = Math.max(0, 1 - pf - rr); // call
        strat[base + 1] = pf; // fold
        for (let r = 0; r < nR; r += 1) strat[base + first + r] *= rr / wSum;
      } else {
        const pr = nR > 0 && nd.sMe < M && nd.sOpp < M ? aggressionProb(model, nd.aggCtx, qq) : 0;
        strat[base] = 1 - pr; // check
        for (let r = 0; r < nR; r += 1) strat[base + first + r] *= pr / wSum;
      }
      let s = 0;
      for (let a = 0; a < A; a += 1) s += strat[base + a];
      if (s > 0) for (let a = 0; a < A; a += 1) strat[base + a] /= s;
      else for (let a = 0; a < A; a += 1) strat[base + a] = 1 / A;
    }
  }
}

// ---------- 求解 ----------

/**
 * 给定 13 维分布 d，算出每个点数「能打赢的总质量」。
 * 顺序就是点数序，唯一例外是 2 克 A（下标 0 克下标 12）。返回总质量。
 */
function beatMass(src: Float64Array, off: number, out: Float64Array): number {
  let acc = 0;
  for (let i = 0; i < N; i += 1) {
    out[i] = acc;
    acc += src[off + i];
  }
  out[0] = src[off + N - 1];
  out[N - 1] -= src[off];
  return acc;
}

export function solve(inp: SolveInput): Solved {
  const iters = Math.max(1, inp.iters ?? SOLVER_PARAMS.iters);
  const { nodes, stratSize, root, cur } = buildTree(inp);
  const NB = nodes.length;

  const modelStrat = new Float64Array(stratSize);
  fillModelStrategy(nodes, modelStrat, inp);

  const regret = new Float64Array(stratSize);
  // 自由复制体的遗憾先验：把「对手模型」当成他的默认打法。
  // 这一手是必要的 —— 均衡有很多个，其中不乏靠「不可信的场外威胁」撑起来的坏均衡：
  // 我在某个节点 100% 弃牌 → 我方到达概率为 0 → 他在其后的信息集上遗憾恒为 0 →
  // 策略退回均匀分布（等于 50% 概率再全下）→ 我弃牌就真的成了最优。
  // 用模型策略当先验之后，未被到达的信息集默认「他按平时的样子打」（很少全下），
  // 于是求解器会收敛到那个有内点混合的正常均衡。被到达的信息集上这点先验会被真实遗憾迅速淹没。
  const REGRET_PRIOR = 1e-4;
  for (const nd of nodes) {
    if (nd.kind !== 1) continue;
    for (let i = 0; i < N * nd.nA; i += 1) regret[nd.off + i] = REGRET_PRIOR * modelStrat[nd.off + i];
  }
  const stratSum = new Float64Array(stratSize);
  const curStrat = new Float64Array(stratSize);
  const avg = new Float64Array(stratSize);

  const rMe = new Float64Array(NB * N);
  const rM = new Float64Array(NB * N);
  const rF = new Float64Array(NB * N);
  const vMe = new Float64Array(NB * N);
  const vOpp = new Float64Array(NB * N);
  const tW = new Float64Array(NB);
  const tD = new Float64Array(NB);
  const tL = new Float64Array(NB);
  const oW = new Float64Array(NB);
  const oD = new Float64Array(NB);
  const oL = new Float64Array(NB);
  const combo = new Float64Array(N);
  const tmp = new Float64Array(N);

  // 根部到达概率：我方 = 开司眼中我打出的牌的先验；开司 = 选牌先验，按 p 拆成模型 / 自由两个复制体。
  const rb = root * N;
  let myTotal = 0;
  let oppTotal = 0;
  for (let i = 0; i < N; i += 1) {
    myTotal += Math.max(0, inp.myPrior[i + 2] ?? 0);
    oppTotal += Math.max(0, inp.oppPrior[i + 2] ?? 0);
  }
  const p = Math.min(1, Math.max(0, inp.p));
  for (let i = 0; i < N; i += 1) {
    const my = myTotal > 0 ? Math.max(0, inp.myPrior[i + 2] ?? 0) / myTotal : 1 / N;
    const op = oppTotal > 0 ? Math.max(0, inp.oppPrior[i + 2] ?? 0) / oppTotal : 1 / N;
    rMe[rb + i] = my;
    rM[rb + i] = op * p;
    rF[rb + i] = op * (1 - p);
  }
  const rootMy = new Float64Array(N);
  rootMy.set(rMe.subarray(rb, rb + N));
  const rootFree = new Float64Array(N);
  rootFree.set(rF.subarray(rb, rb + N));

  /** 把终局估值写进 W/D/L 三个数组（W = 我赢、D = 平、L = 我输）。 */
  function prepareTerminals(valFn: (d: number) => number, W: Float64Array, D: Float64Array, L: Float64Array): void {
    for (let n = 0; n < NB; n += 1) {
      const nd = nodes[n];
      if (nd.kind !== 2) continue;
      if (nd.term === 0) {
        W[n] = valFn(nd.stake);
        D[n] = valFn(0);
        L[n] = valFn(-nd.stake);
      } else {
        const v = valFn(nd.term === 1 ? -nd.stake : nd.stake);
        W[n] = v;
        D[n] = v;
        L[n] = v;
      }
    }
  }

  /**
   * 终局两侧的收益。`wantMe` 只填一侧：交替更新时每轮只有一个玩家在学，
   * 另一侧的反事实值算了也没人读，跳过它能省掉一半的终局展开开销。
   */
  function fillTerminal(n: number, wantMe: boolean): void {
    const b = n * N;
    if (wantMe) {
      for (let i = 0; i < N; i += 1) combo[i] = rM[b + i] + rF[b + i];
      const w = tW[n];
      const d = tD[n];
      const l = tL[n];
      const totalOpp = beatMass(combo, 0, tmp);
      for (let i = 0; i < N; i += 1) {
        const win = tmp[i];
        const draw = combo[i];
        vMe[b + i] = win * w + draw * d + (totalOpp - win - draw) * l;
      }
      return;
    }
    const ow = oW[n];
    const od = oD[n];
    const ol = oL[n];
    const totalMe = beatMass(rMe, b, tmp);
    for (let c = 0; c < N; c += 1) {
      const lose = tmp[c]; // 我方被 c 打赢的质量
      const draw = rMe[b + c];
      vOpp[b + c] = (totalMe - lose - draw) * ow + draw * od + lose * ol;
    }
  }

  /** 一次 CFR+ 遍历：strat 用当前策略（regret matching+），按需累计遗憾与平均策略。 */
  function walk(n: number, updateMe: boolean, updateOpp: boolean, weight: number, wReg: number): void {
    const nd = nodes[n];
    if (nd.kind === 2) {
      fillTerminal(n, updateMe);
      return;
    }
    const b = n * N;
    const A = nd.nA;
    const off = nd.off;
    const me = nd.kind === 0;
    // 我方到达这个节点的总概率。开司的信息集只有在我方到得了的时候才学得到东西
    //（他的反事实值是按我方到达概率加权的），到不了就把策略交还给对手模型 ——
    // 否则他会一直守着早期迭代留下的、我方一旦跟注就不成立的过激打法，
    // 逼得我方在上游只能一路弃牌。
    let myMass = 0;
    if (!me) for (let i = 0; i < N; i += 1) myMass += rMe[b + i];
    const frozen = !me && myMass <= 1e-9;
    for (let i = 0; i < N; i += 1) {
      const base = off + i * A;
      if (frozen) {
        for (let a = 0; a < A; a += 1) curStrat[base + a] = modelStrat[base + a];
        continue;
      }
      let s = 0;
      for (let a = 0; a < A; a += 1) {
        const r = regret[base + a];
        if (r > 0) s += r;
      }
      if (s > 0) for (let a = 0; a < A; a += 1) {
        const r = regret[base + a];
        curStrat[base + a] = r > 0 ? r / s : 0;
      }
      else for (let a = 0; a < A; a += 1) curStrat[base + a] = 1 / A;
    }
    for (let a = 0; a < A; a += 1) {
      const kb = nd.kids[a] * N;
      if (me) {
        for (let i = 0; i < N; i += 1) {
          rMe[kb + i] = rMe[b + i] * curStrat[off + i * A + a];
          rM[kb + i] = rM[b + i];
          rF[kb + i] = rF[b + i];
        }
      } else {
        for (let i = 0; i < N; i += 1) {
          rMe[kb + i] = rMe[b + i];
          rM[kb + i] = rM[b + i] * modelStrat[off + i * A + a];
          rF[kb + i] = rF[b + i] * curStrat[off + i * A + a];
        }
      }
      walk(nd.kids[a], updateMe, updateOpp, weight, wReg);
    }
    // 同样只回传本轮在学的那一侧（`updateMe` 与 `updateOpp` 恒为一真一假）。
    // 谁的节点就按谁的当前策略加权，另一方的节点直接求和 —— 对手的动作概率
    // 早在 rM / rF 里乘过了。
    const val = updateMe ? vMe : vOpp;
    const weighted = me === updateMe;
    for (let i = 0; i < N; i += 1) val[b + i] = 0;
    for (let a = 0; a < A; a += 1) {
      const kb = nd.kids[a] * N;
      if (weighted) for (let i = 0; i < N; i += 1) val[b + i] += curStrat[off + i * A + a] * val[kb + i];
      else for (let i = 0; i < N; i += 1) val[b + i] += val[kb + i];
    }
    if (me ? updateMe : updateOpp) {
      const own = val;
      const reachArr = me ? rMe : rF;
      for (let i = 0; i < N; i += 1) {
        const base = off + i * A;
        const v = own[b + i];
        const reach = reachArr[b + i];
        for (let a = 0; a < A; a += 1) {
          const r = regret[base + a] + (own[nd.kids[a] * N + i] - v) * wReg;
          regret[base + a] = r > 0 ? r : 0;
          stratSum[base + a] += weight * reach * curStrat[base + a];
        }
      }
    }
  }

  prepareTerminals(inp.val, tW, tD, tL);
  prepareTerminals(inp.valOpp, oW, oD, oL);
  let wMe = 0;
  let wOpp = 0;
  for (let t = 1; t <= iters; t += 1) {
    // 交替更新：奇数轮更新我方，偶数轮更新开司的自由复制体。
    // 平均策略按 t² 加权（DCFR 的 γ=2）：几个动作 EV 几乎相同时，线性加权要上千次迭代
    // 才能把前几轮的探索噪声稀释掉，平方加权几百次就够了 —— 直接决定「同样的 200 次迭代
    // 能不能选对加注额」。
    const mine = t % 2 === 1;
    const w = t * t;
    walk(root, mine, !mine, w, t);
    if (mine) wMe += w;
    else wOpp += w;
  }

  /**
   * 平均策略。
   *
   * 关键细节：到达概率塌成 0 的信息集，其 `stratSum` 会永远停在最初几轮的探索噪声上
   * （第 1 轮还是均匀分布时留下的那一点点质量）。这些信息集恰恰是「我在上游 100% 弃牌」之后的地方，
   * 而它们的策略决定了对手的威胁可不可信 —— 如果这里留着「25% 跟全下」的噪声，
   * 那么上游的跟注看起来就永远是亏的，求解器会锁死在「一路弃牌」的坏均衡里。
   * 所以：平均只在累计权重达到「该类型满额到达」的千分之一时才采用，否则退回最后一轮的
   * regret matching 策略（它是对当前对手策略的最佳回应，序贯上是理性的）。
   */
  const FLOOR = 1e-3;
  for (const nd of nodes) {
    if (nd.kind === 2) continue;
    const A = nd.nA;
    const me = nd.kind === 0;
    for (let i = 0; i < N; i += 1) {
      const base = nd.off + i * A;
      let s = 0;
      for (let a = 0; a < A; a += 1) s += stratSum[base + a];
      const full = (me ? rootMy[i] * wMe : rootFree[i] * wOpp) * FLOOR;
      if (s > full && s > 1e-12) for (let a = 0; a < A; a += 1) avg[base + a] = stratSum[base + a] / s;
      else {
        let cs = 0;
        for (let a = 0; a < A; a += 1) cs += curStrat[base + a];
        for (let a = 0; a < A; a += 1) avg[base + a] = cs > 0 ? curStrat[base + a] / cs : 1 / A;
      }
    }
  }

  /** 用平均策略跑一遍，填出各节点的到达概率与期望值。 */
  function walkAvg(n: number): void {
    const nd = nodes[n];
    if (nd.kind === 2) {
      fillTerminal(n, true);
      return;
    }
    const b = n * N;
    const A = nd.nA;
    const off = nd.off;
    const me = nd.kind === 0;
    for (let a = 0; a < A; a += 1) {
      const kb = nd.kids[a] * N;
      if (me) {
        for (let i = 0; i < N; i += 1) {
          rMe[kb + i] = rMe[b + i] * avg[off + i * A + a];
          rM[kb + i] = rM[b + i];
          rF[kb + i] = rF[b + i];
        }
      } else {
        for (let i = 0; i < N; i += 1) {
          rMe[kb + i] = rMe[b + i];
          rM[kb + i] = rM[b + i] * modelStrat[off + i * A + a];
          rF[kb + i] = rF[b + i] * avg[off + i * A + a];
        }
      }
      walkAvg(nd.kids[a]);
    }
    for (let i = 0; i < N; i += 1) vMe[b + i] = 0;
    for (let a = 0; a < A; a += 1) {
      const kb = nd.kids[a] * N;
      if (me) for (let i = 0; i < N; i += 1) vMe[b + i] += avg[off + i * A + a] * vMe[kb + i];
      else for (let i = 0; i < N; i += 1) vMe[b + i] += vMe[kb + i];
    }
  }

  function resetRoot(): void {
    for (let i = 0; i < N; i += 1) {
      rMe[rb + i] = rootMy[i];
      const op = rM[rb + i] + rF[rb + i];
      rM[rb + i] = op * p;
      rF[rb + i] = op * (1 - p);
    }
  }

  resetRoot();
  walkAvg(root);
  const rootVals = new Float64Array(N);
  rootVals.set(vMe.subarray(rb, rb + N));
  // 平均策略下的到达概率就是「开司眼中我方在各节点的范围」，策略不变时它也不会变。
  const reachSnapshot = new Float64Array(rMe);
  const valueSnapshot = new Float64Array(vMe);
  // 每个节点上开司的到达概率总和：把反事实值换算回「一命值多少」的尺度时要除掉它。
  const oppReach = new Float64Array(NB);
  for (let n = 0; n < NB; n += 1) {
    let s = 0;
    for (let i = 0; i < N; i += 1) s += rM[n * N + i] + rF[n * N + i];
    oppReach[n] = s;
  }

  const rangeOf = (n: number, weightAction: number): number[] => {
    const nd = nodes[n];
    const out = new Array<number>(15).fill(0);
    let s = 0;
    for (let i = 0; i < N; i += 1) {
      const w = weightAction >= 0 && nd.kind !== 2 ? avg[nd.off + i * nd.nA + weightAction] : 1;
      const v = reachSnapshot[n * N + i] * w;
      out[i + 2] = v;
      s += v;
    }
    if (s > 0) for (let i = 0; i < N; i += 1) out[i + 2] /= s;
    return out;
  };

  return {
    nodeCount: NB,
    iters,
    root,
    cur,
    actionsOf: (n) => nodes[n].acts,
    childOf: (n, a) => nodes[n].kids[a],
    kindOf: (n) => nodes[n].kind,
    strategyAt: (n, rank) => {
      const nd = nodes[n];
      if (nd.kind === 2) return [];
      const base = nd.off + toIdx(rank) * nd.nA;
      const out: number[] = [];
      for (let a = 0; a < nd.nA; a += 1) out.push(avg[base + a]);
      return out;
    },
    rootValue: (rank) => rootVals[toIdx(rank)],
    evaluate: (val2) => {
      prepareTerminals(val2, tW, tD, tL);
      resetRoot();
      walkAvg(root);
      const out = new Float64Array(N);
      out.set(vMe.subarray(rb, rb + N));
      return (rank: number) => out[toIdx(rank)];
    },
    rangeAfter: (n, a) => rangeOf(n, a),
    rangeAt: (n) => rangeOf(n, -1),
    actionValue: (n, a, rank) => {
      const kid = nodes[n].kids[a];
      const r = oppReach[kid];
      return r > 1e-12 ? valueSnapshot[kid * N + toIdx(rank)] / r : 0;
    }
  };
}
