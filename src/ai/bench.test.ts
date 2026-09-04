/**
 * 机器人基准测评（阶段 B）。
 *
 * 四块内容，全部写进一份 JSON（`bench/<时间戳>.json`，并复制到 `BENCH_OUT`）：
 *  1. 胜率表：对 `BENCH_STRATEGIES` 每个对手打 `BENCH_GAMES × BENCH_SEEDS` 场，给 Wilson 95% 区间。
 *  2. 头对头：`mirror()` 让 v0.1.10 快照打自己（应接近 50%，验证镜像没翻错边），再拿当前机器人对快照。
 *  3. 泄露度量：tellAUC / Spearman / 决策耗时（`metrics.tellMetrics`）。
 *  4. 行为指标：MIX 选牌率、价值提取、可利用度探针、适应曲线（`metrics.ts`）。
 *
 * 环境变量（全部可选）：
 *   BENCH_GAMES=40            每个 seed 打几场
 *   BENCH_SEEDS=11            逗号分隔的 seed 列表
 *   BENCH_LIVES=12            初始命数
 *   BENCH_OPPONENTS=          逗号分隔的对手（英文 id 或中文名），留空 = 全部
 *   BENCH_OUT=bench/latest.json  结果 JSON 的副本路径
 *   BENCH_METRIC_GAMES=       行为指标各跑几场（默认 min(BENCH_GAMES, 12)）
 *   BENCH_METRICS=1           设 0 跳过第 3、4 块（只要胜率表时用）
 *   BENCH_H2H=1               设 0 跳过头对头（很贵）
 *   BENCH_TAG=                写进 JSON 的自由标签，扫参时标注这一跑是什么
 *   BENCH_MIN_RATE=0.5        每个对手的胜率点估计下限
 *   BENCH_MIN_LOWER=0.45      每个对手的 Wilson 95% 下界下限
 *   BENCH_MIN_H2H=            头对头「当前 vs 快照」的绝对门槛；不设就只要求「95% 上界够得着 50%」
 *
 * 失败线的口径：对手胜率这一块卡的是**下界**（要「基本确定赢」），头对头与 tellAUC 卡的是
 * **区间**（只有「显著变差」才红）。这不是双标 —— 前者的效应量是几十个百分点，40 场就分得开；
 * 后者是几个百分点，卡点估计的话每次改动都在掷硬币，红了没人信的失败线等于没有失败线。
 * 点估计一律照常打印并写进 JSON，看趋势用它。
 *
 * 注意：vitest 4 默认不打印 console.log，看表格要加 `--reporter=verbose`
 * （`npm run bench` 已经带上了）。不看也行 —— 同样的数字都在 JSON 里。
 */
import { afterAll, describe, expect, it } from "vitest";
import { MODEL_PARAMS, PARAMS, SOLVER_PARAMS } from "./bot.js";
import {
  BENCH_STRATEGIES,
  type BotSide,
  type LatencyStats,
  type Strategy,
  botAsKaiji,
  simulate,
  strategyByName,
  strategyId
} from "./sim.js";
import {
  type AdaptationCurve,
  type Interval,
  type MixSelection,
  type ProbeResult,
  type TellMetrics,
  type ValueExtraction,
  TELL_AUC_ABS_MAX,
  adaptationCurve,
  exploitabilityProbe,
  mixSelectionRate,
  tellMetrics,
  valueExtraction,
  wilson
} from "./metrics.js";
import { prevBot } from "./prevBot.js";

// ---------- Node 环境 ----------
//
// 仓库里没有 `@types/node`（前端项目，`tsconfig.types` 只有 `vite/client`），而 bench 又必须读
// 环境变量、写文件。为了不为一个测试文件引一个依赖，这里手写最小的类型：
// `process` 从 `globalThis` 上取，`node:fs` 之类用「说明符是变量」的动态 import 绕开模块解析。
interface NodeProcess {
  env: Record<string, string | undefined>;
  version: string;
}
const proc = (globalThis as { process?: NodeProcess }).process;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeRequire = (m: string): Promise<any> => import(/* @vite-ignore */ m);

// ---------- 配置 ----------

