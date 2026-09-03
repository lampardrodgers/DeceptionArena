import {
  type Card,
  type Rng,
  cardLabel,
  compareCards,
  createDeck,
  isUp,
  shuffle
} from "./cards.js";

export type Side = "player" | "ai";
export const other = (side: Side): Side => (side === "player" ? "ai" : "player");

export type Phase = "select" | "betting" | "showdown" | "gameover";

export type BetActionType = "check" | "call" | "raise" | "fold";

export interface BetInput {
  type: BetActionType;
  /** For raise: the total stake to raise to (must exceed opponent's stake). */
  raiseTo?: number;
}

export interface BetAction extends BetInput {
  side: Side;
  stakeAfter: number;
}

export interface Lights {
  up: number;
  down: number;
}

export interface PlayerState {
  side: Side;
  name: string;
  lives: number;
  hand: Card[];
  chosen: Card | null;
  stake: number;
}

export type RoundResult = "player" | "ai" | "draw";

export interface RoundRecord {
  round: number;
  firstMover: Side;
  lights: Record<Side, Lights>;
  cards: Record<Side, Card | null>;
  actions: BetAction[];
  result: RoundResult;
  reason: "showdown" | "fold";
  /** Number of lives transferred from loser to winner (0 for a draw). */
  livesMoved: number;
  livesAfter: Record<Side, number>;
}

export interface LogEntry {
  round: number;
  text: string;
}

export interface GameState {
  deck: Card[];
  discard: Card[];
  /** Cards removed by the cutting card. Never enter play; nobody knows them. */
  cut: Card[];
  decks: number;
  players: Record<Side, PlayerState>;
  round: number;
  firstMover: Side;
  phase: Phase;
  toAct: Side | null;
  actions: BetAction[];
  maxStake: number;
  history: RoundRecord[];
  lastResult: RoundRecord | null;
  winner: Side | null;
  log: LogEntry[];
}

export interface GameOptions {
  playerLives?: number;
  aiLives?: number;
  playerName?: string;
  aiName?: string;
  /** Who bets first in round 1. Later rounds: the previous round's winner (a draw keeps the order). */
  firstMover?: Side | "random";
  /** Number of jokerless decks shuffled together (the manga uses 3). */
  decks?: number;
  /** The cutting card discards a random fraction of the pile in [0, cutMax]. */
  cutMax?: number;
  rng?: Rng;
}

export interface LegalBets {
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  canFold: boolean;
}

export const HAND_SIZE = 2;

export function newGame(options: GameOptions = {}): GameState {
  const rng = options.rng ?? Math.random;
  const decks = Math.max(1, Math.round(options.decks ?? 3));
  const pile = shuffle(createDeck(decks), rng);
  const cutMax = Math.max(0, Math.min(0.9, options.cutMax ?? 0.3));
  const cutCount = Math.floor(pile.length * rng() * cutMax);
  const cut = pile.splice(0, cutCount);
  const firstMover = options.firstMover === "random" || !options.firstMover
    ? (rng() < 0.5 ? "player" : "ai")
    : options.firstMover;
  const state: GameState = {
    deck: pile,
    discard: [],
    cut,
    decks,
    players: {
      player: {
        side: "player",
        name: options.playerName ?? "开司",
        lives: options.playerLives ?? 12,
        hand: [],
        chosen: null,
        stake: 0
      },
      ai: {
        side: "ai",
        name: options.aiName ?? "和也",
        lives: options.aiLives ?? 12,
        hand: [],
        chosen: null,
        stake: 0
      }
    },
    round: 0,
    firstMover,
    phase: "select",
    toAct: null,
    actions: [],
    maxStake: 0,
    history: [],
    lastResult: null,
    winner: null,
    log: []
  };
  log(
    state,
    `${decks} 副扑克（去鬼牌，共 ${decks * 52} 张）洗成一摞，切牌卡切掉了上方 ${cutCount} 张，剩余 ${pile.length} 张进入发牌机。`
  );
  return state;
}

function log(state: GameState, text: string): void {
  state.log.push({ round: state.round, text });
}

function drawCard(state: GameState, rng: Rng): Card {
  if (state.deck.length === 0) {
    if (state.discard.length === 0) {
      throw new Error("No cards left to draw.");
    }
    state.deck = shuffle(state.discard, rng);
    state.discard = [];
    log(state, "牌堆已用尽，弃牌堆重新洗牌后继续。");
  }
  return state.deck.pop()!;
}

