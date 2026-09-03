import { describe, expect, it } from "vitest";
import { seededRng, type Rng } from "../game/cards.js";
import { type BetInput, type GameState, type Side, act, clearTable, legalBets, newGame, selectCard, startRound } from "../game/engine.js";
import { PARAMS, RANKS, analyze, botBet, botSelect, cmpRank, learnOpponent, matchWinProb, perceivedWin, publicView, unknownPool } from "./bot.js";
import { type Strategy, oldBot, random, simulate, station, tight } from "./sim.js";

/** 固定局面：从牌堆里抽指定点数塞进双方手里。 */
function setup(opts: { ai: number[]; player: number[]; firstMover?: Side; lives?: number; seed?: number }): GameState {
  const rng = seededRng(opts.seed ?? 1);
  const s = newGame({ rng, firstMover: opts.firstMover ?? "player", playerLives: opts.lives ?? 12, aiLives: opts.lives ?? 12 });
  startRound(s, rng);
  const take = (r: number) => {
    const i = s.deck.findIndex((c) => c.rank === r);
    if (i < 0) throw new Error(`no rank ${r} left`);
    return s.deck.splice(i, 1)[0];
  };
  // 把原来发的牌还回牌堆，再按要求发。
  s.deck.push(...s.players.ai.hand, ...s.players.player.hand);
  s.players.ai.hand = opts.ai.map(take);
  s.players.player.hand = opts.player.map(take);
  return s;
}

const first: Rng = () => 0; // softmax 永远取最优

describe("card counting", () => {
  it("counts three decks minus own cards and the discard pile", () => {
    const s = setup({ ai: [13, 11], player: [5, 3] });
    const pool = unknownPool(publicView(s));
    expect(pool.reduce((a, b) => a + b, 0)).toBe(156 - 2);
    expect(pool[13]).toBe(11);
    expect(pool[11]).toBe(11);
    selectCard(s, "player", s.players.player.hand[0].id);
    selectCard(s, "ai", s.players.ai.hand[0].id);
    act(s, "player", { type: "check" });
    act(s, "ai", { type: "check" });
    clearTable(s);
    const after = unknownPool(publicView(s));
    expect(after.reduce((a, b) => a + b, 0)).toBe(156 - 1 - 2); // 手里 1 张 + 弃牌堆 2 张
    expect(after[5]).toBe(11);
  });

  it("2 beats A and nothing else", () => {
    expect(cmpRank(2, 14)).toBe(1);
    expect(cmpRank(14, 2)).toBe(-1);
    expect(cmpRank(2, 3)).toBe(-1);
    expect(cmpRank(14, 13)).toBe(1);
  });

  it("perceived win reflects the opponent's lights", () => {
    const pool = new Array(15).fill(12);
    expect(perceivedWin(13, { up: 0, down: 2 }, pool)).toBeCloseTo(1, 9); // K 对 DOWN2 必胜
    expect(perceivedWin(5, { up: 2, down: 0 }, pool)).toBeCloseTo(0, 9); // 5 对 UP2 必败
    expect(perceivedWin(2, { up: 2, down: 0 }, pool)).toBeCloseTo(1 / 7, 5); // 2 只赢 A
  });
});

describe("betting", () => {
  it("value-bets big with an unbeatable card instead of checking", () => {
    const s = setup({ ai: [13, 11], player: [5, 3], lives: 11 });
    selectCard(s, "player", s.players.player.hand[0].id);
    selectCard(s, "ai", s.players.ai.hand[0].id); // K
    act(s, "player", { type: "check" });
    const d = botBet(publicView(s), first);
    expect(d.bet!.type).toBe("raise");
    expect(d.bet!.raiseTo!).toBeGreaterThanOrEqual(4);
    expect(d.reasoning).toContain("胜 100%");
  });

  it("folds a hopeless card to a raise", () => {
    const s = setup({ ai: [3, 5], player: [13, 12], lives: 12 });
    selectCard(s, "player", s.players.player.hand[0].id);
    selectCard(s, "ai", s.players.ai.hand[0].id); // 3 对 UP2
    act(s, "player", { type: "raise", raiseTo: 5 });
    const d = botBet(publicView(s), first);
    expect(d.bet!.type).toBe("fold");
  });

  it("stays in against a small raise with a coin-flip", () => {
    // 开司灯 UP1+DOWN1：他出 DOWN 我的 J 必胜，出 UP 则要看点数；加注后仍约五五开，多押 1 命值得。
    const s = setup({ ai: [11, 4], player: [10, 3], lives: 12 });
    selectCard(s, "player", s.players.player.hand[1].id); // 3
    selectCard(s, "ai", s.players.ai.hand[0].id); // 9
    act(s, "player", { type: "raise", raiseTo: 2 });
    const d = botBet(publicView(s), first);
    expect(["call", "raise"]).toContain(d.bet!.type);
  });

  it("folds a marginal hand to an all-in when ahead, but takes it when short", () => {
    // 10 对 UP1+DOWN1：约六成胜率。领先时不为整场赌六四开，落后到只剩 3 命时就得搏。
    const ahead = setup({ ai: [10, 4], player: [12, 3], lives: 12 });
    selectCard(ahead, "player", ahead.players.player.hand[0].id);
    selectCard(ahead, "ai", ahead.players.ai.hand[0].id);
    act(ahead, "player", { type: "raise", raiseTo: 12 });
    expect(botBet(publicView(ahead), first).bet!.type).toBe("fold");

    const short = setup({ ai: [10, 4], player: [12, 3], lives: 12 });
    short.players.ai.lives = 3;
    short.players.player.lives = 21;
    short.maxStake = 3;
    selectCard(short, "player", short.players.player.hand[0].id);
    selectCard(short, "ai", short.players.ai.hand[0].id);
    act(short, "player", { type: "raise", raiseTo: 3 });
    expect(botBet(publicView(short), first).bet!.type).toBe("call");
  });

  it("only ever returns legal actions", () => {
    const s = setup({ ai: [14, 2], player: [7, 9], firstMover: "ai" });
    selectCard(s, "player", s.players.player.hand[0].id);
    selectCard(s, "ai", s.players.ai.hand[0].id);
    const d = botBet(publicView(s), first);
    const legal = legalBets(s, "ai");
    expect(legal.canCheck || legal.canRaise).toBe(true);
    expect(["check", "raise"]).toContain(d.bet!.type);
    act(s, "ai", d.bet!);
  });
});