const env = (k: string, d: string) => proc?.env[k]?.trim() || d;
const num = (k: string, d: number) => {
  const v = Number(env(k, String(d)));
  return Number.isFinite(v) ? v : d;
};
const flag = (k: string, d: boolean) => env(k, d ? "1" : "0") !== "0";

const GAMES = Math.max(1, Math.round(num("BENCH_GAMES", 40)));
const SEEDS = env("BENCH_SEEDS", "11").split(",").map((x) => Number(x.trim())).filter(Number.isFinite);
const LIVES = Math.max(1, Math.round(num("BENCH_LIVES", 12)));
const OUT = env("BENCH_OUT", "bench/latest.json");
const METRIC_GAMES = Math.max(1, Math.round(num("BENCH_METRIC_GAMES", Math.min(GAMES, 12))));
const RUN_METRICS = flag("BENCH_METRICS", true);
const RUN_H2H = flag("BENCH_H2H", true);
const TAG = env("BENCH_TAG", "");
const MIN_RATE = num("BENCH_MIN_RATE", 0.5);
const MIN_LOWER = num("BENCH_MIN_LOWER", 0.45);
/** 头对头「当前 vs 快照」的绝对门槛；不设（默认）就用「95% 上界够得着 50%」这条区间线。 */
const MIN_H2H = env("BENCH_MIN_H2H", "") ? num("BENCH_MIN_H2H", 0.5) : null;
const TIMEOUT = 3600000;

const OPPONENTS: Strategy[] = (() => {
  const raw = env("BENCH_OPPONENTS", "");
  if (!raw) return BENCH_STRATEGIES;
  const out: Strategy[] = [];
  for (const name of raw.split(",")) {
    const s = strategyByName(name);
    if (!s) throw new Error(`BENCH_OPPONENTS 里没有这个对手：「${name}」；可选：${BENCH_STRATEGIES.map(strategyId).join(", ")}`);
    out.push(s);
  }
  return out;
})();

const N = GAMES * SEEDS.length;

// ---------- 输出 ----------

/** 中日文字符按两格宽度对齐。 */
function pad(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += /[⺀-鿿＀-￯]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}
const pctText = (v: number) => (Number.isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const ivText = (i: Interval) => `${pctText(i.p)} [${pctText(i.lo)}, ${pctText(i.hi)}]`;
const ms = (v: number) => `${v.toFixed(2)} ms`;
const latText = (l: LatencyStats) => `中位 ${ms(l.median)} / 均值 ${ms(l.mean)} / 最大 ${ms(l.max)}（${l.count} 次）`;
const num3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : "—");

async function gitHead(): Promise<string> {
  try {
    const cp = await nodeRequire("node:child_process");
    return String(cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).trim();
  } catch {
    return "unknown";
  }
}

interface OppRow {
  id: string;
  name: string;
  wins: number;
  losses: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
  avgRounds: number;
  betMedian: number;
  selectMedian: number;
  seconds: number;
  perSeed: { seed: number; wins: number; losses: number }[];
}
interface H2HRow {
  label: string;
  lives: number;
  games: number;
  wins: number;
  losses: number;
  rate: number;
  lo: number;
  hi: number;
  avgRounds: number;
  seconds: number;
}

const report: {
  ts: string;
  head: string;
  tag: string;
  node: string;
  config: Record<string, unknown>;
  params: Record<string, unknown>;
  opponents: OppRow[];
  h2h: H2HRow[];
  tells: Record<string, TellMetrics>;
  metrics: {
    mixSelection?: MixSelection;
    valueExtraction?: ValueExtraction;
    exploitability?: ProbeResult[];
    adaptation?: AdaptationCurve;
  };
} = {
  ts: new Date().toISOString(),
  head: "unknown", // 最后写 JSON 时填（`git rev-parse` 得先 await 动态 import）
  tag: TAG,
  node: proc?.version ?? "unknown",
  config: { games: GAMES, seeds: SEEDS, lives: LIVES, metricGames: METRIC_GAMES, opponents: OPPONENTS.map(strategyId), minRate: MIN_RATE, minLower: MIN_LOWER, minH2H: MIN_H2H, tellAucAbsMax: TELL_AUC_ABS_MAX },
  params: { PARAMS: { ...PARAMS }, SOLVER_PARAMS: { ...SOLVER_PARAMS }, MODEL_PARAMS: { ...MODEL_PARAMS } },
  opponents: [],
  h2h: [],
  tells: {},
  metrics: {}
};

