/**
 * 阶段 B 的行为指标。
 *
 * 这些指标回答的不是「机器人赢没赢」，而是「它为什么赢 / 为什么被读穿」：
 *
 *  - `mixSelectionRate`   MIX 灯时到底出大牌还是小牌（D3 选牌—下注固定点是否真的动了选牌）；
 *  - `valueExtraction`    强牌的加注额分布与对手跟注率、弱牌的诈唬率与成功率（D4 价格曲线的效果）；
 *  - `tellMetrics`        沿用 `measureTells`，加一条 `aucAbs ≤ 0.75` 的失败线；
 *  - `exploitabilityProbe` 三个固定局面的 NashConv（换算成命），iters ∈ {200, 400} 各记一档；
 *  - `adaptationCurve`    对 `mixDownBluffer` 的最小加注，跟注率随局数是否上升（D5 联合统计）。
 *
 * 只在测试 / bench 里用，应用代码不引用。所有指标都跑在 `sim.ts` 的同一个对局循环上
 * （`simulate` 的 `MatchHooks`），所以「胜率表」与「指标」看到的是同一份对局。
 */
import { isUp, seededRng, type Card } from "../game/cards.js";
import {
  type BetActionType,
  type BetInput,
  type GameState,
  type RoundRecord,
  type Side,
  act,
  legalBets,
  newGame,
  selectCard,
  startRound
} from "../game/engine.js";
import { AI, PARAMS, analyze, perceivedRange, publicView, uWithEdge, unitUtility } from "./analysis.js";
import { type BotView, botBet, botSelect, estimateWin } from "./bot.js";
import { SOLVER_PARAMS, type SolveInput, solve } from "./solver.js";
import {
  type BotSide,
  type MatchHooks,
  type Strategy,
  type TellStats,
  measureTells,
  mixDownBluffer,
  simulate,
  tight
} from "./sim.js";

const defaultBot = (): BotSide => ({ select: botSelect, bet: botBet, view: publicView });

// ---------- 区间估计 ----------

export interface Interval {
  /** 点估计。 */
  p: number;
  lo: number;
  hi: number;
  n: number;
  k: number;
}

/**
 * Wilson 95% 置信区间。n = 0 时返回 [0, 1]（「什么都不知道」而不是「0%」）。
 * 比 Wald 区间靠谱得多：40 局这种样本量下 Wald 在 p 接近 0/1 时会给出越界的区间。
 */
export function wilson(k: number, n: number, z = 1.959964): Interval {
  if (n <= 0) return { p: 0, lo: 0, hi: 1, n: 0, k: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half), n, k };
}

const ratio = (k: number, n: number) => (n > 0 ? k / n : NaN);

// ---------- 单局观察 ----------

/** 加注额分三桶：0 = 最小加注，2 = 全下（打满上限），1 = 中码。 */
export type SizeTag = "min" | "mid" | "allin";

export function sizeTag(raiseTo: number, minRaiseTo: number, M: number): SizeTag {
  if (raiseTo >= M) return "allin";
  if (raiseTo <= minRaiseTo) return "min";
  return "mid";
}

/** 从机器人视角看一局里发生了什么（全部来自 `simulate` 的钩子）。 */
export interface RoundObs {
  round: number;
  /** 机器人自己的灯型（选牌之前，两张手牌的 UP/DOWN 组合）。 */
  ctx: "UP2" | "MIX" | "DOWN2";
  /** 选牌前两张候选的点数与各自的胜率估计（`estimateWin`）。 */
  candRanks: [number, number];
  candWins: [number, number];
  /** 实际打出的点数与留下的点数。 */
  playedRank: number;
  keptRank: number;
  /** 打出的是 DOWN 牌（2–7）吗。 */
  playedDown: boolean;
  /** 机器人第一次下注决策时对自己这张牌的胜率估计。 */
  q: number;
  /** 双方押注相同时机器人的首个动作。 */
  openAction: BetActionType | null;
  /** 首个动作是加注时的额度标签与目标额。 */
  openSize: SizeTag | null;
  openRaiseTo: number | null;
  /** 机器人首次主动加注之后，开司的回应。 */
  oppReply: "fold" | "call" | "raise" | null;
  /** 机器人第一次面对加注时要跟的额度，以及它的回应。 */
  facedAmount: number | null;
  facedAction: BetActionType | null;
  /** 本局机器人命数变化（胜 +livesMoved / 负 −livesMoved / 平 0）。 */
  lives: number;
  reason: "showdown" | "fold";
}