describe("card selection", () => {
  it("plays the weaker of two winning cards and keeps the stronger", () => {
    const s = setup({ ai: [13, 11], player: [5, 3] });
    const d = botSelect(publicView(s), first);
    expect(d.cardId).toBe(s.players.ai.hand.find((c) => c.rank === 11)!.id);
    expect(d.reasoning).toContain("留 K");
  });

  it("plays the ace rather than sacrificing it against UP lights", () => {
    const s = setup({ ai: [14, 4], player: [12, 9] });
    const d = botSelect(publicView(s), first);
    expect(d.cardId).toBe(s.players.ai.hand.find((c) => c.rank === 14)!.id);
  });
});

/** 以固定的开司策略打若干局，供对手建模测试使用；和也一侧用简单脚本以免一局定胜负。 */
function playRounds(s: GameState, rng: Rng, rounds: number, kaiji: Strategy): void {
  const scripted = (): BetInput => {
    const l = legalBets(s, "ai");
    if (l.canCall) return l.callAmount <= 2 ? { type: "call" } : { type: "fold" };
    if (l.canRaise && s.players.ai.stake < 3) return { type: "raise", raiseTo: l.minRaiseTo };
    return { type: "check" };
  };
  for (let i = 0; i < rounds && s.phase !== "gameover"; i += 1) {
    selectCard(s, "ai", s.players.ai.hand[0].id);
    selectCard(s, "player", kaiji.select(s, rng));
    while (s.phase === "betting") {
      if (s.toAct === "ai") act(s, "ai", scripted());
      else act(s, "player", kaiji.bet(s, rng));
    }
    if (s.phase === "showdown") {
      clearTable(s);
      startRound(s, rng);
    }
  }
}

describe("opponent modelling", () => {
  it("learns that Kaiji plays the DOWN card from a mixed hand and never folds", () => {
    const rng = seededRng(3);
    const s = newGame({ rng, firstMover: "player", playerLives: 80, aiLives: 80 });
    startRound(s, rng);
    playRounds(s, rng, 60, station);
    const view = publicView(s);
    const m = learnOpponent(view);
    expect(m.rounds).toBe(60);
    // 跟注站从不弃牌：弃牌率应远低于先验 5/7
    const foldWeak = m.foldToRaise.weak.a / (m.foldToRaise.weak.a + m.foldToRaise.weak.b);
    expect(foldWeak).toBeLessThan(0.5);
    // 它总是先打强牌：同类先出强牌率应高于先验 0.5
    expect(m.pairSamples).toBeGreaterThan(0);
    expect(m.playStrongerSameCat.a / (m.playStrongerSameCat.a + m.playStrongerSameCat.b)).toBeGreaterThanOrEqual(0.6);
    const a = analyze(view);
    expect(Math.abs(a.played.reduce((x, y) => x + y, 0) - 1)).toBeLessThan(1e-9);
  });

  it("uses this round's raise as evidence of strength", () => {
    const s = setup({ ai: [10, 4], player: [14, 6], firstMover: "player" });
    selectCard(s, "player", s.players.player.hand[0].id);
    selectCard(s, "ai", s.players.ai.hand[0].id);
    const before = analyze(publicView(s));
    act(s, "player", { type: "raise", raiseTo: 6 });
    const after = analyze(publicView(s));
    const strong = (d: number[]) => RANKS.filter((r) => r >= 12).reduce((sum, r) => sum + d[r], 0);
    expect(strong(after.posterior)).toBeGreaterThan(strong(before.posterior));
  });
});