// ---------- 1. 胜率表 ----------

describe("bench: 对各基准对手的胜率", () => {
  for (const strategy of OPPONENTS) {
    it(
      `机器人对「${strategy.name}」：点估计 ≥ ${MIN_RATE}，Wilson 下界 ≥ ${MIN_LOWER}`,
      () => {
        const t0 = performance.now();
        let wins = 0;
        let losses = 0;
        let rounds = 0;
        const betMs: number[] = [];
        const selMs: number[] = [];
        const perSeed: { seed: number; wins: number; losses: number }[] = [];
        for (const seed of SEEDS) {
          const r = simulate(strategy, GAMES, seed, LIVES);
          wins += r.wins;
          losses += r.losses;
          rounds += r.rounds;
          betMs.push(r.bet.median);
          selMs.push(r.select.median);
          perSeed.push({ seed, wins: r.wins, losses: r.losses });
        }
        const w = wilson(wins, wins + losses);
        report.opponents.push({
          id: strategyId(strategy),
          name: strategy.name,
          wins,
          losses,
          n: wins + losses,
          rate: w.p,
          lo: w.lo,
          hi: w.hi,
          avgRounds: rounds / (wins + losses),
          betMedian: median(betMs),
          selectMedian: median(selMs),
          seconds: (performance.now() - t0) / 1000,
          perSeed
        });
        expect(w.p).toBeGreaterThanOrEqual(MIN_RATE);
        expect(w.lo).toBeGreaterThanOrEqual(MIN_LOWER);
      },
      TIMEOUT
    );
  }

  afterAll(() => {
    if (report.opponents.length === 0) return;
    const head = `${pad("对手", 16)}${pad("胜/负", 12)}${pad("胜率", 9)}${pad("Wilson 95%", 20)}${pad("平均局数", 12)}${pad("botBet 中位", 14)}耗时`;
    console.log(
      [
        `\n=== 胜率表（${GAMES} 局 × ${SEEDS.length} seed = ${N} 场 / ${LIVES} 命 / seeds ${SEEDS.join(",")}）===`,
        head,
        ...report.opponents.map((r) =>
          `${pad(r.name, 16)}${pad(`${r.wins}/${r.losses}`, 12)}${pad(pctText(r.rate), 9)}` +
          `${pad(`[${pctText(r.lo)}, ${pctText(r.hi)}]`, 20)}${pad(r.avgRounds.toFixed(1), 12)}` +
          `${pad(ms(r.betMedian), 14)}${r.seconds.toFixed(1)}s`
        ),
        `失败线：点估计 ≥ ${pctText(MIN_RATE)} 且 Wilson 下界 ≥ ${pctText(MIN_LOWER)}`,
        ""
      ].join("\n")
    );
  });
});

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// ---------- 2. 头对头 ----------

/**
 * 两个用途，别混在一起看：
 *
 *  1. `快照 vs 快照`——用 `mirror()` 让同一份 v0.1.10 代码坐到开司一侧打自己。两边完全相同，
 *     胜率就该在 50% 附近；偏到 0% / 100% 说明 `mirror()` 翻错了边或者快照坏了。
 *  2. `当前 vs 快照`——衡量「现在的机器人比 v0.1.10 强多少」。这一行的失败线是点估计 ≥ 50%：
 *     改到比上一版还差就该红。
 *
 * 30 命那组很贵（`botBet` 在 M=30 时要枚举 29 个加注额），所以只跑几场当健全性检查。
 */
const H2H: { label: string; lives: number; games: number; self: boolean }[] = [
  { label: "快照 vs 快照（镜像自对局）", lives: LIVES, games: GAMES, self: true },
  { label: "当前 vs 快照", lives: LIVES, games: GAMES, self: false },
  { label: "当前 vs 快照（深筹码）", lives: 30, games: Math.max(2, Math.round(GAMES / 7)), self: false }
];