/** 跑 games 局，把每一局的观察摊平成 `RoundObs[]`。 */
export function observe(
  opponent: Strategy,
  games: number,
  seed: number,
  bot: BotSide = defaultBot(),
  lives = 12
): { obs: RoundObs[]; wins: number; games: number } {
  const obs: RoundObs[] = [];
  let cur: RoundObs | null = null;
  let botRaised = false;
  const hooks = {
    onBeforeSelect(_s: GameState, view: BotView) {
      const hand = view.hand;
      if (hand.length < 2) {
        cur = null;
        return;
      }
      const up = hand.filter(isUp).length;
      const w = hand.map((c: Card) => estimateWin(view, c).win) as [number, number];
      cur = {
        round: view.round,
        ctx: up === 2 ? "UP2" : up === 0 ? "DOWN2" : "MIX",
        candRanks: [hand[0].rank, hand[1].rank],
        candWins: w,
        playedRank: 0,
        keptRank: 0,
        playedDown: false,
        q: NaN,
        openAction: null,
        openSize: null,
        openRaiseTo: null,
        oppReply: null,
        facedAmount: null,
        facedAction: null,
        lives: 0,
        reason: "showdown"
      };
      botRaised = false;
    },
    onSelect(s: GameState, _cardId: string) {
      if (!cur) return;
      const played = s.players.ai.chosen!;
      const kept = s.players.ai.hand[0];
      cur.playedRank = played.rank;
      cur.keptRank = kept ? kept.rank : 0;
      cur.playedDown = !isUp(played);
    },
    onBotBet(_s: GameState, view: BotView, bet: BetInput) {
      if (!cur) return;
      if (Number.isNaN(cur.q) && view.chosen) cur.q = estimateWin(view, view.chosen).win;
      const equal = view.stakes.ai === view.stakes.player;
      if (equal && cur.openAction === null) {
        cur.openAction = bet.type;
        if (bet.type === "raise") {
          cur.openSize = sizeTag(bet.raiseTo!, view.legal.minRaiseTo, view.maxStake);
          cur.openRaiseTo = bet.raiseTo!;
        }
      }
      if (!equal && cur.facedAction === null) {
        cur.facedAmount = view.legal.callAmount;
        cur.facedAction = bet.type;
      }
      if (bet.type === "raise") botRaised = true;
    },
    onRoundEnd(_s: GameState, rec: RoundRecord) {
      if (!cur) return;
      cur.lives = rec.result === "ai" ? rec.livesMoved : rec.result === "player" ? -rec.livesMoved : 0;
      cur.reason = rec.reason;
      if (botRaised) cur.oppReply = replyToBotRaise(rec);
      obs.push(cur);
      cur = null;
    }
  };
  const r = simulate(opponent, games, seed, lives, bot, hooks satisfies MatchHooks);
  return { obs, wins: r.wins, games };
}

/** 回放一局的公开动作，找出机器人首次加注之后开司的回应。 */
function replyToBotRaise(rec: RoundRecord): "fold" | "call" | "raise" | null {
  let seen = false;
  for (const a of rec.actions) {
    if (seen && a.side === "player") {
      return a.type === "fold" ? "fold" : a.type === "raise" ? "raise" : "call";
    }
    if (a.side === "ai" && a.type === "raise") seen = true;
  }
  return null;
}

// ---------- 指标 1：MIX 选牌率 ----------

export interface MixSelection {
  /** MIX 灯的局数。 */
  n: number;
  /** MIX 灯时打出 DOWN 牌的比例（含 Wilson 区间）。 */
  downRate: Interval;
  /** 按「两张牌各自的胜率 ≥ 0.5」分组。 */
  bothWin: Interval;
  bothLose: Interval;
  split: Interval;
  /** 非 MIX 局的分布，方便对照（灯已公开时选牌只剩点数问题）。 */
  up2: number;
  down2: number;
  rounds: number;
}

/**
 * MIX 灯时 P(打出 DOWN)。0.5 附近说明选牌真的在混合；
 * 一边倒（旧代码 70.4%）说明「留大牌」的估值把选牌压成了确定性策略，对手一看灯就知道你出什么。
 */
