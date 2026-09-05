import { describe, expect, it } from "vitest";
import { createDeck, seededRng, type Card } from "../game/cards.js";
import { act, newGame, selectCard, startRound, type RoundRecord, type Side } from "../game/engine.js";
import { analyze, catOfRank, ctxOf, publicView, RANKS, uWithEdge, zeros, type BotView, type Ctx } from "./analysis.js";
import { botBet, pairKey, pairsOf, policyOf } from "./bot.js";
import { chooseProb, foldProb, learnOpponent, rate } from "./opponentModel.js";
import { mySizes, SOLVER_PARAMS, solve, type SolveInput, type Solved } from "./solver.js";
import { bettingConstraint } from "./strategyConstraints.js";

function setup(ai = [5, 3], player = [11, 14], firstMover: Side = "ai", lives = 12) {
  const rng = seededRng(912);
  const s = newGame({ rng, firstMover, aiLives: lives, playerLives: lives, cutMax: 0 });
  startRound(s, rng);
  s.deck.push(...s.players.ai.hand, ...s.players.player.hand);
  const take = (rank: number) => s.deck.splice(s.deck.findIndex(c => c.rank === rank), 1)[0];
  s.players.ai.hand = ai.map(take);
  s.players.player.hand = player.map(take);
  return s;
}

function input(view: BotView): SolveInput {
  const A = analyze(view);
  const u = (d: number) => uWithEdge(d, view.lives.ai, view.lives.ai + view.lives.player);
  const my = zeros();
  for (const r of RANKS) if (catOfRank(r) === "DOWN") my[r] = 1 / 6;
  return {
    myPrior: my, oppPrior: A.played, q: A.q, model: A.model, p: 0.15,
    M: view.maxStake, LOpp: view.lives.player, meFirst: view.firstMover === "ai",
    val: (_r, d) => u(d), valOpp: d => d, actions: view.actions,
    allowAction: bettingConstraint(ctxOf(view.lights.ai), ctxOf(view.lights.player), A.played, u)
  };
}
function probability(sol: Solved, node: number, rank: number, type: string) {
  return sol.actionsOf(node).reduce((p, a, i) => p + (a.type === type ? sol.strategyAt(node, rank)[i] : 0), 0);
}

// 可公开复盘的历史片段；不向模型提供任何未翻开的留牌。
function record(round: number, rank: number, aiUp: number, playerUp: number, fold = false): RoundRecord {
  const card = (r: number): Card => ({ id: `r${round}-${r}`, rank: r, suit: "S" });
  return {
    round, firstMover: "ai", lights: { ai: { up: aiUp, down: 2 - aiUp }, player: { up: playerUp, down: 2 - playerUp } },
    cards: { ai: card(aiUp === 0 ? 4 : 13), player: card(rank) },
    actions: [{ side: "ai", type: "raise", raiseTo: 2, stakeAfter: 2 },
      { side: "player", type: fold ? "fold" : "call", stakeAfter: fold ? 1 : 2 }],
    result: "draw", reason: "showdown", livesMoved: 0, livesAfter: { ai: 12, player: 12 }
  };
}

