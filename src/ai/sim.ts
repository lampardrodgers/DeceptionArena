/**
 * 对局模拟工具：若干固定风格的开司策略，以及「让机器人坐到开司一侧」的镜像适配器。
 * 仅供测试与基准测评使用，应用代码不会引用。
 */
import { type Card, isUp, type Rng, seededRng } from "../game/cards.js";
import { type BetInput, type GameState, type RoundRecord, type Side, act, clearTable, legalBets, lightsOf, newGame, selectCard, startRound } from "../game/engine.js";
import { type BotDecision, type BotView, botBet, botSelect, cmpRank, perceivedWin, publicView } from "./bot.js";

export interface Strategy {
  name: string;
  select(s: GameState, rng: Rng): string;
  bet(s: GameState, rng: Rng): BetInput;
}

function aiLights(s: GameState) {
  const l = lightsOf(s.players.ai);
  const c = s.players.ai.chosen;
  if (c) (isUp(c) ? (l.up += 1) : (l.down += 1));
  return l;
}
const generic = new Array(15).fill(12);
const q = (s: GameState, c: Card) => perceivedWin(c.rank, aiLights(s), generic);
const stronger = (a: Card, b: Card) => (cmpRank(a.rank, b.rank) >= 0 ? a : b);
const weaker = (a: Card, b: Card) => (cmpRank(a.rank, b.rank) >= 0 ? b : a);

export const random: Strategy = {
  name: "随机",
  select: (s, rng) => s.players.player.hand[Math.floor(rng() * 2)].id,
  bet: (s, rng) => {
    const l = legalBets(s, "player");
    const x = rng();
    if (l.canCall) return x < 0.4 ? { type: "call" } : x < 0.8 ? { type: "fold" } : l.canRaise ? { type: "raise", raiseTo: l.minRaiseTo } : { type: "call" };
    if (l.canRaise && x < 0.3) return { type: "raise", raiseTo: l.minRaiseTo + Math.floor(rng() * (l.maxRaiseTo - l.minRaiseTo + 1)) };
    return { type: "check" };
  }
};

/** 跟注站：先打强牌，强牌就加注，从不弃牌。 */
export const station: Strategy = {
  name: "跟注站",
  select: (s) => stronger(s.players.player.hand[0], s.players.player.hand[1]).id,
  bet: (s) => {
    const l = legalBets(s, "player");
    const p = q(s, s.players.player.chosen!);
    if (l.canRaise && p > 0.6) return { type: "raise", raiseTo: Math.min(l.maxRaiseTo, l.minRaiseTo + Math.round((l.maxRaiseTo - l.minRaiseTo) * 0.5)) };
    if (l.canCall) return { type: "call" };
    return { type: "check" };
  }
};

/** 稳健型：够赢就出小的、留大的；按胜率下注，弱牌面对加注就弃。 */
export const tight: Strategy = {
  name: "稳健",
  select: (s) => {
    const [a, b] = s.players.player.hand;
    const qa = q(s, a);
    const qb = q(s, b);
    if (qa >= 0.9 && qb >= 0.9) return weaker(a, b).id;
    if (qa <= 0.1 && qb <= 0.1) return weaker(a, b).id;
    return qa >= qb ? a.id : b.id;
  },
  bet: (s, rng) => {
    const l = legalBets(s, "player");
    const p = q(s, s.players.player.chosen!);
    if (l.canCall) {
      if (p > 0.75 && l.canRaise) return { type: "raise", raiseTo: l.maxRaiseTo };
      if (p >= 0.4 || (l.callAmount <= 1 && p > 0.25)) return { type: "call" };
      return { type: "fold" };
    }
    if (l.canRaise && p > 0.7) {
      const span = l.maxRaiseTo - l.minRaiseTo;
      return { type: "raise", raiseTo: l.minRaiseTo + Math.round(span * (p - 0.7) / 0.3 * rng()) };
    }
    return { type: "check" };
  }
};