describe.skipIf(!RUN_H2H)("bench: 对 v0.1.10 快照头对头", () => {
  for (const { label, lives, games, self } of H2H) {
    it(
      `${label}（${lives} 命 / ${games} 场）`,
      () => {
        const t0 = performance.now();
        const kaiji = botAsKaiji("v0.1.10 快照", prevBot);
        const seed = SEEDS[0];
        const r = self ? simulate(kaiji, games, seed, lives, prevBot) : simulate(kaiji, games, seed, lives);
        const w = wilson(r.wins, games);
        report.h2h.push({
          label,
          lives,
          games,
          wins: r.wins,
          losses: r.losses,
          rate: w.p,
          lo: w.lo,
          hi: w.hi,
          avgRounds: r.rounds / games,
          seconds: (performance.now() - t0) / 1000
        });
        expect(r.wins + r.losses).toBe(games);
        expect(r.rounds).toBeGreaterThan(games);
        // 只有「两边同一份代码」的那一组才该落在 50% 附近。
        if (self) {
          expect(w.p).toBeGreaterThan(0.25);
          expect(w.p).toBeLessThan(0.75);
        } else if (lives === LIVES) {
          // 失败线是「不能**显著**输给上一版」，也就是 Wilson 95% 上界还够得着 50%。
          //
          // 为什么不直接卡点估计 ≥ 50%：40 场的 95% 区间有 ±15 个百分点宽，而且同一份代码
          // 自对局（上面那一行）在 seed 11 上也只有 30% —— 座位 / 种子本身就有这么大的抖动。
          // 卡点估计等于让这条线一半时间在掷硬币。想要严格的绝对门槛就设 BENCH_MIN_H2H=0.5。
          if (MIN_H2H != null) expect(w.p).toBeGreaterThanOrEqual(MIN_H2H);
          else expect(w.hi, `当前机器人显著输给 v0.1.10 快照：${(w.p * 100).toFixed(1)}% [${(w.lo * 100).toFixed(1)}%, ${(w.hi * 100).toFixed(1)}%]`).toBeGreaterThanOrEqual(0.5);
        }
      },
      TIMEOUT
    );
  }

  afterAll(() => {
    if (report.h2h.length === 0) return;
    console.log(
      [
        `\n=== 头对头（seed ${SEEDS[0]}）===`,
        `${pad("对阵", 30)}${pad("命数", 8)}${pad("场数", 8)}${pad("胜/负", 12)}${pad("胜率", 9)}${pad("Wilson 95%", 20)}${pad("平均局数", 12)}耗时`,
        ...report.h2h.map((r) =>
          `${pad(r.label, 30)}${pad(String(r.lives), 8)}${pad(String(r.games), 8)}${pad(`${r.wins}/${r.losses}`, 12)}` +
          `${pad(pctText(r.rate), 9)}${pad(`[${pctText(r.lo)}, ${pctText(r.hi)}]`, 20)}${pad(r.avgRounds.toFixed(1), 12)}${r.seconds.toFixed(1)}s`
        ),
        "注：「胜率」是 ai 一侧（当前机器人 / 自对局时是快照）的胜率。",
        ""
      ].join("\n")
    );
  });
});

// ---------- 3. 泄露度量 ----------

const TELL_SEED = 31;

