/**
 * Optional paired release comparison. Export a baseline's src tree with git archive, then run:
 * PAIRED_BASELINE=/absolute/snapshot/src/ai/bot.ts PAIRED_REF=<commit> npx vitest run src/ai/pairedBench.test.ts
 * Identical deal seeds, separate action RNGs, both first movers and three stack configurations.
 * Small samples are diagnostic; no claim of improved win rate is enforced by this test.
 */
import { expect, it } from "vitest";
import { seededRng } from "../game/cards.js";
import { act, clearTable, newGame, selectCard, startRound, type Side } from "../game/engine.js";
import { botBet, botSelect, publicView } from "./bot.js";
import { station, tight, type BotSide, type Strategy } from "./sim.js";
import { wilson } from "./metrics.js";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const baseline = env.PAIRED_BASELINE;
const seeds = (env.PAIRED_SEEDS ?? "11,29").split(",").map(Number);

function match(bot: BotSide, opponent: Strategy, seed: number, firstMover: Side, aiLives: number, playerLives: number) {
  const deal = seededRng(seed), aiRng = seededRng(seed + 100000), playerRng = seededRng(seed + 200000);
  const s = newGame({ rng: deal, firstMover, aiLives, playerLives });
  startRound(s, deal);
  let rounds = 0, certainHands = 0, certainProfit = 0, unnecessaryPayments = 0;
  while (s.phase !== "gameover" && rounds < 600) {
    selectCard(s, "ai", bot.select(bot.view(s), aiRng).cardId!);
    selectCard(s, "player", opponent.select(s, playerRng));
    while (s.phase === "betting") {
      if (s.toAct === "ai") {
        const v = bot.view(s), action = bot.bet(v, aiRng).bet!;
        if (v.lights.ai.down === 2 && v.lights.player.up === 2 && v.chosen!.rank >= 3 && v.chosen!.rank <= 7
          && (action.type === "call" || action.type === "raise")) unnecessaryPayments++;
        act(s, "ai", action);
      } else act(s, "player", opponent.bet(s, playerRng));
    }
    const r = s.lastResult!;
    const rank = r.cards.ai!.rank;
    if (rank >= 8 && rank <= 13 && r.lights.player.down === 2) {
      certainHands++;
      certainProfit += r.result === "ai" ? r.livesMoved : r.result === "player" ? -r.livesMoved : 0;
    }
    rounds++;
    if (s.phase === "showdown") { clearTable(s); startRound(s, deal); }
  }
  expect(s.winner).not.toBeNull();
  expect(unnecessaryPayments).toBe(0);
  return { win: Number(s.winner === "ai"), rounds, certainHands, certainProfit, unnecessaryPayments };
}

it.skipIf(!baseline)("compares releases with paired deals, exchanged first movers and varied stacks", async () => {
  const old = await import(/* @vite-ignore */ baseline!);
  const bots: Record<string, BotSide> = {
    baseline: { select: old.botSelect, bet: old.botBet, view: old.publicView },
    current: { select: botSelect, bet: botBet, view: publicView }
  };
  const rows: { opponent: string; aiLives: number; playerLives: number; seed: number; firstMover: Side;
    baseline: ReturnType<typeof match>; current: ReturnType<typeof match> }[] = [];
  for (const opponent of [station, tight]) for (const [aiLives, playerLives] of [[2, 12], [12, 12], [30, 30]]) {
    for (const seed of seeds) for (const firstMover of ["ai", "player"] as const) {
      const before = match(bots.baseline, opponent, seed, firstMover, aiLives, playerLives);
      const after = match(bots.current, opponent, seed, firstMover, aiLives, playerLives);
      rows.push({ opponent: opponent.name, aiLives, playerLives, seed, firstMover, baseline: before, current: after });
    }
  }
  const summary = Object.fromEntries(Object.keys(bots).map(version => {
    const results = rows.map(r => version === "baseline" ? r.baseline : r.current);
    const wins = results.reduce((n, r) => n + r.win, 0);
    const certainHands = results.reduce((n, r) => n + r.certainHands, 0);
    return [version, { wins, games: rows.length, interval: wilson(wins, rows.length), certainHands,
      meanCertainProfit: results.reduce((n, r) => n + r.certainProfit, 0) / Math.max(1, certainHands) }];
  }));
  const gained = rows.filter(r => r.current.win > r.baseline.win).length;
  const lost = rows.filter(r => r.current.win < r.baseline.win).length;
  const report = { baselineRef: env.PAIRED_REF ?? "unspecified", seeds, summary, gained, lost, rows };
  const fsName = "node:fs/promises";
  const fs = await import(/* @vite-ignore */ fsName);
  await fs.mkdir("bench", { recursive: true });
  await fs.writeFile("bench/paired-latest.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ summary, gained, lost }, null, 2));
}, 600000);
