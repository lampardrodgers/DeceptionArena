# bench/ —— 机器人基准测评

这个目录只放**说明**。测评跑出来的 `*.json` 是本机一次性产物，已经在 `.gitignore` 里
（`bench/*` 忽略、`!bench/README.md` 保留），不要提交。

跑测评：

```sh
npm run bench            # = vitest run src/ai/bench.test.ts --reporter=verbose
```

**必须带 `--reporter=verbose`**：vitest 4 的默认 reporter 不打印 `console.log`，
不加就只剩一行 “Tests passed”。表格与指标同时也写进 JSON，所以不看终端也不会丢数据。

## 输出

每跑一次写两个文件：

- `bench/<ISO 时间戳>[-<BENCH_TAG>].json` —— 归档，永不覆盖；
- `BENCH_OUT`（默认 `bench/latest.json`）—— 上一份的副本，脚本 / diff 用固定路径读它。

JSON 结构：

```jsonc
{
  "ts": "…", "head": "<git rev-parse HEAD>", "tag": "<BENCH_TAG>", "node": "v22…",
  "config":  { "games": 40, "seeds": [11], "lives": 12, "metricGames": 12,
               "opponents": ["random", …], "minRate": 0.5, "minLower": 0.45 },
  "params":  { "PARAMS": {…}, "SOLVER_PARAMS": {…}, "MODEL_PARAMS": {…} },  // 参数快照
  "opponents": [ { "id": "tight", "name": "稳健", "wins": 26, "losses": 14,
                   "rate": 0.65, "lo": 0.49, "hi": 0.78,      // Wilson 95%
                   "avgRounds": 18.4, "betMedian": 31.2, "selectMedian": 240.1,
                   "seconds": 120.4, "perSeed": [ { "seed": 11, "wins": 26, "losses": 14 } ] } ],
  "h2h":     [ { "label": "当前 vs 快照", "lives": 12, "games": 40, "rate": …, "lo": …, "hi": … } ],
  "tells":   { "current": {…}, "prev": {…} },   // tellMetrics
  "metrics": { "mixSelection": {…}, "valueExtraction": {…},
               "exploitability": […], "adaptation": {…} }
}
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BENCH_GAMES` | `40` | 每个 seed 打几场 |
| `BENCH_SEEDS` | `11` | 逗号分隔的 seed 列表；总场数 = `GAMES × seeds` |
| `BENCH_LIVES` | `12` | 初始命数 |
| `BENCH_OPPONENTS` | 全部 | 逗号分隔，英文 id 或中文名（见下表）；留空 = 全部 |
| `BENCH_OUT` | `bench/latest.json` | 结果副本路径；设空串则不复制 |
| `BENCH_METRIC_GAMES` | `min(GAMES, 12)` | 行为指标各跑几场 |
| `BENCH_METRICS` | `1` | 设 `0` 跳过泄露度量 + 行为指标 |
| `BENCH_H2H` | `1` | 设 `0` 跳过头对头（很贵，尤其 30 命那组） |
| `BENCH_TAG` | 空 | 写进 JSON 并附在归档文件名上，扫参时标注这一跑是什么 |
| `BENCH_MIN_RATE` | `0.5` | 每个对手的**胜率点估计**下限 |
| `BENCH_MIN_LOWER` | `0.45` | 每个对手的 **Wilson 95% 下界**下限 |
| `BENCH_MIN_H2H` | 空 | 头对头「当前 vs 快照」的绝对门槛；不设则只要求「95% 上界够得着 50%」 |

对手 id（`src/ai/sim.ts` 的 `STRATEGY_IDS`，按「越靠后越针对可读性」排列）：

```
random station tight oldBot checkPunisher tellReader polarized bluffer
switcher sizeSwitcher counterLearner minRaiseLadder mixDownBluffer onlineReader trapper
```

后四个是阶段 B 新增的：