describe.skipIf(!RUN_METRICS)("bench: 泄露度量与决策耗时", () => {
  const SUBJECTS: { key: string; label: string; bot: BotSide | undefined }[] = [
    { key: "current", label: "当前机器人", bot: undefined },
    { key: "prev", label: "v0.1.10 快照", bot: prevBot }
  ];
  for (const { key, label, bot } of SUBJECTS) {
    it(
      `tellAUC / Spearman / 决策耗时：${label}（对稳健型打 ${METRIC_GAMES} 场）`,
      () => {
        const t = tellMetrics(bot, METRIC_GAMES, TELL_SEED);
        report.tells[key] = t;
        console.log(
          [
            `\n=== 泄露度量：${label} vs 稳健型（${METRIC_GAMES} 场 / ${LIVES} 命 / seed ${TELL_SEED}）===`,
            `样本：${t.samples} 次（双方押注相同时的首个动作），加注率 ${pctText(t.raiseRate)}`,
            `tellAUC 主指标（「是否加注」预测「同灯类别内强度 ≥ 0.5」）：${num3(t.auc)}`,
            `  Spearman（加注额度 f vs 类内强度）：${num3(t.spearman)}`,
            `tellAUC 副指标 aucAbs（「是否加注」预测「打出的是 UP 牌」）：${num3(t.aucAbs)} ` +
            `[${num3(t.aucAbsLo)}, ${num3(t.aucAbsHi)}]  失败线 ≤ ${TELL_AUC_ABS_MAX}${t.ok ? "" : "  ← 点估计已过线"}`,
            `  Spearman（加注额度 f vs 绝对点数）：${num3(t.spearmanAbs)}`,
            `  可读性 |aucAbs − 0.5|×2 = ${num3(t.readability)}（0 = 读不出，1 = 加注即强牌）`,
            `botBet 中位 ${ms(t.betMedian)} / botSelect 中位 ${ms(t.selectMedian)}`,
            ""
          ].join("\n")
        );
        // 每场至少若干局，所以样本数总该多于场数；这里只是防「一个样本都没采到」。
        expect(t.samples).toBeGreaterThan(METRIC_GAMES);
        expect(t.aucAbs).toBeGreaterThanOrEqual(0);
        expect(t.aucAbs).toBeLessThanOrEqual(1);
        // 失败线只卡「当前机器人」：快照那一行是冻结的参照物，坏了也没法改。
        //
        // 卡的是 95% 下界而不是点估计：AUC 在两百来个样本下的标准误约 0.03，
        // 点估计 0.75 vs 0.76 一半是噪声，直接卡点估计的话每次改动都会随机翻红 ——
        // 红了没人信的失败线等于没有失败线。点估计仍然打印 + 写进 JSON，看趋势用它。
        if (key === "current") {
          expect(
            t.significant,
            `aucAbs = ${num3(t.aucAbs)}，95% 下界 ${num3(t.aucAbsLo)} 已经高于失败线 ${TELL_AUC_ABS_MAX}：` +
            "「是否加注」几乎直接出卖了打出的是 UP 还是 DOWN 牌。"
          ).toBe(false);
        }
      },
      TIMEOUT
    );
  }
});

// ---------- 4. 行为指标 ----------

