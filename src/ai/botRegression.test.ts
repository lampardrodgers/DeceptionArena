import { describe, expect, it, vi } from "vitest";
import { createDeck, seededRng, type Card } from "../game/cards.js";
import { act, newGame, selectCard, startRound, type RoundRecord, type Side } from "../game/engine.js";
import { analyze, catOfRank, ctxOf, publicView, RANKS, uWithEdge, zeros, type BotView, type Ctx } from "./analysis.js";
import { botBet, botSelect, pairKey, pairsOf, policyOf, selectionPolicy } from "./bot.js";
import { aggressionProb, chooseProb, foldProb, learnOpponent, rate } from "./opponentModel.js";
import { solve, type SolveInput, type Solved } from "./solver.js";
import { buildFvTable } from "./futureValue.js";
import * as opponentModel from "./opponentModel.js";
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
        for (const r of [3, 4, 5, 6, 7]) {
          expect(probability(sol, n, r, "raise")).toBe(0);
          expect(probability(sol, n, r, "call")).toBe(0);
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
      // All integer amounts, independent of mySizes and SOLVER_PARAMS. Also measure the uncapped gap.
      const best = (paid: number, remaining: number): number => {
        if (remaining === 0 || paid === M) return paid;
        let value = paid;
        for (let to = paid + 1; to <= M; to++) {
          const f = foldProb(model, 0.5, to, paid, M, M);
          value = Math.max(value, f * paid + (1 - f) * best(to, remaining - 1));
        }
        return value;
      };
      const myPrior = zeros(); myPrior[13] = 1;
      const oppPrior = zeros(); oppPrior[5] = 1;
      const q = new Array<number>(15).fill(0.5);
      const sol = solve({ myPrior, oppPrior, q, model, p: 1, M, LOpp: M,
        meFirst: true, val: (_r, d) => d, actions: [] });
      const oracle = best(1, 3);
      const full = best(1, M - 1);
      const shove = 1 + (1 - foldProb(model, 0.5, M, 1, M, M)) * (M - 1);
      // The model's 1e-6 probability floor allows negligible reraises, hence a small numerical tolerance.
      expect(sol.rootValue(13)).toBeCloseTo(oracle, 2);
      expect(sol.rootValue(13)).toBeGreaterThanOrEqual(shove - 0.01);
      if (sensitive) {
        expect(oracle).toBeCloseTo(7.0415, 4);
        expect(full).toBeCloseTo(9.6433, 4);
        expect(oracle).toBeGreaterThan(shove + 1);
        const small = sol.actionsOf(sol.root).reduce((p, a, i) => p +
          (a.type === "raise" && a.raiseTo! <= 4 ? sol.strategyAt(sol.root, 13)[i] : 0), 0);
        expect(small).toBeGreaterThan(0.95);
      } else expect(sol.rootValue(13)).toBeGreaterThan(11.99);
      console.log(`value extraction (${sensitive ? "size-sensitive" : "calls all sizes"}): solver=${sol.rootValue(13).toFixed(4)}, oracle(3 raises)=${oracle.toFixed(4)}, uncapped=${full.toFixed(4)}, direct all-in=${shove.toFixed(4)}`);
    }
  });
});