- `minRaiseLadder` **阶梯小注**：开局与回应一律最小加注，被再加注才按牌力跟 / 弃。
  测「对连续小注的防守」——每一步单看都便宜到必须跟，一路跟下去就是把全部押注额送进
  一个自己没有主动权的池子。
- `mixDownBluffer` **MIX 诈唬**：指示灯 UP1+DOWN1 时 70% 打出 DOWN 牌并最小加注，其余按稳健型。
  喂 D5 的「MIX 灯下选牌 + 加注」联合统计，也是 `adaptationCurve` 的陪练。
- `onlineReader` **在线读牌**：一边打一边统计机器人「首个动作的加注额 → 摊牌露出的点数」
  （`readBotSizing`，只用公开信息）。相关显著就对大码只跟绝强牌、对小码 / 过牌全面施压。
  它衡量的是「机器人的可读性能被榨出多少」——机器人越难读，这一行的胜率越低。
- `trapper` **陷阱**：强牌先过牌 / 最小加注，等机器人加注之后再重加（慢打）。测对陷阱的抵抗。

## 失败线

- 每个对手：胜率点估计 ≥ `BENCH_MIN_RATE`（默认 0.5）**且** Wilson 95% 下界 ≥ `BENCH_MIN_LOWER`（默认 0.45）。
  注意样本量：`n = 40` 时下界 0.45 要求点估计 ≈ 0.60，`n = 80`（两个 seed）时约 0.56。
  **想让下界这条线真的可信，就用 `BENCH_SEEDS=11,12` 把 n 拉到 80 以上**，
  否则这条线更像是「胜率得明显高于五五开」而不是「95% 置信不输」。
- 头对头「当前 vs 快照」（`BENCH_LIVES` 那一组）：**不能显著输给上一版**，即 Wilson 95%
  上界 ≥ 0.5。「快照 vs 快照」只检查落在 25%–75%（验证 `mirror()` 没翻错边）。
- 泄露度量 `aucAbs ≤ 0.75`（只卡当前机器人；快照那一行是冻结的参照物）。
  `aucAbs` = 用「是否加注」预测「打出的是 UP 牌」的 AUC，MIX 灯时类别本身是隐藏信息，
  所以它才是「整张牌多好读」的上界。卡的是 **95% 下界**（Hanley–McNeil）超过 0.75 才算红。

### 为什么两处的口径不一样

对手胜率卡**下界**（要「基本确定赢」），头对头与 tellAUC 卡**区间**（只有「显著变差」才红）。
这不是双标，是效应量不同：

- 对各基准对手的胜率差距是几十个百分点（当前 75%–95%），40 场就分得开，卡下界不会误伤；
- 头对头与 tellAUC 的差距是几个百分点，而 20 场的胜率区间宽 ±20 个点、
  两百多个样本的 AUC 标准误约 0.03。这两处卡点估计等于让失败线掷硬币 ——
  **红了没人信的失败线等于没有失败线**。

想要严格的绝对门槛：`BENCH_MIN_H2H=0.5`。点估计一律照常打印并写进 JSON，看趋势用它。

## 行为指标（`src/ai/metrics.ts`）

| 指标 | 看什么 |
| --- | --- |
| `mixSelectionRate` | MIX 灯时 P(打出 DOWN)，并按「两张都赢 / 都输 / 一赢一输」（`estimateWin ≥ 0.5`）分组。一边倒说明选牌是确定性的，对手看灯就知道你出什么。 |
| `valueExtraction` | 强牌（`q ≥ 0.9`）的加注额分布 min/mid/allin、开司跟注率、平均赢得命数、摊牌比例；弱牌（`q ≤ 0.1`）的诈唬率与成功率。两组要一起看：强牌只会全下 + 没人跟 = 大牌白拿；弱牌从不诈唬 = 强牌的加注就是纯信号。 |
| `tellMetrics` | `measureTells` 的封装，加 `aucAbs ≤ 0.75` 的失败线与 `readability = |aucAbs − 0.5| × 2`。 |
| `exploitabilityProbe` | 三个固定局面（MIX vs MIX 先手 / UP2 vs DOWN2 先手 / DOWN2 vs MIX 面对最小加注），12 命、无历史、`p = 0`，`solve(...).exploitability()` 的 NashConv 除以 `unitUtility` 换算成命；`iters ∈ {200, 400}` 两档都记。终局估值用线性的 `uWithEdge`，**不含**留牌价值 —— 混进来这条曲线就随 `bot.ts` 一起漂移，探针也就不再是「求解器收敛得怎么样」的度量了。 |
| `adaptationCurve` | 对 `mixDownBluffer` 的最小加注，机器人的防守率（不弃牌）按局数 1–5 / 6–15 / 16–30 三段统计。学到「他在 MIX 局的小注是诈唬」之后应当递增。 |