/** 旧版内置机器人（v0.1.7）的逻辑，搬到开司这一侧。 */
export const oldBot: Strategy = {
  name: "旧内置机器人",
  select: (s, rng) => {
    const scored = s.players.player.hand.map((c) => ({ c, p: q(s, c) }));
    scored.sort((a, b) => b.p - a.p || a.c.rank - b.c.rank);
    const pick = rng() < 0.15 && scored[1].p > 0.35 ? scored[1] : scored[0];
    return pick.c.id;
  },
  bet: (s, rng) => {
    const l = legalBets(s, "player");
    const me = s.players.player;
    const p = q(s, me.chosen!);
    const bluff = rng() < 0.12;
    if (l.canRaise && (p > 0.72 || (bluff && p > 0.3))) {
      const span = l.maxRaiseTo - l.minRaiseTo;
      const strength = Math.max(0, Math.min(1, (p - 0.6) / 0.4));
      return { type: "raise", raiseTo: p > 0.95 ? l.maxRaiseTo : l.minRaiseTo + Math.round(span * strength * rng()) };
    }
    if (l.canCall) {
      const pot = l.callAmount;
      const needed = pot / (pot + me.stake + s.players.ai.stake);
      return p >= needed + 0.05 || (p >= 0.4 && l.callAmount <= 1) ? { type: "call" } : { type: "fold" };
    }
    return { type: "check" };
  }
};

export function simulate(kaiji: Strategy, games: number, seed: number, lives = 12, bot: BotSide = { select: botSelect, bet: botBet, view: publicView }): { wins: number; losses: number; rounds: number } {
  let wins = 0;
  let losses = 0;
  let rounds = 0;
  for (let g = 0; g < games; g += 1) {
    const rng = seededRng(seed * 1000 + g);
    const s = newGame({ rng, firstMover: "random", playerLives: lives, aiLives: lives });
    startRound(s, rng);
    let guard = 0;
    while (s.phase !== "gameover" && guard < 600) {
      guard += 1;
      selectCard(s, "ai", bot.select(bot.view(s), rng).cardId!);
      selectCard(s, "player", kaiji.select(s, rng));
      while (s.phase === "betting") {
        if (s.toAct === "ai") act(s, "ai", bot.bet(bot.view(s), rng).bet!);
        else act(s, "player", kaiji.bet(s, rng));
      }
      rounds += 1;
      if (s.phase === "showdown") {
        clearTable(s);
        startRound(s, rng);
      }
    }
    const aiWon = s.winner ? s.winner === "ai" : s.players.ai.lives > s.players.player.lives;
    if (aiWon) wins += 1;
    else losses += 1;
  }
  return { wins, losses, rounds };
}


/** 机器人的三个入口，便于把不同版本的机器人塞进模拟。 */
export interface BotSide {
  select(view: BotView, rng: Rng): BotDecision;
  bet(view: BotView, rng: Rng): BotDecision;
  view(state: GameState): BotView;
}

const flip = (x: Side): Side => (x === "ai" ? "player" : "ai");
const flipRec = <T>(r: Record<Side, T>): Record<Side, T> => ({ player: r.ai, ai: r.player });

/** 把对局状态左右互换：让只会以「和也」身份思考的机器人去扮演开司。 */
export function mirror(s: GameState): GameState {
  const rec = (r: RoundRecord): RoundRecord => ({
    ...r,
    firstMover: flip(r.firstMover),
    lights: flipRec(r.lights),
    cards: flipRec(r.cards),
    actions: r.actions.map((a) => ({ ...a, side: flip(a.side) })),
    result: r.result === "draw" ? "draw" : flip(r.result),
    livesAfter: flipRec(r.livesAfter)
  });
  return {
    ...s,
    players: { player: { ...s.players.ai, side: "player" }, ai: { ...s.players.player, side: "ai" } },
    firstMover: flip(s.firstMover),
    toAct: s.toAct ? flip(s.toAct) : null,
    actions: s.actions.map((a) => ({ ...a, side: flip(a.side) })),
    history: s.history.map(rec),
    lastResult: s.lastResult ? rec(s.lastResult) : null,
    winner: s.winner ? flip(s.winner) : null
  };
}

/** 让某个版本的机器人以开司身份参赛。 */
export function botAsKaiji(name: string, bot: BotSide): Strategy {
  return {
    name,
    select: (s, rng) => bot.select(bot.view(mirror(s)), rng).cardId!,
    bet: (s, rng) => bot.bet(bot.view(mirror(s)), rng).bet!
  };
}