describe("v0.1.14 review regressions", () => {
  it("never selects A over a match-winning J at one life, including tail RNG and multiple iteration budgets", () => {
    for (const first of ["ai", "player"] as Side[]) {
      const state = setup([11, 14], [2, 5], first, 1);
      const view = publicView(state), analysis = analyze(view), fv = buildFvTable(view, analysis);
      for (const rounds of [1, 2, 6, 12]) {
        const pol = selectionPolicy(view, analysis, fv, rounds);
        expect(pol.sigma.get(pairKey(11, 14))).toBe(1);
        const aggregate = zeros();
        for (const pair of pol.pairs) {
          const p = pol.sigma.get(pairKey(pair.a, pair.b))!;
          aggregate[pair.a] += pair.w * p;
          aggregate[pair.b] += pair.w * (1 - p);
        }
        for (const r of RANKS) expect(aggregate[r]).toBeCloseTo(pol.myPrior[r], 12);
      }
      for (const r of [0, 0.994, 0.9999, 1 - Number.EPSILON]) {
        expect(botSelect(view, () => r).cardId).toBe(state.players.ai.hand[0].id);
      }
    }
    const view = publicView(setup([11, 11], [2, 5], "ai", 1));
    expect(policyOf(view, analyze(view)).sigma.get(pairKey(11, 11))).toBe(0.5);
  });

  it("uses node evidence for 2 once, retaining conservative opening play and the 3–7 hard boundary", () => {
    const view = publicView(setup([2, 5], [11, 14], "player"));
    const inp = input(view);
    inp.p = 1;
    inp.myPrior = zeros(); inp.myPrior[2] = 1;
    inp.oppPrior = zeros(); inp.oppPrior[8] = 0.98; inp.oppPrior[14] = 0.02;
    inp.q[8] = 0.1; inp.q[14] = 0.9;
    inp.model.agg.openFirst.vweak = { a: 0.001, b: 0.999 };
    inp.model.agg.openFirst.vstrong = { a: 0.999, b: 0.001 };
    inp.actions = [{ side: "player", type: "raise", raiseTo: 3, stakeAfter: 3 }];
    inp.allowAction = bettingConstraint("DOWN2", "UP2", inp.oppPrior, d => uWithEdge(d, 12, 24));
    expect(inp.allowAction(2, { type: "call", key: "call" }, 1, 3)).toBe(false);
    const sol = solve(inp);
    const expected = 0.02 * aggressionProb(inp.model, "openFirst", 0.9) /
      (0.02 * aggressionProb(inp.model, "openFirst", 0.9) + 0.98 * aggressionProb(inp.model, "openFirst", 0.1));
    expect(sol.opponentRangeAt(sol.cur)[14]).toBeCloseTo(expected, 12);
    expect(probability(sol, sol.cur, 2, "fold")).toBeLessThan(0.01);
    expect(probability(sol, sol.cur, 5, "call")).toBe(0);
    expect(probability(sol, sol.cur, 5, "raise")).toBe(0);
    const opening = solve({ ...inp, meFirst: true, actions: [] });
    expect(probability(opening, opening.root, 2, "raise")).toBe(0);
  });

  it("reports actual conditional model/free fold probabilities, including reweighted copy membership", () => {
    for (const p of [0, 0.35, 1]) {
      const inp = input(publicView(setup([13, 11], [5, 3], "player")));
      inp.allowAction = undefined;
      inp.p = p;
      inp.myPrior = zeros(); inp.myPrior[13] = 1;
      inp.oppPrior = zeros(); inp.oppPrior[5] = 1;
      inp.q[5] = 0.5;
      inp.actions = [{ side: "player", type: "check", stakeAfter: 1 }];
      const sol = solve(inp);
      const raise = sol.actionsOf(sol.cur).findIndex(a => a.raiseTo === 2);
      const afterRaise = sol.childOf(sol.cur, raise);
      const rootCheck = sol.actionsOf(sol.root).findIndex(a => a.type === "check");
      const fold = sol.actionsOf(afterRaise).findIndex(a => a.type === "fold");
      const modelReach = p * (1 - aggressionProb(inp.model, "openFirst", 0.5));
      const freeReach = (1 - p) * sol.strategyAt(sol.root, 5)[rootCheck];
      const modelFold = foldProb(inp.model, 0.5, 2, 1, 12, 12);
      const freeFold = sol.strategyAt(afterRaise, 5)[fold];
      const expected = (modelReach * modelFold + freeReach * freeFold) / (modelReach + freeReach);
      expect(sol.opponentActionProb(afterRaise, "fold")).toBeCloseTo(expected, 12);
      if (p === 0.35) expect(Math.abs(expected - (p * modelFold + (1 - p) * freeFold))).toBeGreaterThan(0.01);
      expect(["check", "call", "fold", "raise"].reduce((sum, type) => sum + sol.opponentActionProb(afterRaise, type as "fold")!, 0)).toBeCloseTo(1, 12);
      sol.evaluate((_r, d) => d * 2);
      expect(sol.opponentActionProb(afterRaise, "fold")).toBeCloseTo(expected, 12);
    }
  });
});


