import { describe, expect, it } from "vitest";
import { act, clearTable, legalBets, newGame, selectCard, startRound } from "../game/engine.js";
import { buildObservation, FULL_SYSTEM_PROMPT } from "./brain.js";

/** 用固定随机数把一局打到指定回合数：双方都打第一张牌，开司加注到 2，和也跟注，开司过牌开牌。 */
function playRounds(rounds: number) {
  let seed = 7;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const state = newGame({ playerLives: 60, aiLives: 60, firstMover: "player", rng });
  startRound(state, rng);
  for (let i = 0; i < rounds && state.phase !== "gameover"; i += 1) {
    selectCard(state, "player", state.players.player.hand[0].id);
    selectCard(state, "ai", state.players.ai.hand[0].id);
    while (state.phase === "betting") {
      const legal = { player: legalBets(state, "player"), ai: legalBets(state, "ai") };
      if (state.toAct === "player") {
        if (legal.player.canCall) act(state, "player", { type: "call" });
        else if (state.actions.length === 0) act(state, "player", { type: "raise", raiseTo: 2 });
        else act(state, "player", { type: "check" }); // 和也跟注后，开司过牌开牌
      } else {
        act(state, "ai", legal.ai.canCall ? { type: "call" } : { type: "check" });
      }
    }
    if (state.phase === "showdown") {
      clearTable(state);
      startRound(state, rng);
    }
  }
  return state;
}

describe("prompt context", () => {
  it("keeps rules in the stable system prompt, not the per-turn user message", () => {
    expect(FULL_SYSTEM_PROMPT).toContain("2 击败 A");
  });

  it("sends every round's action record in full, without compaction", () => {
    const state = playRounds(15);
    expect(state.history.length).toBe(15);
    const obs = buildObservation(state, "select") as Record<string, any>;
    expect(obs.history).toHaveLength(15);
    expect(obs.history[0].round).toBe(1);
    expect(obs.history[0].bets).toEqual(["Kaiji:raise->2", "you:call", "Kaiji:check"]);
    expect(obs).not.toHaveProperty("historyOlderSummary");
  });
});
