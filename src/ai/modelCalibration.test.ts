import { describe, expect, it } from "vitest";
import { newGame, startRound, type RoundRecord } from "../game/engine.js";
import { seededRng } from "../game/cards.js";
import { publicView, zeros } from "./analysis.js";
import { bin5Of, foldProb, learnOpponent, raiseOptions, rate, sizeBucketOf, sizeProb } from "./opponentModel.js";
import { solve, type SolveInput } from "./solver.js";

function view() {
  const rng = seededRng(314);
  const state = newGame({ rng, firstMover: "player", aiLives: 12, playerLives: 12 });
  startRound(state, rng);
  return publicView(state);
}

// A very large shoe keeps the historical J-vs-UP2 strength at 0.5 while isolating calibration.
function observations(n: number, to: number, paid: number, mix: boolean) {
  const v = view();
  v.decks = 1000000;
  v.round = n + 1;
  v.history = Array.from({ length: n }, (_, i): RoundRecord => ({
    round: i + 1, firstMover: "ai",
    lights: { ai: { up: 2, down: 0 }, player: { up: mix ? 1 : 2, down: mix ? 1 : 0 } },
    cards: { ai: { rank: 11, suit: "H", id: `a${i}` }, player: { rank: 11, suit: "S", id: `p${i}` } },
    actions: [
      ...(paid > 1 ? [{ side: "ai" as const, type: "raise" as const, raiseTo: paid, stakeAfter: paid },
        { side: "player" as const, type: "call" as const, stakeAfter: paid }] : []),
      { side: "ai", type: "raise", raiseTo: to, stakeAfter: to },
      { side: "player", type: i % 2 ? "call" : "fold", stakeAfter: i % 2 ? to : paid }
    ], result: "draw", reason: "showdown", livesMoved: 0, livesAfter: { ai: 12, player: 12 }
  }));
  return v;
}

describe("opponent probability calibration", () => {
  it("converges to observed 50% folds at the same price, including sunk stakes and MIX", () => {
    for (const [to, paid] of [[2, 1], [12, 1], [12, 4]]) for (const mix of [false, true]) {
      const m = learnOpponent(observations(2000, to, paid, mix), 1);
      expect(foldProb(m, 0.5, to, paid, 12, 12, "UP", mix)).toBeCloseTo(0.5, 2);
      expect(rate(m.foldBySize.mid[sizeBucketOf(paid, to, 12)])).toBeCloseTo(0.5, 2);
    }
  });

  it("keeps cold-start pressure and calibrates both decayed memories without reapplying it", () => {
    const cold = learnOpponent(view());
    expect(foldProb(cold, 0.5, 12, 1, 12, 12)).toBeGreaterThan(foldProb(cold, 0.5, 2, 1, 12, 12));
    const m = learnOpponent(observations(160, 12, 1, true));
    for (const stats of [m, m.fast, m.slow]) {
      const prediction = foldProb(stats, 0.5, 12, 1, 12, 12, "UP", true);
      expect(prediction).toBeGreaterThan(0.4);
      expect(prediction).toBeLessThan(0.6);
      expect(foldProb(stats, 1, 12, 1, 12, 12)).toBe(0);
    }
  });

  it("labels every representative by the same integer bucket rule used by observations", () => {
    for (let M = 2; M <= 60; M++) for (let from = 1; from <= M; from++) {
      const options = raiseOptions(from, M);
      const legalBuckets = new Set(Array.from({ length: M - from }, (_, i) => sizeBucketOf(from, from + i + 1, M)));
      expect(new Set(options.map(o => o.bucket))).toEqual(legalBuckets);
      for (const o of options) {
        expect(o.bucket).toBe(sizeBucketOf(from, o.to, M));
        expect(o.to).toBeGreaterThan(from);
        expect(o.to).toBeLessThanOrEqual(M);
      }
    }
    expect(raiseOptions(8, 12)).toEqual([{ to: 9, bucket: 0 }, { to: 10, bucket: 1 }, { to: 12, bucket: 2 }]);
    expect(raiseOptions(11, 12)).toEqual([{ to: 12, bucket: 2 }]);
  });

  it("conserves bucket mass and same-bucket rank evidence when injecting actual amounts", () => {
    const m = learnOpponent(view());
    m.raiseSize.vweak = [8, 1, 1]; m.raiseSize.vstrong = [1, 1, 8];
    m.agg.openFirst.vweak = { a: 1, b: 1 }; m.agg.openFirst.vstrong = { a: 1, b: 1 };
    const myPrior = zeros(), oppPrior = zeros(), q = zeros();
    myPrior[2] = 1; oppPrior[8] = oppPrior[14] = 0.5; q[8] = 0.1; q[14] = 0.9;
    const inp: SolveInput = { myPrior, oppPrior, q, model: m, p: 1, M: 12, LOpp: 12,
      meFirst: false, val: (_r, d) => d, actions: [], iters: 20 };
    for (const amount of [2, 3, 4, 9, 12]) {
      const sol = solve({ ...inp, actions: [{ side: "player", type: "raise", raiseTo: amount, stakeAfter: amount }] });
      const observedBucket = sizeBucketOf(1, amount, 12);
      const a = sizeProb(m, q[14], observedBucket), other = sizeProb(m, q[8], observedBucket);
      expect(sol.opponentRangeAt(sol.cur)[14]).toBeCloseTo(a / (a + other), 12);
      for (const bucket of [0, 1, 2] as const) {
        let mass = 0;
        for (const a of sol.actionsOf(sol.root)) {
          if (a.type === "raise" && sizeBucketOf(1, a.raiseTo!, 12) === bucket) {
            mass += sol.opponentActionProb(sol.root, "raise", a.raiseTo)!;
          }
        }
        const expected = 0.5 * (sizeProb(m, q[8], bucket) + sizeProb(m, q[14], bucket)) / 2;
        expect(mass).toBeCloseTo(expected, 12);
      }
    }
    // When small/medium buckets are impossible, their mass must not survive in observed likelihoods.
    for (const r of [8, 14]) {
      expect(sizeProb(m, q[r], 2, 11, 12)).toBe(1);
      expect(sizeProb(m, q[r], 0, 11, 12)).toBe(0);
      expect(bin5Of(q[r])).toBe(r === 8 ? "vweak" : "vstrong");
    }
  });
});