describe("endgame and counting details", () => {
  it("plays the 10 (not the 3) with one life left against UP2: a lost round ends the match", () => {
    const s = setup({ ai: [3, 10], player: [12, 9], lives: 12 });
    s.players.ai.lives = 1;
    s.players.player.lives = 23;
    s.maxStake = 1;
    const d = botSelect(publicView(s), first);
    expect(d.cardId).toBe(s.players.ai.hand.find((c) => c.rank === 10)!.id);
  });

  it("does not read a forced call at the stake cap as reluctance to re-raise", () => {
    // 上限 1 命：我先手无法加注，开司过牌 / 我过牌开牌；换成他跟注全下时不能加注，跟注不构成「不敢再加注」的证据。
    const s = setup({ ai: [10, 4], player: [14, 6], firstMover: "ai", lives: 12 });
    s.players.player.lives = 2;
    s.maxStake = 2;
    selectCard(s, "player", s.players.player.hand[0].id);
    selectCard(s, "ai", s.players.ai.hand[0].id);
    const before = analyze(publicView(s));
    act(s, "ai", { type: "raise", raiseTo: 2 });
    act(s, "player", { type: "call" });
    const after = analyze(publicView(s));
    const strong = (d: number[]) => RANKS.filter((r) => r >= 12).reduce((sum, r) => sum + d[r], 0);
    // 只剩「没弃牌」这一条证据，强牌比例应上升而非下降。
    expect(strong(after.posterior)).toBeGreaterThan(strong(before.posterior));
  });

  it("tracks the shoe after a reshuffle instead of the whole three decks", () => {
    const rng = seededRng(5);
    const s = newGame({ rng, firstMover: "player", playerLives: 12, aiLives: 12 });
    startRound(s, rng);
    playRounds(s, rng, 3, station);
    // 人为耗尽牌堆：下一次发牌时弃牌堆重洗成新牌靴。
    s.deck = [];
    selectCard(s, "ai", s.players.ai.hand[0].id);
    selectCard(s, "player", s.players.player.hand[0].id);
    while (s.phase === "betting") act(s, s.toAct!, { type: "check" });
    clearTable(s);
    const shoe = s.discard.length; // 重洗前弃牌堆里的全部牌 = 新牌靴
    startRound(s, rng);
    expect(s.reshuffles).toEqual([s.round]);
    const view = publicView(s);
    const pool = unknownPool(view);
    // 牌靴 = 重洗前的弃牌堆；减去刚发给我的一张。旧手牌不在牌靴里，不能再从牌堆里扣。
    expect(pool.reduce((a, b) => a + b, 0)).toBe(shoe - 1);
    expect(shoe).toBe(8);
  });

  it("match-win utility is anchored at the reference match and stays a proper probability", () => {
    expect(matchWinProb(12, 24)).toBeCloseTo(PARAMS.matchEdge, 9);
    expect(matchWinProb(0, 24)).toBe(0);
    expect(matchWinProb(24, 24)).toBe(1);
    for (const T of [4, 24, 120]) {
      let prev = 0;
      for (let L = 1; L <= T; L += 1) {
        const v = matchWinProb(L, T);
        expect(v).toBeGreaterThan(prev);
        prev = v;
      }
    }
    // 命数越多剩下的局数越多，越值得靠每局的小优势磨：大局更谨慎。
    expect(matchWinProb(60, 120)).toBeGreaterThan(PARAMS.matchEdge);
    expect(matchWinProb(2, 4)).toBeLessThan(PARAMS.matchEdge);
  });

  it("counts a draw as half a win in the opponent's perceived strength", () => {
    const pool = new Array(15).fill(12);
    // 10 对 UP2：赢 8/9（2/7），平 10（1/7 的一半）
    expect(perceivedWin(10, { up: 2, down: 0 }, pool)).toBeCloseTo(2 / 7 + 0.5 / 7, 9);
  });

  it("keeps betting for value after Kaiji calls a raise below the cap", () => {
    const s = setup({ ai: [13, 11], player: [5, 3], firstMover: "ai", lives: 12 });
    selectCard(s, "player", s.players.player.hand[0].id);
    selectCard(s, "ai", s.players.ai.hand[0].id); // K
    act(s, "ai", { type: "raise", raiseTo: 3 });
    act(s, "player", { type: "call" });
    const d = botBet(publicView(s), first);
    expect(d.bet!.type).toBe("raise");
  });
});

describe("simulation", () => {
  const GAMES = 60;
  for (const [strategy, minRate] of [
    [random, 0.8],
    [station, 0.75],
    [tight, 0.55],
    [oldBot, 0.55]
  ] as [Strategy, number][]) {
    it(`beats ${strategy.name} at least ${minRate * 100}% of the time`, () => {
      const r = simulate(strategy, GAMES, 7);
      const rate = r.wins / GAMES;
      // eslint-disable-next-line no-console
      console.log(`bot vs ${strategy.name}: ${r.wins}/${GAMES} (${Math.round(rate * 100)}%), avg ${Math.round(r.rounds / GAMES)} rounds/game`);
      expect(rate).toBeGreaterThanOrEqual(minRate);
    }, 120000);
  }
});
