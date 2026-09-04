/**
 * 机器人基准测评（阶段 S）：给「内置机器人 V2」立一条可对比的基线。
 *
 * 三块内容：
 *  1. 胜率表：对 random/station/tight/oldBot 以及一组专门剥削「可读性」的新策略各打 40 局。
 *  2. 头对头：先用 `mirror()` 让快照打自己（应接近 50%，验证镜像没翻错边），再拿当前机器人对快照量强弱差。
 *  3. 泄露度量：AUC（「是否加注」能多准地读出手牌强弱）、Spearman（加注额度 vs 强弱）与决策耗时。
 *
 * 这些数字只做记录与回归对比，阈值先放在 0.5，阶段 B 完成后再收紧。
 */
import { afterAll, describe, expect, it } from "vitest";
import { BENCH_STRATEGIES, type BotSide, type LatencyStats, botAsKaiji, measureTells, rocAuc, simulate } from "./sim.js";
import { prevBot } from "./prevBot.js";

const GAMES = 40;
const SEED = 11;
const LIVES = 12;
const MIN_RATE = 0.5;
const TIMEOUT = 300000;

/** 中日文字符按两格宽度对齐。 */
function pad(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += /[⺀-鿿＀-￯]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}
const pctText = (v: number) => `${(v * 100).toFixed(1)}%`;
const ms = (v: number) => `${v.toFixed(2)} ms`;
const latText = (l: LatencyStats) => `中位 ${ms(l.median)} / 均值 ${ms(l.mean)} / 最大 ${ms(l.max)}（${l.count} 次）`;

interface Row {
  name: string;
  wins: number;
  losses: number;
  rounds: number;
  seconds: number;
}
const rows = new Map<string, Row>();

function table(title: string, list: Row[]): string {
  const head = `${pad("策略", 16)}${pad("胜/负", 12)}${pad("胜率", 9)}${pad("平均局数", 12)}耗时`;
  const body = list.map((r) =>
    `${pad(r.name, 16)}${pad(`${r.wins}/${r.losses}`, 12)}${pad(pctText(r.wins / (r.wins + r.losses)), 9)}` +
    `${pad((r.rounds / (r.wins + r.losses)).toFixed(1), 12)}${r.seconds.toFixed(1)}s`
  );
  return [`\n=== ${title}（${GAMES} 局 / ${LIVES} 命 / seed ${SEED}）===`, head, ...body, ""].join("\n");
}

describe("bench: 对各基准对手的胜率", () => {
  for (const strategy of BENCH_STRATEGIES) {
    it(
      `机器人对「${strategy.name}」胜率不低于 ${MIN_RATE * 100}%`,
      () => {
        const t0 = performance.now();
        const r = simulate(strategy, GAMES, SEED, LIVES);
        rows.set(strategy.name, {
          name: strategy.name,
          wins: r.wins,
          losses: r.losses,
          rounds: r.rounds,
          seconds: (performance.now() - t0) / 1000
        });
        expect(r.wins / GAMES).toBeGreaterThanOrEqual(MIN_RATE);
      },
      TIMEOUT
    );
  }

  afterAll(() => {
    const list = BENCH_STRATEGIES.map((s) => rows.get(s.name)).filter((r): r is Row => !!r);
    if (list.length > 0) console.log(table("胜率表", list));
  });
});

/**
 * 头对头有两个用途，别混在一起看：
 *
 *  1. `快照 vs 快照`——用 `mirror()` 让同一份 v0.1.10 代码坐到开司一侧打自己。两边完全相同，
 *     胜率就该在 50% 附近；偏到 0% / 100% 说明 `mirror()` 翻错了边或者快照坏了。
 *     这一行两边都是冻结的，所以任何时候重跑都应该得到同样的数字。
 *  2. `当前 vs 快照`——衡量「现在的机器人比 v0.1.10 强多少」。这里不设胜率带宽：
 *     阶段 A/B 的目标就是把它推离 50%，设带宽等于给自己埋一颗定时炸弹。
 *
 * 30 命那组很贵：`botBet` 在 M=30 时要枚举 29 个加注额，一局镜像对局要一两分钟，
 * 40 局得一个多小时，所以只跑 6 局当健全性检查。阶段 B 把单次决策压到 30 ms 以内之后，
 * 可以考虑调回 40 局。
 */
