import { describe, expect, it } from "vitest";
import {
  createInitialMatch,
  getActiveRules,
  resolveRound
} from "./gameRules";
import type { RoundSubmission } from "./types";

function submit(values: Record<string, number>): RoundSubmission[] {
  return Object.entries(values).map(([seatId, number]) => ({
    seatId,
    number,
    rationale: `pick ${number}`
  }));
}

describe("K♦ Beauty Contest rule engine", () => {
  it("scores the base rule by target average times 0.8", () => {
    const match = createInitialMatch([
      "Arisu",
      "Kuzuryu",
      "Chishiya",
      "Mira",
      "Ann"
    ]);

    const next = resolveRound(match, submit({
      seat_1: 20,
      seat_2: 24,
      seat_3: 40,
      seat_4: 60,
      seat_5: 80
    }));

    expect(next.rounds[0].target).toBeCloseTo(35.84, 5);
    expect(next.rounds[0].winnerSeatIds).toEqual(["seat_3"]);
    expect(next.seats.map((seat) => seat.score)).toEqual([-1, -1, 0, -1, -1]);
  });

  it("invalidates duplicated numbers only after the first elimination", () => {
    const match = createInitialMatch(["A", "B", "C", "D", "E"]);
    match.seats[4].score = -10;
    match.seats[4].status = "eliminated";

    const next = resolveRound(match, submit({
      seat_1: 10,
      seat_2: 10,
      seat_3: 12,
      seat_4: 90
    }));

    expect(getActiveRules(next).duplicateInvalidation).toBe(true);
    expect(next.rounds[0].invalidSeatIds.sort()).toEqual(["seat_1", "seat_2"]);
    expect(next.rounds[0].winnerSeatIds).toEqual(["seat_3"]);
    expect(next.seats.slice(0, 4).map((seat) => seat.score)).toEqual([-1, -1, 0, -1]);
  });

  it("applies exact-target double penalty after the second elimination", () => {
    const match = createInitialMatch(["A", "B", "C", "D", "E"]);
    match.seats[3].score = -10;
    match.seats[3].status = "eliminated";
    match.seats[4].score = -10;
    match.seats[4].status = "eliminated";

    const next = resolveRound(match, submit({
      seat_1: 0,
      seat_2: 10,
      seat_3: 20
    }));

    expect(next.rounds[0].target).toBe(8);
    expect(next.rounds[0].winnerSeatIds).toEqual(["seat_2"]);
    expect(next.rounds[0].exactTarget).toBe(false);
    expect(next.seats.slice(0, 3).map((seat) => seat.score)).toEqual([-1, 0, -1]);

    const exact = resolveRound(match, submit({
      seat_1: 0,
      seat_2: 8,
      seat_3: 22
    }));

    expect(exact.rounds[0].target).toBe(8);
    expect(exact.rounds[0].exactTarget).toBe(true);
    expect(exact.seats.slice(0, 3).map((seat) => seat.score)).toEqual([-2, 0, -2]);
  });

  it("lets 100 beat 0 in the final two-player rule shift", () => {
    const match = createInitialMatch(["A", "B", "C", "D", "E"]);
    for (const seat of match.seats.slice(2)) {
      seat.score = -10;
      seat.status = "eliminated";
    }

    const next = resolveRound(match, submit({
      seat_1: 0,
      seat_2: 100
    }));

    expect(getActiveRules(next).zeroHundredException).toBe(true);
    expect(next.rounds[0].winnerSeatIds).toEqual(["seat_2"]);
    expect(next.seats.slice(0, 2).map((seat) => seat.score)).toEqual([-1, 0]);
  });

  it("declares the last surviving seat as winner after eliminations", () => {
    const match = createInitialMatch(["A", "B", "C", "D", "E"]);
    match.seats[0].score = -9;
    for (const seat of match.seats.slice(2)) {
      seat.score = -10;
      seat.status = "eliminated";
    }

    const next = resolveRound(match, submit({
      seat_1: 0,
      seat_2: 100
    }));

    expect(next.status).toBe("complete");
    expect(next.winnerSeatId).toBe("seat_2");
    expect(next.seats[0].status).toBe("eliminated");
  });
});
