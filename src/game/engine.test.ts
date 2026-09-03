import { describe, expect, it } from "vitest";
import { compareCards, createDeck, isUp, seededRng, type Card } from "./cards.js";
import { act, clearTable, legalBets, newGame, selectCard, startRound, type GameState } from "./engine.js";

const c = (id: string): Card => createDeck().find((x) => x.id === id)!;

describe("card rules", () => {
  it("classifies UP and DOWN", () => {
    expect(isUp(c("7S"))).toBe(false);
    expect(isUp(c("8S"))).toBe(true);
    expect(isUp(c("AS"))).toBe(true);
    expect(isUp(c("2S"))).toBe(false);
  });
  it("higher rank wins, A is highest, 2 beats A", () => {
    expect(compareCards(c("KS"), c("QH"))).toBe(1);
    expect(compareCards(c("AS"), c("KH"))).toBe(1);
    expect(compareCards(c("2S"), c("AH"))).toBe(1);
    expect(compareCards(c("AS"), c("2H"))).toBe(-1);
    expect(compareCards(c("2S"), c("3H"))).toBe(-1);
    expect(compareCards(c("9S"), c("9H"))).toBe(0);
  });
});

function rig(state: GameState, playerHand: string[], aiHand: string[]): void {
  state.players.player.hand = playerHand.map(c);
  state.players.ai.hand = aiHand.map(c);
}

function setup(playerHand: string[], aiHand: string[], opts = {}) {
  const state = newGame({ playerLives: 5, aiLives: 5, firstMover: "player", rng: seededRng(1), ...opts });
  startRound(state, seededRng(2));
  rig(state, playerHand, aiHand);
  return state;
}

describe("round flow", () => {
  it("shuffles three decks, cuts up to 30%, deals two cards each and antes one life", () => {
    const state = newGame({ rng: seededRng(7) });
    expect(state.deck.length + state.cut.length).toBe(156);
    expect(state.cut.length).toBeLessThanOrEqual(Math.floor(156 * 0.3));
    startRound(state, seededRng(8));
    expect(state.players.player.hand).toHaveLength(2);
    expect(state.players.ai.hand).toHaveLength(2);
    expect(state.players.player.stake).toBe(1);
    expect(state.maxStake).toBe(12);
    expect(new Set(createDeck(3).map((c) => c.id)).size).toBe(156);
  });

  it("runs check/check to a showdown and pays the stake", () => {
    const s = setup(["KS", "3H"], ["9D", "5C"]);
    selectCard(s, "player", "KS");
    expect(s.phase).toBe("select");
    selectCard(s, "ai", "9D");
    expect(s.phase).toBe("betting");
    expect(s.toAct).toBe("player");
    act(s, "player", { type: "check" });
    expect(s.toAct).toBe("ai");
    act(s, "ai", { type: "check" });
    expect(s.phase).toBe("showdown");
    expect(s.lastResult?.result).toBe("player");
    expect(s.players.player.lives).toBe(6);
    expect(s.players.ai.lives).toBe(4);
  });

  it("raise then call moves the raised amount", () => {
    const s = setup(["2S", "3H"], ["AD", "5C"]);
    selectCard(s, "player", "2S");
    selectCard(s, "ai", "AD");
    act(s, "player", { type: "raise", raiseTo: 3 });
    const legal = legalBets(s, "ai");
    expect(legal.canCall).toBe(true);
    expect(legal.callAmount).toBe(2);
    expect(legal.canFold).toBe(true);
    act(s, "ai", { type: "call" });
    expect(s.lastResult?.result).toBe("player"); // 2 beats A
    expect(s.lastResult?.livesMoved).toBe(3);
    expect(s.players.player.lives).toBe(8);
  });

  it("fold forfeits the folder's own stake only", () => {
    const s = setup(["4S", "3H"], ["AD", "5C"]);
    selectCard(s, "player", "4S");
    selectCard(s, "ai", "AD");
    act(s, "player", { type: "check" });
    act(s, "ai", { type: "raise", raiseTo: 4 });
    act(s, "player", { type: "fold" });
    expect(s.lastResult?.reason).toBe("fold");
    expect(s.lastResult?.livesMoved).toBe(1);
    expect(s.lastResult?.cards.ai).not.toBeNull(); // both cards are still shown after a fold
    expect(s.players.player.lives).toBe(4);
    expect(s.players.ai.lives).toBe(6);
  });

  it("draw returns stakes", () => {
    const s = setup(["9S", "3H"], ["9D", "5C"]);
    selectCard(s, "player", "9S");
    selectCard(s, "ai", "9D");
    act(s, "player", { type: "raise", raiseTo: 5 });
    act(s, "ai", { type: "call" });
    expect(s.lastResult?.result).toBe("draw");
    expect(s.players.player.lives).toBe(5);
    expect(s.players.ai.lives).toBe(5);
  });

  it("caps the stake at the smaller stack and forbids raising past it", () => {
    const s = newGame({ playerLives: 2, aiLives: 20, firstMover: "player", rng: seededRng(3) });
    startRound(s, seededRng(4));
    rig(s, ["KS", "3H"], ["9D", "5C"]);
    selectCard(s, "player", "KS");
    selectCard(s, "ai", "9D");
    expect(s.maxStake).toBe(2);
    expect(() => act(s, "player", { type: "raise", raiseTo: 3 })).toThrow();
    act(s, "player", { type: "raise", raiseTo: 2 });
    expect(legalBets(s, "ai").canRaise).toBe(false);
    act(s, "ai", { type: "call" });
    expect(s.players.player.lives).toBe(4);
  });

  it("ends the game when lives hit zero; previous winner bets first next round", () => {
    const s = newGame({ playerLives: 1, aiLives: 5, firstMover: "player", rng: seededRng(3) });
    startRound(s, seededRng(4));
    rig(s, ["3S", "4H"], ["9D", "5C"]);
    selectCard(s, "player", "3S");
    selectCard(s, "ai", "9D");
    act(s, "player", { type: "check" });
    act(s, "ai", { type: "check" });
    expect(s.phase).toBe("gameover");
    expect(s.winner).toBe("ai");

    const t = setup(["KS", "3H"], ["9D", "5C"]);
    selectCard(t, "player", "KS");
    selectCard(t, "ai", "9D");
    act(t, "player", { type: "check" });
    act(t, "ai", { type: "check" });
    clearTable(t);
    startRound(t, seededRng(9));
    expect(t.round).toBe(2);
    expect(t.firstMover).toBe("player");
    expect(t.discard).toHaveLength(2);
    expect(t.players.player.hand).toHaveLength(2);
  });

  it("reshuffles discards when the deck runs out", () => {
    const s = newGame({ playerLives: 200, aiLives: 200, decks: 1, cutMax: 0, rng: seededRng(11) });
    const rng = seededRng(12);
    for (let i = 0; i < 30; i += 1) {
      startRound(s, rng);
      selectCard(s, "player", s.players.player.hand[0].id);
      selectCard(s, "ai", s.players.ai.hand[0].id);
      act(s, s.firstMover, { type: "check" });
      act(s, s.firstMover === "player" ? "ai" : "player", { type: "check" });
      if (s.phase === "gameover") break;
      clearTable(s);
    }
    expect(s.round).toBeGreaterThan(24);
    expect(s.log.some((l) => l.text.includes("重新洗牌"))).toBe(true);
  });
});