it("executes a profitable complete value-betting route via botBet/act with production risk utility and RNR", () => {
  const state = setup([13, 11], [5, 5]);
  // Publicly depleted DOWN range: only 5 remains. Neither the decision nor the oracle reads hidden cards.
  state.discard = createDeck(3).filter(c => c.rank < 8 && c.rank !== 5);
  const discarded = new Set(state.discard.map(c => c.id));
  state.deck = state.deck.filter(c => !discarded.has(c.id));
  selectCard(state, "ai", state.players.ai.hand[0].id);
  selectCard(state, "player", state.players.player.hand[0].id);
  const initial = publicView(state);
  const model = learnOpponent(initial);
  for (const bin of ["vweak", "weak", "mid", "strong", "vstrong"] as const) {
    for (const bucket of [0, 1, 2] as const) {
      const f = [0.01, 0.65, 0.95][bucket];
      model.foldBySize[bin][bucket] = { a: f, b: 1 - f };
      model.reraiseBySize[bin][bucket] = { a: 0, b: 1 };
    }
    for (const ctx of ["openFirst", "stabAfterBotCheck", "barrel"] as const) model.agg[ctx][bin] = { a: 0, b: 1 };
  }
  // Inject only the controlled opponent's measured habits. Preserve production p, utility, held valuation and solver.
  const spy = vi.spyOn(opponentModel, "learnOpponent").mockReturnValue(model);
  try {
    const A = analyze(initial), M = initial.maxStake;
    const policy = policyOf(initial, A);
    const value = (stake: number) => uWithEdge(stake, 12, 24) + policy.fv.fv(11, 12 + stake, true);
    const fold = (from: number, to: number) => foldProb(model, A.q[5], to, from, 12, M);
    const optimum = (valueOf: (paid: number) => number) => {
      const dp = new Array<number>(M + 1).fill(0);
      for (let paid = M; paid >= 1; paid--) {
        dp[paid] = valueOf(paid);
        for (let to = paid + 1; to <= M; to++) {
          const f = fold(paid, to);
          dp[paid] = Math.max(dp[paid], f * valueOf(paid) + (1 - f) * dp[to]);
        }
      }
      return dp[1];
    };
    const startState = structuredClone(state);
    let reach = 1, earned = 0, utility = 0;
    const path: number[] = [];
    for (let step = 0; state.phase === "betting" && step < M; step++) {
      const before = state.players.player.stake;
      const decision = botBet(publicView(state), () => 0);
      const mixedWeight = Number(/权重 p=([0-9]+)%/.exec(decision.reasoning)![1]) / 100;
      expect(mixedWeight).toBeGreaterThanOrEqual(0.15);
      expect(mixedWeight).toBeLessThan(1);
      if (decision.bet!.type === "check") {
        act(state, "ai", decision.bet!);
        if (state.phase === "betting") act(state, "player", { type: "check" });
        break;
      }
      expect(decision.bet!.type).toBe("raise");
      const to = decision.bet!.raiseTo!;
      path.push(to);
      const f = fold(before, to);
      earned += reach * f * before;
      utility += reach * f * value(before);
      reach *= 1 - f;
      act(state, "ai", decision.bet!);
      act(state, "player", { type: "call" });
    }
    expect(state.phase).not.toBe("betting");
    earned += reach * state.lastResult!.livesMoved;
    utility += reach * value(state.lastResult!.livesMoved);
    const oracle = optimum(x => x), utilityOracle = optimum(value);
    console.log(`production value route ${path.join("→")}: expected lives=${earned.toFixed(4)} / full integer oracle=${oracle.toFixed(4)}, utility=${utility.toFixed(6)} / ${utilityOracle.toFixed(6)}`);
    expect(path.length).toBeGreaterThan(3);
    expect(earned).toBeGreaterThanOrEqual(oracle * 0.95);
    expect(utility).toBeGreaterThanOrEqual(utilityOracle - 0.002);

    // Sample the actual production action distribution (including pruning), not just its modal route.
    // Integrate the fold/call responder analytically at every step to reduce sampling variance.
    const rng = seededRng(20260905);
    const returns: number[] = [], utilities: number[] = [];
    const routes = new Set<string>();
    for (let sample = 0; sample < 128; sample++) {
      const s = structuredClone(startState);
      let live = 1, profit = 0, u = 0;
      const route: string[] = [];
      for (let step = 0; s.phase === "betting" && step < M; step++) {
        const paid = s.players.player.stake;
        const action = botBet(publicView(s), rng).bet!;
        route.push(action.type === "raise" ? String(action.raiseTo) : action.type);
        if (action.type === "raise") {
          const f = fold(paid, action.raiseTo!);
          profit += live * f * paid;
          u += live * f * value(paid);
          live *= 1 - f;
          act(s, "ai", action);
          act(s, "player", { type: "call" });
        } else {
          expect(action.type).toBe("check");
          act(s, "ai", action);
          if (s.phase === "betting") act(s, "player", { type: "check" });
        }
      }
      expect(s.phase).not.toBe("betting");
      profit += live * s.lastResult!.livesMoved;
      u += live * value(s.lastResult!.livesMoved);
      returns.push(profit); utilities.push(u); routes.add(route.join("→"));
    }
    const interval = (xs: number[]) => {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const se = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1) / xs.length);
      return { mean, lower: mean - 1.98 * se, upper: mean + 1.98 * se };
    };
    const livesCI = interval(returns), utilityCI = interval(utilities);
    console.log(`mixed execution (128 samples, ${routes.size} routes): lives ${JSON.stringify(livesCI)}, utility ${JSON.stringify(utilityCI)}`);
    expect(routes.size).toBeGreaterThan(1);
    expect(livesCI.lower).toBeGreaterThanOrEqual(oracle * 0.9);
    expect(utilityCI.lower).toBeGreaterThanOrEqual(utilityOracle - 0.003);

  } finally { spy.mockRestore(); }
}, 120000);