const H2H: { label: string; lives: number; games: number; timeout: number; self: boolean }[] = [
  { label: "快照 vs 快照（镜像自对局）", lives: 12, games: GAMES, timeout: 900000, self: true },
  { label: "当前 vs 快照", lives: 12, games: GAMES, timeout: 900000, self: false },
  { label: "当前 vs 快照", lives: 30, games: 6, timeout: 900000, self: false }
];

describe("bench: 对 v0.1.10 快照头对头", () => {
  const mirrorRows: (Row & { games: number; label: string })[] = [];
  for (const { label, lives, games, timeout, self } of H2H) {
    it(
      `${label}（${lives} 命 / ${games} 局）`,
      () => {
        const t0 = performance.now();
        const kaiji = botAsKaiji("v0.1.10 快照", prevBot);
        const r = self
          ? simulate(kaiji, games, SEED, lives, prevBot)
          : simulate(kaiji, games, SEED, lives);
        mirrorRows.push({
          label,
          name: `${lives} 命`,
          games,
          wins: r.wins,
          losses: r.losses,
          rounds: r.rounds,
          seconds: (performance.now() - t0) / 1000
        });
        expect(r.wins + r.losses).toBe(games);
        expect(r.rounds).toBeGreaterThan(games);
        // 只有「两边同一份代码」的那一组才该落在 50% 附近。
        if (self) {
          expect(r.wins / games).toBeGreaterThan(0.25);
          expect(r.wins / games).toBeLessThan(0.75);
        }
      },
      timeout
    );
  }

  afterAll(() => {
    if (mirrorRows.length > 0) {
      console.log(
        [
          `\n=== 头对头（seed ${SEED}）===`,
          `${pad("对阵", 30)}${pad("命数", 10)}${pad("局数", 8)}${pad("胜/负", 12)}${pad("胜率", 9)}${pad("平均局数", 12)}耗时`,
          ...mirrorRows.map((r) =>
            `${pad(r.label, 30)}${pad(r.name, 10)}${pad(String(r.games), 8)}${pad(`${r.wins}/${r.losses}`, 12)}` +
            `${pad(pctText(r.wins / r.games), 9)}${pad((r.rounds / r.games).toFixed(1), 12)}${r.seconds.toFixed(1)}s`
          ),
          "注：「胜率」是 ai 一侧（当前机器人 / 自对局时是快照）的胜率。",
          ""
        ].join("\n")
      );
    }
  });
});

/**
 * 泄露度量对「当前机器人」和「v0.1.10 快照」各跑一遍。
 *
 * 跑快照是因为阶段 A/B 会不停改 bot.ts，「当前机器人」这一行随时会变；
 * 快照那一行是冻结的，改完之后仍然可以用同样的 seed 复现出同样的数字来对比。
 */
const TELL_GAMES = 20;
const TELL_SEED = 31;