describe.skipIf(!RUN_METRICS)("bench: 行为指标", () => {
  it(
    `MIX 选牌率（${METRIC_GAMES} 场）`,
    () => {
      const m = mixSelectionRate(undefined, METRIC_GAMES, 41);
      report.metrics.mixSelection = m;
      console.log(
        [
          `\n=== MIX 选牌率（${METRIC_GAMES} 场 / seed 41）===`,
          `MIX 灯 ${m.n} 局（UP2 ${m.up2} / DOWN2 ${m.down2} / 共 ${m.rounds} 局）`,
          `P(打出 DOWN)：${ivText(m.downRate)}  ← 一边倒说明选牌是确定性的，对手看灯就知道你出什么`,
          `  两张都赢（胜率均 ≥ 0.5）：${ivText(m.bothWin)}`,
          `  两张都输：${ivText(m.bothLose)}`,
          `  一赢一输：${ivText(m.split)}`,
          ""
        ].join("\n")
      );
      expect(m.rounds).toBeGreaterThan(0);
      expect(m.downRate.p).toBeGreaterThanOrEqual(0);
      expect(m.downRate.p).toBeLessThanOrEqual(1);
    },
    TIMEOUT
  );

  it(
    `价值提取与诈唬（${METRIC_GAMES} 场）`,
    () => {
      const v = valueExtraction(undefined, METRIC_GAMES, 43);
      report.metrics.valueExtraction = v;
      const sizes = (s: Record<string, number>) => `min ${pctText(s.min)} / mid ${pctText(s.mid)} / allin ${pctText(s.allin)}`;
      console.log(
        [
          `\n=== 价值提取（${METRIC_GAMES} 场 / seed 43，共 ${v.rounds} 局）===`,
          `强牌 q ≥ 0.9：${v.strong.n} 局`,
          `  首个动作加注率：${ivText(v.strong.raiseRate)}`,
          `  加注额分布：${sizes(v.strong.sizes)}`,
          `  开司跟注（含反加）率：${ivText(v.strong.callRate)}  ← 太低 = 大码把人全吓跑了`,
          `  平均赢得命数：${num3(v.strong.avgLives)}，摊牌收场 ${pctText(v.strong.showdownRate)}`,
          `弱牌 q ≤ 0.1：${v.weak.n} 局`,
          `  诈唬率（首个动作加注）：${ivText(v.weak.bluffRate)}`,
          `  诈唬额分布：${sizes(v.weak.sizes)}`,
          `  诈唬成功率（开司弃牌）：${ivText(v.weak.successRate)}`,
          `  平均命数变化：${num3(v.weak.avgLives)}`,
          ""
        ].join("\n")
      );
      expect(v.rounds).toBeGreaterThan(0);
    },
    TIMEOUT
  );

  it(
    "可利用度探针（3 个固定局面 × iters {200, 400}）",
    () => {
      const p = exploitabilityProbe([200, 400], LIVES);
      report.metrics.exploitability = p;
      console.log(
        [
          `\n=== 可利用度探针（p = 0，${LIVES} 命，无历史；单位：命）===`,
          `${pad("局面", 30)}${pad("iters", 8)}${pad("NashConv", 12)}${pad("我方 BR", 12)}${pad("开司 BR", 12)}${pad("剪枝后", 12)}耗时`,
          ...p.map((r) =>
            `${pad(r.label, 30)}${pad(String(r.iters), 8)}${pad(r.nashConvLives.toFixed(4), 12)}` +
            `${pad(r.brMeLives.toFixed(4), 12)}${pad(r.brOppLives.toFixed(4), 12)}${pad(r.prunedLives.toFixed(4), 12)}${r.ms.toFixed(0)} ms`
          ),
          `当前 SOLVER_PARAMS.iters = ${SOLVER_PARAMS.iters}；「剪枝后」= 我方策略按 executionPrune=${SOLVER_PARAMS.executionPrune} 归零再算的 NashConv。`,
          ""
        ].join("\n")
      );
      expect(p.length).toBe(6);
      for (const r of p) expect(r.nashConvLives).toBeGreaterThanOrEqual(0);
    },
    TIMEOUT
  );

  it(
    `适应曲线：对「MIX 诈唬」的最小加注（${METRIC_GAMES} 场）`,
    () => {
      const a = adaptationCurve(undefined, METRIC_GAMES, 47);
      report.metrics.adaptation = a;
      console.log(
        [
          `\n=== 适应曲线（对「MIX 诈唬」的最小加注，${METRIC_GAMES} 场 / seed 47）===`,
          `${pad("局段", 12)}${pad("样本", 8)}${pad("防守率（不弃牌）", 26)}纯跟注率`,
          ...a.bands.map((b) => `${pad(b.label, 12)}${pad(String(b.defend.n), 8)}${pad(ivText(b.defend), 26)}${ivText(b.call)}`),
          `共 ${a.samples} 个「面对最小加注」的样本 / ${a.rounds} 局；防守率单调不降：${a.monotone ? "是" : "否"}`,
          "  ← 学到「他在 MIX 局的小注是诈唬」之后，这条线应当一段比一段高。",
          ""
        ].join("\n")
      );
      expect(a.rounds).toBeGreaterThan(0);
    },
    TIMEOUT
  );
});

// ---------- 写 JSON ----------

afterAll(async () => {
  report.head = await gitHead();
  const fs = await nodeRequire("node:fs");
  const path = await nodeRequire("node:path");
  const stamp = report.ts.replace(/[:.]/g, "-");
  const file = path.join("bench", `${stamp}${TAG ? `-${TAG}` : ""}.json`);
  fs.mkdirSync("bench", { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.copyFileSync(file, OUT);
  }
  console.log(`\n结果已写入 ${file}${OUT ? ` （副本：${OUT}）` : ""}\n`);
});