## 并行

单进程跑满 15 个对手很久（20 场 × 15 个对手在 10 核机器上要几十分钟）。
按对手切几份、各写各的 JSON，最后合起来看：

```sh
BENCH_GAMES=40 BENCH_METRICS=0 BENCH_H2H=0 BENCH_TAG=g1 BENCH_OUT=bench/g1.json \
  BENCH_OPPONENTS=random,station,tight npx vitest run src/ai/bench.test.ts --reporter=verbose &
BENCH_GAMES=40 BENCH_METRICS=0 BENCH_H2H=0 BENCH_TAG=g2 BENCH_OUT=bench/g2.json \
  BENCH_OPPONENTS=oldBot,checkPunisher,tellReader npx vitest run src/ai/bench.test.ts --reporter=verbose &
# …
wait
jq -s '[.[].opponents[]] | sort_by(-.rate) | .[] | [.id, .wins, .losses, .rate, .lo] | @tsv' bench/g*.json -r
```

（分片跑的时候把失败线关掉 `BENCH_MIN_RATE=0 BENCH_MIN_LOWER=0`，先拿数字，再决定门槛。）

## 扫参：`src/ai/zz_sweep.test.ts`

扫 `PARAMS.solveEdge` × `SOLVER_PARAMS.iters` 的模板。**这个文件不提交**（`zz_` 前缀 =
临时试验文件），要用的时候把下面这段贴回 `src/ai/zz_sweep.test.ts`：