export function lightsOf(player: PlayerState): Lights {
  let up = 0;
  let down = 0;
  for (const card of player.hand) {
    if (isUp(card)) up += 1;
    else down += 1;
  }
  return { up, down };
}

/** Deal up to HAND_SIZE cards to both players and open a new round. */
export function startRound(state: GameState, rng: Rng = Math.random): GameState {
  if (state.phase === "gameover") return state;
  if (state.round > 0 && state.phase !== "showdown") {
    throw new Error("Cannot start a round while one is in progress.");
  }
  state.round += 1;
  if (state.round > 1 && state.lastResult && state.lastResult.result !== "draw") {
    state.firstMover = state.lastResult.result; // previous winner bets first
  }
  for (const side of ["player", "ai"] as Side[]) {
    const p = state.players[side];
    p.chosen = null;
    while (p.hand.length < HAND_SIZE) {
      p.hand.push(drawCard(state, rng));
    }
    p.stake = 1; // mandatory minimum bet of one life every round
  }
  state.maxStake = Math.min(state.players.player.lives, state.players.ai.lives);
  state.actions = [];
  state.toAct = null;
  state.lastResult = null;
  state.phase = "select";
  const lp = lightsOf(state.players.player);
  const la = lightsOf(state.players.ai);
  log(
    state,
    `第 ${state.round} 回合，${state.players[state.firstMover].name} 先手。` +
      `指示灯 — ${state.players.player.name}：UP ${lp.up} / DOWN ${lp.down}，` +
      `${state.players.ai.name}：UP ${la.up} / DOWN ${la.down}。双方各押 1 命作为底注。`
  );
  return state;
}

export function selectCard(state: GameState, side: Side, cardId: string): GameState {
  if (state.phase !== "select") throw new Error("Not in card selection phase.");
  const p = state.players[side];
  if (p.chosen) throw new Error(`${p.name} already chose a card.`);
  const idx = p.hand.findIndex((c) => c.id === cardId);
  if (idx < 0) throw new Error(`${p.name} does not hold ${cardId}.`);
  p.chosen = p.hand.splice(idx, 1)[0];
  log(state, `${p.name} 盖出了一张牌。`);
  if (state.players.player.chosen && state.players.ai.chosen) {
    state.phase = "betting";
    state.toAct = state.firstMover;
    log(state, `双方出牌完毕，由 ${state.players[state.firstMover].name} 开始下注。`);
  }
  return state;
}

export function legalBets(state: GameState, side: Side): LegalBets {
  const me = state.players[side];
  const opp = state.players[other(side)];
  const inTurn = state.phase === "betting" && state.toAct === side;
  const facingRaise = opp.stake > me.stake;
  const canRaise = inTurn && opp.stake < state.maxStake;
  return {
    canCheck: inTurn && !facingRaise,
    canCall: inTurn && facingRaise,
    callAmount: facingRaise ? opp.stake - me.stake : 0,
    canRaise,
    minRaiseTo: canRaise ? opp.stake + 1 : 0,
    maxRaiseTo: canRaise ? state.maxStake : 0,
    canFold: inTurn && facingRaise
  };
}

export function act(state: GameState, side: Side, input: BetInput): GameState {
  if (state.phase !== "betting") throw new Error("Not in betting phase.");
  if (state.toAct !== side) throw new Error(`It is not ${state.players[side].name}'s turn.`);
  const legal = legalBets(state, side);
  const me = state.players[side];
  const opp = state.players[other(side)];

  switch (input.type) {
    case "check": {
      if (!legal.canCheck) throw new Error("Cannot check while facing a raise.");
      const closing = state.actions.length > 0; // 对方已经过牌或跟注，双方押注相同
      state.actions.push({ side, type: "check", stakeAfter: me.stake });
      log(state, closing ? `${me.name} 过牌，不再加注（押注 ${me.stake}）。` : `${me.name} 过牌（当前押注 ${me.stake}）。`);
      if (closing) {
        return finishBetting(state);
      }
      state.toAct = other(side);
      return state;
    }
    case "call": {
      if (!legal.canCall) throw new Error("Nothing to call.");
      me.stake = opp.stake;
      state.actions.push({ side, type: "call", stakeAfter: me.stake });
      if (me.stake >= state.maxStake) {
        log(state, `${me.name} 跟注至 ${me.stake}，已达上限。`);
        return finishBetting(state);
      }
      log(state, `${me.name} 跟注至 ${me.stake}。${opp.name} 可以过牌开牌或继续加注。`);
      state.toAct = other(side);
      return state;
    }
    case "raise": {
      if (!legal.canRaise) throw new Error("Cannot raise: stake is already at the maximum.");
      const raiseTo = Math.floor(input.raiseTo ?? 0);
      if (raiseTo < legal.minRaiseTo || raiseTo > legal.maxRaiseTo) {
        throw new Error(`Raise must be between ${legal.minRaiseTo} and ${legal.maxRaiseTo}.`);
      }
      me.stake = raiseTo;
      state.actions.push({ side, type: "raise", raiseTo, stakeAfter: raiseTo });
      const allIn = raiseTo === state.maxStake ? " ALL IN！" : "";
      log(state, `${me.name} 加注至 ${raiseTo}。${allIn}`);
      state.toAct = other(side);
      return state;
    }
    case "fold": {
      if (!legal.canFold) throw new Error("Cannot fold unless facing a raise.");
      state.actions.push({ side, type: "fold", stakeAfter: me.stake });
      log(state, `${me.name} 弃牌，输掉已押的 ${me.stake} 命。`);
      log(
        state,
        `翻牌：${state.players.player.name} ${cardLabel(state.players.player.chosen!)} 对 ${state.players.ai.name} ${cardLabel(state.players.ai.chosen!)}。`
      );
      return resolveRound(state, other(side), "fold", me.stake);
    }
    default:
      throw new Error("Unknown action.");
  }
}