export function mixSelectionRate(
  bot: BotSide = defaultBot(),
  games = 12,
  seed = 41,
  opponent: Strategy = tight
): MixSelection {
  const { obs } = observe(opponent, games, seed, bot);
  const mix = obs.filter((o) => o.ctx === "MIX");
  const down = (list: RoundObs[]) => wilson(list.filter((o) => o.playedDown).length, list.length);
  const cls = (o: RoundObs) => (o.candWins[0] >= 0.5 ? 1 : 0) + (o.candWins[1] >= 0.5 ? 1 : 0);
  return {
    n: mix.length,
    downRate: down(mix),
    bothWin: down(mix.filter((o) => cls(o) === 2)),
    bothLose: down(mix.filter((o) => cls(o) === 0)),
    split: down(mix.filter((o) => cls(o) === 1)),
    up2: obs.filter((o) => o.ctx === "UP2").length,
    down2: obs.filter((o) => o.ctx === "DOWN2").length,
    rounds: obs.length
  };
}

// ---------- 指标 2：价值提取 / 诈唬 ----------

export interface ValueExtraction {
  strong: {
    /** q ≥ 0.9 的局数。 */
    n: number;
    /** 首个动作是加注的比例。 */
    raiseRate: Interval;
    /** 加注额三桶占比（分母 = 加注了的局数）。 */
    sizes: Record<SizeTag, number>;
    /** 加注之后开司跟注（含再加注）的比例。 */
    callRate: Interval;
    /** 平均赢得命数（含被弃牌的那些局）。 */
    avgLives: number;
    /** 摊牌收场的比例：太低说明大牌全在吓跑对手。 */
    showdownRate: number;
  };
  weak: {
    /** q ≤ 0.1 的局数。 */
    n: number;
    /** 诈唬率 = 首个动作加注的比例。 */
    bluffRate: Interval;
    sizes: Record<SizeTag, number>;
    /** 诈唬成功率 = 加注之后开司弃牌的比例。 */
    successRate: Interval;
    avgLives: number;
  };
  rounds: number;
}

const emptySizes = (): Record<SizeTag, number> => ({ min: 0, mid: 0, allin: 0 });
function sizeShare(list: RoundObs[]): Record<SizeTag, number> {
  const c = emptySizes();
  let tot = 0;
  for (const o of list) {
    if (!o.openSize) continue;
    c[o.openSize] += 1;
    tot += 1;
  }
  if (tot > 0) for (const k of ["min", "mid", "allin"] as SizeTag[]) c[k] /= tot;
  return c;
}
const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * 价值提取：牌力最强（q ≥ 0.9）时怎么下注、榨到多少；牌力最弱（q ≤ 0.1）时诈唬多少、成功多少。
 *
 * 这两组合起来才有意义：强牌只会全下 + 对手几乎不跟 = 大牌白拿；
 * 弱牌从不诈唬 = 强牌那边的加注就是纯信号，对手照着弃就行。
 */
export function valueExtraction(
  bot: BotSide = defaultBot(),
  games = 12,
  seed = 43,
  opponent: Strategy = tight
): ValueExtraction {
  const { obs } = observe(opponent, games, seed, bot);
  const strong = obs.filter((o) => o.q >= 0.9);
  const weak = obs.filter((o) => o.q <= 0.1);
  const raised = (l: RoundObs[]) => l.filter((o) => o.openAction === "raise");
  const sr = raised(strong);
  const wr = raised(weak);
  return {
    strong: {
      n: strong.length,
      raiseRate: wilson(sr.length, strong.length),
      sizes: sizeShare(strong),
      callRate: wilson(sr.filter((o) => o.oppReply === "call" || o.oppReply === "raise").length, sr.filter((o) => o.oppReply != null).length),
      avgLives: avg(strong.map((o) => o.lives)),
      showdownRate: ratio(strong.filter((o) => o.reason === "showdown").length, strong.length)
    },
    weak: {
      n: weak.length,
      bluffRate: wilson(wr.length, weak.length),
      sizes: sizeShare(weak),
      successRate: wilson(wr.filter((o) => o.oppReply === "fold").length, wr.filter((o) => o.oppReply != null).length),
      avgLives: avg(weak.map((o) => o.lives))
    },
    rounds: obs.length
  };
}

// ---------- 指标 3：泄露度量 ----------

/** `measureTells` 的失败线：`aucAbs` 超过这个值就是「加注额直接出卖了整张牌」。 */
export const TELL_AUC_ABS_MAX = 0.75;

/**
 * AUC 的标准误（Hanley–McNeil）。
 * 二百多个样本下 SE ≈ 0.03，所以 0.75 vs 0.76 这种差别一半是噪声 —— 失败线要卡在区间上，
 * 否则每次改动都会随机翻红，红了也没人信。
 */
export function aucStdErr(auc: number, nPos: number, nNeg: number): number {
  if (!Number.isFinite(auc) || nPos < 1 || nNeg < 1) return NaN;
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  const v = (auc * (1 - auc) + (nPos - 1) * (q1 - auc * auc) + (nNeg - 1) * (q2 - auc * auc)) / (nPos * nNeg);
  return Math.sqrt(Math.max(0, v));
}