describe("Bot strategy regressions (production defaults)", () => {
  it("rank-pair weights equal enumeration of physical unordered cards, including scarce ranks", () => {
    for (const ctx of ["UP2", "DOWN2", "MIX"] as Ctx[]) {
      const pool = zeros();
      for (const r of RANKS) pool[r] = r % 4;
      const cards = RANKS.flatMap(r => new Array<number>(pool[r]).fill(r));
      const counts = new Map<number, number>();
      let total = 0;
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
        let [a, b] = [cards[i], cards[j]];
        const up = Number(a >= 8) + Number(b >= 8);
        if (up !== (ctx === "UP2" ? 2 : ctx === "MIX" ? 1 : 0)) continue;
        if (ctx === "MIX" && a < 8) [a, b] = [b, a];
        counts.set(pairKey(a, b), (counts.get(pairKey(a, b)) ?? 0) + 1);
        total++;
      }
      const pairs = pairsOf(ctx, pool);
      expect(pairs).toHaveLength(counts.size);
      for (const p of pairs) expect(p.w).toBeCloseTo(counts.get(pairKey(p.a, p.b))! / total, 12);
    }
    const pool = new Array<number>(15).fill(12);
    const pairs = pairsOf("UP2", pool);
    expect(pairs.filter(p => p.a === p.b).reduce((s, p) => s + p.w, 0)).toBeCloseTo(11 / 83, 12);
  });

  it("A+J vs DOWN2 usually plays J, and cold-start A range uses AA without replacement", () => {
    const view = publicView(setup());
    const A = analyze(view);
    expect(chooseProb(A.model, 14, 11, "DOWN2")).toBeCloseTo(0.02);
    expect(chooseProb(A.model, 11, 14, "DOWN2")).toBeCloseTo(0.98);
    expect(chooseProb(A.model, 14, 11, "UP2")).toBeGreaterThan(0.5);
    // AA + A/non-A where the player ignores the sensible J-first preference.
    expect(A.played[14]).toBeCloseTo((12 * 11 + 2 * 12 * 72 * 0.02) / (84 * 83), 12);
    for (const x of RANKS) for (const k of RANKS) for (const ctx of ["UP2", "DOWN2", "MIX"] as Ctx[]) {
      expect(chooseProb(A.model, x, k, ctx) + chooseProb(A.model, k, x, ctx)).toBeCloseTo(1, 12);
    }
    // Only one unknown A and one J: AA must have zero weight.
    const deck = createDeck(3);
    const retain = new Set([deck.find(c => c.rank === 14)!.id, deck.find(c => c.rank === 11)!.id]);
    view.discard = deck.filter(c => c.rank >= 8 && !retain.has(c.id));
    expect(analyze(view).played[14]).toBeCloseTo(0.02, 12);
  });

  it("learns same-category choices in their original context when held identity is revealed later", () => {
    const view = publicView(setup());
    // First round plays A vs DOWN2, keeps an unknown UP; next MIX plays J, identifying that old UP as J.
    view.history = [record(1, 14, 0, 2), record(2, 11, 2, 1)];
    view.round = 3;
    const m = learnOpponent(view, 1);
    expect(chooseProb(m, 14, 11, "DOWN2")).toBeGreaterThan(0.2);
    expect(chooseProb(m, 14, 11, "UP2")).toBeCloseTo(0.7);
  });

  it("does not invent folds of certain winners under price pressure; learns observed mistakes separately", () => {
    const view = publicView(setup());
    const m = learnOpponent(view);
    expect(foldProb(m, 1, 2, 1, 12, 12)).toBe(0);
    expect(foldProb(m, 1, 12, 1, 12, 12)).toBe(0);
    expect(foldProb(m, 0.8, 12, 1, 12, 12)).toBeGreaterThan(0);
    // J against two DOWNs is guaranteed to win; an observed fold is a separate error sample.
    view.history = [record(1, 11, 0, 2, true)];
    view.round = 2;
    const learned = learnOpponent(view);
    expect(learned.foldCertainWin.n).toBe(1);
    expect(rate(learned.foldCertainWin)).toBeGreaterThan(0);
    expect(foldProb(learned, 1, 2, 1, 12, 12)).toBe(foldProb(learned, 1, 12, 1, 12, 12));
    // A against DOWN2 is not guaranteed: 2 still beats it.
    view.history = [record(1, 14, 0, 2, true)];
    expect(learnOpponent(view).foldCertainWin.n).toBe(0);
  });

  it("excludes ALL raises/calls with 3–7 vs UP2 at every node, at both positions and multiple stacks", () => {
    for (const lives of [2, 12, 30]) for (const firstMover of ["ai", "player"] as Side[]) {
      const view = publicView(setup([5, 3], [11, 14], firstMover, lives));
      const sol = solve(input(view));
      for (let n = 0; n < sol.nodeCount; n++) {
        if (sol.kindOf(n) !== 0) continue;
        for (const r of [2, 3, 4, 5, 6, 7]) {
          expect(probability(sol, n, r, "raise")).toBe(0);
          // 2 can only call at favourable pot odds, e.g. after already investing heavily.
          if (r !== 2) expect(probability(sol, n, r, "call")).toBe(0);
          expect(sol.strategyAt(n, r).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it("allows 2 value bets against publicly confirmed AA, while retaining the 3–7 boundary", () => {
    const view = publicView(setup([2, 5]));
    const inp = input(view);
    inp.oppPrior = zeros(); inp.oppPrior[14] = 1;
    inp.allowAction = bettingConstraint("DOWN2", "UP2", inp.oppPrior, d => d);
    const sol = solve(inp);
    expect(probability(sol, sol.root, 2, "raise")).toBeGreaterThan(0.5);
    expect(probability(sol, sol.root, 5, "raise")).toBe(0);
    expect(sol.exploitability().brMe).toBeGreaterThanOrEqual(sol.exploitability().valueMe - 1e-12);
  });

  it("does not constrain DOWN2 vs MIX", () => {
    const inp = input(publicView(setup([7, 3], [11, 4])));
    const unrestricted = solve({ ...inp, allowAction: undefined });
    const constrained = solve(inp);
    for (const r of RANKS) expect(constrained.strategyAt(constrained.root, r)).toEqual(unrestricted.strategyAt(unrestricted.root, r));
  });

  it("selection evaluation and actual execution use the same loss boundary, including the RNG tail", () => {
    const s = setup();
    const view = publicView(s);
    const policy = policyOf(view, analyze(view));
    expect(probability(policy.sol, policy.sol.root, 5, "raise")).toBe(0);
    selectCard(s, "ai", s.players.ai.hand[0].id);
    selectCard(s, "player", s.players.player.hand[0].id);
    for (const r of [0, 0.49, 0.99, 1 - Number.EPSILON]) expect(botBet(publicView(s), () => r).bet?.type).toBe("check");
    act(s, "ai", { type: "check" });
    act(s, "player", { type: "raise", raiseTo: 3 });
    for (const r of [0, 0.49, 0.99, 1 - Number.EPSILON]) expect(botBet(publicView(s), () => r).bet?.type).toBe("fold");
    act(s, "ai", { type: "fold" });
    expect(s.lastResult?.livesMoved).toBe(1);
  });

  it("our A+J selection preserves A against DOWN2 in the production utility model", () => {
    const view = publicView(setup([11, 14], [3, 5]));
    const policy = policyOf(view, analyze(view));
    expect(policy.sigma.get(pairKey(11, 14))).toBeGreaterThan(0.9);
  });

  it("does not reuse a cached policy across equal-length histories with different payment habits", () => {
    const view = publicView(setup([13, 11], [5, 3]));
    view.history = [record(1, 5, 1, 1)];
    view.round = 2;
    const calls = policyOf(view, analyze(view));
    view.history = [record(1, 5, 1, 1, true)];
    const folds = policyOf(view, analyze(view));
    expect(folds).not.toBe(calls);
    expect(policyOf(view, analyze(view))).toBe(folds);
  });
});


describe("strong-card value extraction", () => {
  it("matches an independent multi-step payment calculation instead of requiring a large first bet", () => {
    const view = publicView(setup([13, 11], [5, 3]));
    for (const sensitive of [true, false]) {
      const model = learnOpponent(view);
      // Controlled paying opponents: no voluntary raises, and a measured size-dependent fold curve.
      for (const bin of ["vweak", "weak", "mid", "strong", "vstrong"] as const) {
        model.reraise[bin] = { a: 0, b: 1 };
        for (const bucket of [0, 1, 2] as const) {
          const f = sensitive ? [0.01, 0.65, 0.95][bucket] : 0.000001;
          model.foldBySize[bin][bucket] = { a: f, b: 1 - f };
          model.reraiseBySize[bin][bucket] = { a: 0, b: 1 };
        }
        for (const ctx of ["openFirst", "stabAfterBotCheck", "barrel"] as const) model.agg[ctx][bin] = { a: 0, b: 1 };
      }
      const M = 12;
      // Independent recursion: fold forfeits the previous payment; a call below the cap permits another bet.
      const best = (paid: number, raises: number): number => {
        if (raises >= SOLVER_PARAMS.maxRaises || paid === M) return paid;
        return Math.max(paid, ...mySizes(paid, M, raises).map(to => {
          const f = foldProb(model, 0.5, to, paid, M, M);
          return f * paid + (1 - f) * best(to, raises + 1);
        }));
      };
      const myPrior = zeros(); myPrior[13] = 1;
      const oppPrior = zeros(); oppPrior[5] = 1;
      const q = new Array<number>(15).fill(0.5);
      const sol = solve({ myPrior, oppPrior, q, model, p: 1, M, LOpp: M,
        meFirst: true, val: (_r, d) => d, actions: [] });
      const oracle = best(1, 0);
      const shove = 1 + (1 - foldProb(model, 0.5, M, 1, M, M)) * (M - 1);
      // The model's 1e-6 probability floor allows negligible reraises, hence a small numerical tolerance.
      expect(sol.rootValue(13)).toBeCloseTo(oracle, 2);
      expect(sol.rootValue(13)).toBeGreaterThanOrEqual(shove - 0.01);
      if (sensitive) {
        expect(oracle).toBeGreaterThan(shove + 1);
        const small = sol.actionsOf(sol.root).reduce((p, a, i) => p +
          (a.type === "raise" && a.raiseTo! <= 4 ? sol.strategyAt(sol.root, 13)[i] : 0), 0);
        expect(small).toBeGreaterThan(0.95);
      } else expect(sol.rootValue(13)).toBeGreaterThan(11.99);
      console.log(`value extraction (${sensitive ? "size-sensitive" : "calls all sizes"}): solver=${sol.rootValue(13).toFixed(4)}, oracle=${oracle.toFixed(4)}, direct all-in=${shove.toFixed(4)}`);
    }
  });
});