describe("bench: 泄露度量与决策耗时", () => {
  const SUBJECTS: { label: string; bot: BotSide | undefined }[] = [
    { label: "当前机器人", bot: undefined },
    { label: "v0.1.10 快照", bot: prevBot }
  ];
  for (const { label, bot } of SUBJECTS) {
   it(
    `记录 tellAUC / Spearman / 单次决策耗时：${label}（对稳健型打 ${TELL_GAMES} 局）`,
    () => {
      const t = measureTells(bot, TELL_GAMES, TELL_SEED);
      const line = (label: string, rows: typeof t.raw) => {
        const raised = rows.filter((r) => r.raised);
        const avgF = raised.length > 0 ? raised.reduce((a, r) => a + (r.f ?? 0), 0) / raised.length : NaN;
        return `${pad(label, 18)}${pad(String(rows.length), 8)}${pad(
          rows.length ? pctText(raised.length / rows.length) : "—",
          10
        )}${Number.isNaN(avgF) ? "—" : avgF.toFixed(2)}`;
      };
      const bucketHead = `${pad("分组", 18)}${pad("样本", 8)}${pad("加注率", 10)}平均额度 f`;
      const buckets = [0, 0.25, 0.5, 0.75].map((lo, i, arr) => {
        const hi = i + 1 < arr.length ? arr[i + 1] : 1.0001;
        return line(
          `类内强度 ${lo.toFixed(2)}–${(hi > 1 ? 1 : hi).toFixed(2)}`,
          t.raw.filter((r) => r.strength >= lo && r.strength < hi)
        );
      });
      // 按点数与灯型再切一刀：类内 AUC 偏低时要能看出信号究竟藏在哪里。
      const byRank = [
        line("点数 2–4", t.raw.filter((r) => r.rank <= 4)),
        line("点数 5–7", t.raw.filter((r) => r.rank >= 5 && r.rank <= 7)),
        line("点数 8–10", t.raw.filter((r) => r.rank >= 8 && r.rank <= 10)),
        line("点数 J–A", t.raw.filter((r) => r.rank >= 11))
      ];
      const byCtx = (["UP2", "MIX", "DOWN2"] as const).map((c) =>
        line(`灯型 ${c}`, t.raw.filter((r) => r.ctx === c))
      );
      // 主指标把 UP 与 DOWN 的样本混在一起算，两边的信号方向相反会互相抵消
      // （DOWN 的 2 和 UP 的 8 都算「强度 0」，但机器人对它们的态度完全不同）。
      // 所以再分层各算一次，这才是「灯已经公开之后还剩多少可读性」。
      const stratified = ([["UP", 8], ["DOWN", 2]] as const).map(([tag, lo]) => {
        const rows = t.raw.filter((r) => (lo === 8 ? r.rank >= 8 : r.rank < 8));
        const a = rocAuc(rows.map((r) => (r.raised ? 1 : 0)), rows.map((r) => r.strength >= 0.5));
        return `${pad(`分层 AUC（${tag} 牌内）`, 22)}${pad(String(rows.length), 8)}${
          Number.isNaN(a) ? "—" : a.toFixed(4)
        }`;
      });
      console.log(
        [
          `\n=== 泄露度量：${label} vs 稳健型（${TELL_GAMES} 局 / 12 命 / seed ${TELL_SEED}）===`,
          `样本（双方押注相同时的首个动作）：${t.samples} 次，其中加注 ${t.raises} 次（${pctText(t.raiseRate)}）`,
          `tellAUC 主指标（「是否加注」预测「同灯类别内强度 ≥ 0.5」）：${t.auc.toFixed(4)}`,
          `  Spearman（加注额度 f vs 类内强度，${t.raw.filter((r) => r.f != null).length} 个加注样本）：${t.spearman.toFixed(4)}`,
          `tellAUC 副指标（「是否加注」预测「打出的是 UP 牌」）：${t.aucAbs.toFixed(4)}`,
          `  Spearman（加注额度 f vs 绝对点数）：${t.spearmanAbs.toFixed(4)}`,
          "  ← 0.5 = 读不出，1 = 加注即强牌；MIX 灯时类别本身是隐藏信息，所以副指标才是「整张牌多好读」的上界",
          "",
          bucketHead,
          ...buckets,
          ...byRank,
          ...byCtx,
          "",
          `${pad("分组", 22)}${pad("样本", 8)}AUC`,
          ...stratified,
          "",
          `对局结果：${t.wins}/${t.games} 胜，共 ${t.rounds} 局`,
          `botBet   耗时：${latText(t.bet)}`,
          `botSelect 耗时：${latText(t.select)}`,
          ""
        ].join("\n")
      );
      expect(t.samples).toBeGreaterThan(50);
      expect(t.auc).toBeGreaterThanOrEqual(0);
      expect(t.auc).toBeLessThanOrEqual(1);
      expect(t.aucAbs).toBeGreaterThanOrEqual(0);
      expect(t.aucAbs).toBeLessThanOrEqual(1);
      expect(t.bet.count).toBeGreaterThan(0);
      expect(t.select.count).toBeGreaterThan(0);
    },
    TIMEOUT
   );
  }
});