export interface TellMetrics {
  auc: number;
  aucAbs: number;
  /** `aucAbs` 的 95% 区间（Hanley–McNeil 正态近似）。 */
  aucAbsLo: number;
  aucAbsHi: number;
  spearman: number;
  spearmanAbs: number;
  samples: number;
  raiseRate: number;
  betMedian: number;
  selectMedian: number;
  /** aucAbs 与 0.5 的距离折算成「可读性」：|aucAbs − 0.5| × 2 ∈ [0,1]。 */
  readability: number;
  /** 点估计是否在失败线以内（超了先当警告）。 */
  ok: boolean;
  /** `aucAbs` 的 95% 下界是否**已经**高于失败线 —— 这才是真的红。 */
  significant: boolean;
}

export function tellMetrics(
  bot: BotSide | undefined = undefined,
  games = 20,
  seed = 31,
  opponent: Strategy = tight
): TellMetrics {
  const t: TellStats = measureTells(bot, games, seed, opponent);
  const nUp = t.raw.filter((r) => r.rank >= 8).length;
  const se = aucStdErr(t.aucAbs, nUp, t.raw.length - nUp);
  const half = Number.isNaN(se) ? NaN : 1.959964 * se;
  return {
    auc: t.auc,
    aucAbs: t.aucAbs,
    aucAbsLo: Number.isNaN(half) ? NaN : Math.max(0, t.aucAbs - half),
    aucAbsHi: Number.isNaN(half) ? NaN : Math.min(1, t.aucAbs + half),
    spearman: t.spearman,
    spearmanAbs: t.spearmanAbs,
    samples: t.samples,
    raiseRate: t.raiseRate,
    betMedian: t.bet.median,
    selectMedian: t.select.median,
    readability: Number.isNaN(t.aucAbs) ? NaN : Math.abs(t.aucAbs - 0.5) * 2,
    // 点估计过线只是「警告」，失败要看 95% 下界 —— 只有「显著比 0.75 还好读」才算真红。
    ok: Number.isNaN(t.aucAbs) ? true : t.aucAbs <= TELL_AUC_ABS_MAX,
    significant: Number.isNaN(half) ? false : t.aucAbs - half > TELL_AUC_ABS_MAX
  };
}

// ---------- 指标 4：可利用度探针 ----------

export interface ProbeSpot {
  key: string;
  label: string;
  /** 机器人（和也）手上的两个点数。 */
  ai: number[];
  /** 开司手上的两个点数。 */
  player: number[];
  firstMover: Side;
  /** 开司先最小加注一手（机器人于是在「面对加注」的节点上做决策）。 */
  faceMinRaise?: boolean;
}

/** 三个固定局面：12 命、无历史、p = 0。 */
export const PROBE_SPOTS: ProbeSpot[] = [
  { key: "mix-vs-mix", label: "MIX vs MIX（我先手）", ai: [13, 5], player: [12, 4], firstMover: "ai" },
  { key: "up2-vs-down2", label: "UP2 vs DOWN2（我先手）", ai: [13, 11], player: [5, 3], firstMover: "ai" },
  { key: "down2-vs-mix", label: "DOWN2 vs MIX（面对最小加注）", ai: [5, 3], player: [12, 4], firstMover: "player", faceMinRaise: true }
];

/** 造一个固定局面：把指定点数塞进双方手里，双方各盖一张。 */
function buildSpot(spot: ProbeSpot, lives: number): GameState {
  const rng = seededRng(7);
  const s = newGame({ rng, firstMover: spot.firstMover, playerLives: lives, aiLives: lives });
  startRound(s, rng);
  const take = (r: number) => {
    const i = s.deck.findIndex((c) => c.rank === r);
    if (i < 0) throw new Error(`牌堆里没有点数 ${r} 了`);
    return s.deck.splice(i, 1)[0];
  };
  s.deck.push(...s.players.ai.hand, ...s.players.player.hand);
  s.players.ai.hand = spot.ai.map(take);
  s.players.player.hand = spot.player.map(take);
  selectCard(s, "player", s.players.player.hand[0].id);
  selectCard(s, "ai", s.players.ai.hand[0].id);
  if (spot.faceMinRaise) act(s, "player", { type: "raise", raiseTo: legalBets(s, "player").minRaiseTo });
  return s;
}