```ts
/**
 * 扫参模板（**不提交**，内容同时抄在 `bench/README.md` 里方便重建）。
 *
 * 用法：`SWEEP_EDGE=0.7 SWEEP_ITERS=400 BENCH_OPPONENTS=tight,tellReader,onlineReader \
 *        SWEEP_GAMES=40 SWEEP_OUT=bench/sweep-0.7-400.json npx vitest run src/ai/zz_sweep.test.ts`
 *
 * 多进程并行扫 solveEdge ∈ {0.6,0.7,0.8,0.9} × iters ∈ {200,400}：8 个进程各跑一格，
 * 每格写一个 JSON，最后 `jq -s` 合起来看。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PARAMS, SOLVER_PARAMS } from "./bot.js";
import { BENCH_STRATEGIES, type Strategy, simulate, strategyByName, strategyId } from "./sim.js";
import { wilson } from "./metrics.js";

interface NodeProcess {
  env: Record<string, string | undefined>;
}
const proc = (globalThis as { process?: NodeProcess }).process;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeRequire = (m: string): Promise<any> => import(/* @vite-ignore */ m);
const env = (k: string, d: string) => proc?.env[k]?.trim() || d;

const EDGE = Number(env("SWEEP_EDGE", String(PARAMS.solveEdge)));
const ITERS = Math.round(Number(env("SWEEP_ITERS", String(SOLVER_PARAMS.iters))));
const GAMES = Math.round(Number(env("SWEEP_GAMES", env("BENCH_GAMES", "40"))));
const SEEDS = env("BENCH_SEEDS", "11").split(",").map(Number).filter(Number.isFinite);
const LIVES = Math.round(Number(env("BENCH_LIVES", "12")));
const OUT = env("SWEEP_OUT", `bench/sweep-${EDGE}-${ITERS}.json`);
const LIST: Strategy[] = env("BENCH_OPPONENTS", "")
  ? env("BENCH_OPPONENTS", "").split(",").map((n) => {
      const s = strategyByName(n);
      if (!s) throw new Error(`未知对手：${n}`);
      return s;
    })
  : BENCH_STRATEGIES;

const rows: Record<string, unknown>[] = [];

describe(`sweep solveEdge=${EDGE} iters=${ITERS}`, () => {
  beforeAll(() => {
    PARAMS.solveEdge = EDGE;
    SOLVER_PARAMS.iters = ITERS;
  });

  for (const s of LIST) {
    it(`${s.name}（${GAMES} 局 × ${SEEDS.length} seed）`, () => {
      const t0 = performance.now();
      let wins = 0;
      let losses = 0;
      let rounds = 0;
      let betMedian = 0;
      for (const seed of SEEDS) {
        const r = simulate(s, GAMES, seed, LIVES);
        wins += r.wins;
        losses += r.losses;
        rounds += r.rounds;
        betMedian = Math.max(betMedian, r.bet.median);
      }
      const w = wilson(wins, wins + losses);
      rows.push({
        id: strategyId(s),
        name: s.name,
        wins,
        losses,
        rate: w.p,
        lo: w.lo,
        hi: w.hi,
        avgRounds: rounds / (wins + losses),
        betMedian,
        seconds: (performance.now() - t0) / 1000
      });
      expect(wins + losses).toBe(GAMES * SEEDS.length);
    }, 3600000);
  }
});

afterAll(async () => {
  const fs = await nodeRequire("node:fs");
  const path = await nodeRequire("node:path");
  const wins = rows.reduce((a, r) => a + (r.wins as number), 0);
  const n = rows.reduce((a, r) => a + (r.wins as number) + (r.losses as number), 0);
  const overall = wilson(wins, n);
  const payload = { ts: new Date().toISOString(), solveEdge: EDGE, iters: ITERS, games: GAMES, seeds: SEEDS, lives: LIVES, overall, rows };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `\nsolveEdge=${EDGE} iters=${ITERS}：总胜率 ${(overall.p * 100).toFixed(1)}% ` +
    `[${(overall.lo * 100).toFixed(1)}%, ${(overall.hi * 100).toFixed(1)}%]（${wins}/${n}）→ ${OUT}\n`
  );
});
```

8 格并行（`solveEdge ∈ {0.6,0.7,0.8,0.9} × iters ∈ {200,400}`）：

```sh
for e in 0.6 0.7 0.8 0.9; do for i in 200 400; do
  SWEEP_EDGE=$e SWEEP_ITERS=$i SWEEP_GAMES=40 \
  BENCH_OPPONENTS=tight,tellReader,onlineReader,minRaiseLadder,trapper \
  SWEEP_OUT=bench/sweep-$e-$i.json \
  npx vitest run src/ai/zz_sweep.test.ts --reporter=verbose > bench/sweep-$e-$i.log 2>&1 &
done; done; wait
jq -r '[.solveEdge, .iters, .overall.p, .overall.lo] | @tsv' bench/sweep-*.json | sort -k3 -nr
```

`beforeAll` 里改的是模块级可变对象（`PARAMS` / `SOLVER_PARAMS` 都是 `const` 绑定的普通对象），
所以每个进程只能扫一格 —— 别想在一个进程里循环改参数跑多格，`analyze()` 里有跨局缓存。

## `npm test` 与 bench

`npm test`（= `vitest run`）会连 `bench.test.ts` 一起跑，默认 40 场 × 15 个对手，很慢。
只想跑单元测试就 `npx vitest run --exclude 'src/ai/bench.test.ts'`，
或者 `BENCH_GAMES=4 BENCH_METRICS=0 BENCH_H2H=0 npm test` 让 bench 走个过场。