function finishBetting(state: GameState): GameState {
  const pc = state.players.player.chosen!;
  const ac = state.players.ai.chosen!;
  const cmp = compareCards(pc, ac);
  const stake = state.players.player.stake; // equal on both sides here
  log(
    state,
    `开牌：${state.players.player.name} ${cardLabel(pc)} 对 ${state.players.ai.name} ${cardLabel(ac)}。`
  );
  if (cmp === 0) {
    log(state, "平局，赌注退回。");
    return resolveRound(state, null, "showdown", 0);
  }
  const winner: Side = cmp > 0 ? "player" : "ai";
  if ((pc.rank === 2 && ac.rank === 14) || (pc.rank === 14 && ac.rank === 2)) {
    log(state, "2 击败了 A！");
  }
  return resolveRound(state, winner, "showdown", stake);
}

function resolveRound(
  state: GameState,
  winner: Side | null,
  reason: "showdown" | "fold",
  livesMoved: number
): GameState {
  const P = state.players.player;
  const A = state.players.ai;
  if (winner) {
    const loser = other(winner);
    state.players[loser].lives -= livesMoved;
    state.players[winner].lives += livesMoved;
    log(
      state,
      `${state.players[winner].name} 赢得 ${livesMoved} 命。命数 — ${P.name}：${P.lives}，${A.name}：${A.lives}。`
    );
  }
  const record: RoundRecord = {
    round: state.round,
    firstMover: state.firstMover,
    lights: {
      // lights as the opponent saw them at the start of the round: chosen card + remaining hand
      player: lightsWithChosen(P),
      ai: lightsWithChosen(A)
    },
    // Both cards are turned over at the end of every round, including after a fold.
    cards: { player: P.chosen, ai: A.chosen },
    actions: state.actions.slice(),
    result: winner ?? "draw",
    reason,
    livesMoved,
    livesAfter: { player: P.lives, ai: A.lives }
  };
  state.history.push(record);
  state.lastResult = record;
  P.stake = 0;
  A.stake = 0;
  state.toAct = null;
  state.phase = "showdown";
  if (P.lives <= 0 || A.lives <= 0) {
    state.winner = P.lives <= 0 ? "ai" : "player";
    state.phase = "gameover";
    log(state, `对局结束，${state.players[state.winner].name} 获胜。`);
  }
  return state;
}

function lightsWithChosen(p: PlayerState): Lights {
  const cards = p.chosen ? [p.chosen, ...p.hand] : p.hand;
  let up = 0;
  let down = 0;
  for (const c of cards) (isUp(c) ? (up += 1) : (down += 1));
  return { up, down };
}

/** Discard the played cards after a showdown so the next round can be dealt. */
export function clearTable(state: GameState): GameState {
  for (const side of ["player", "ai"] as Side[]) {
    const p = state.players[side];
    if (p.chosen) {
      state.discard.push(p.chosen);
      p.chosen = null;
    }
  }
  return state;
}

/** Cards whose identity is publicly known (both played cards are shown at the end of every round). */
export function revealedCards(state: GameState): Card[] {
  const out: Card[] = [];
  for (const r of state.history) {
    if (r.cards.player) out.push(r.cards.player);
    if (r.cards.ai) out.push(r.cards.ai);
  }
  return out;
}