export interface ProbeResult {
  key: string;
  label: string;
  iters: number;
  /** NashConv，单位是命（已除以 unitUtility）。 */
  nashConvLives: number;
  /** 我方 / 开司各自的最佳回应增益（命）。 */
  brMeLives: number;
  brOppLives: number;
  /** 执行剪枝之后的 NashConv（命）——剪枝送掉了多少可利用度。 */
  prunedLives: number;
  nodeCount: number;
  ms: number;
}

/**
 * 可利用度探针：三个固定局面各求解一次，p = 0（严格零和，NashConv 就是标准可利用度）。
 *
 * 终局估值用线性的 `uWithEdge(d, ...)`——**不含**留牌价值。留牌价值是 Stage C 在改的东西，
 * 把它混进来这条曲线就随 bot.ts 一起漂移，探针也就不再是「求解器收敛得怎么样」的度量了。
 * `iters` 两档一起记，是因为 Stage S 发现 200 次时 MIX vs MIX 的 nashConv 非单调（0.65 命）。
 */
export function exploitabilityProbe(itersList = [200, 400], lives = 12): ProbeResult[] {
  const out: ProbeResult[] = [];
  for (const spot of PROBE_SPOTS) {
    const s = buildSpot(spot, lives);
    const view = publicView(s);
    const A = analyze(view);
    const T = view.lives.ai + view.lives.player;
    const unit = unitUtility(view.lives.ai, T);
    const base: Omit<SolveInput, "iters"> = {
      myPrior: perceivedRange(view.lights.ai, A.theirs),
      oppPrior: A.played,
      q: A.q,
      model: A.model,
      p: 0,
      M: view.maxStake,
      meFirst: view.firstMover === AI,
      LOpp: view.lives.player,
      oppMix: view.lights.player.up === 1 && view.lights.player.down === 1,
      val: (_rank: number, d: number) => uWithEdge(d, view.lives.ai, T, PARAMS.solveEdge),
      edge: PARAMS.solveEdge,
      actions: view.actions
    };
    for (const iters of itersList) {
      const t0 = performance.now();
      const sol = solve({ ...base, iters });
      const e = sol.exploitability();
      const pruned = sol.exploitabilityOf(SOLVER_PARAMS.executionPrune);
      out.push({
        key: spot.key,
        label: spot.label,
        iters,
        nashConvLives: e.nashConv / unit,
        brMeLives: (e.brMe - e.valueMe) / unit,
        brOppLives: (e.brOpp - e.valueOpp) / unit,
        prunedLives: pruned.nashConv / unit,
        nodeCount: sol.nodeCount,
        ms: performance.now() - t0
      });
    }
  }
  return out;
}

// ---------- 指标 5：适应曲线 ----------

export interface AdaptationBand {
  label: string;
  from: number;
  to: number;
  /** 面对最小加注时不弃牌（跟注或反加）的比例。 */
  defend: Interval;
  /** 其中纯跟注的比例。 */
  call: Interval;
}

export interface AdaptationCurve {
  bands: AdaptationBand[];
  /** 三段的 defend 点估计是否单调不降。 */
  monotone: boolean;
  samples: number;
  rounds: number;
}

const BANDS: [string, number, number][] = [["1–5 局", 1, 5], ["6–15 局", 6, 15], ["16–30 局", 16, 30]];

/**
 * 适应曲线：对 `mixDownBluffer` 打若干场，看机器人面对它「最小加注」时的防守率随局数怎么变。
 *
 * 这个对手在 MIX 局里 70% 拿 DOWN 牌小注诈唬，先验下机器人应当弃得太多；
 * D5 的联合统计一旦学到「他在 MIX 局的小注是诈唬」，防守率就该一段比一段高。
 */
export function adaptationCurve(
  bot: BotSide = defaultBot(),
  games = 30,
  seed = 47,
  opponent: Strategy = mixDownBluffer
): AdaptationCurve {
  const { obs } = observe(opponent, games, seed, bot);
  const faced = obs.filter((o) => o.facedAction != null && o.facedAmount === 1);
  const bands = BANDS.map(([label, from, to]) => {
    const list = faced.filter((o) => o.round >= from && o.round <= to);
    const defended = list.filter((o) => o.facedAction !== "fold").length;
    const called = list.filter((o) => o.facedAction === "call").length;
    return { label, from, to, defend: wilson(defended, list.length), call: wilson(called, list.length) };
  });
  const ps = bands.map((b) => b.defend.p);
  return {
    bands,
    monotone: ps[0] <= ps[1] + 1e-9 && ps[1] <= ps[2] + 1e-9,
    samples: faced.length,
    rounds: obs.length
  };
}
