/**
 * 对局模拟工具：若干固定风格的开司策略，以及「让机器人坐到开司一侧」的镜像适配器。
 * 仅供测试与基准测评使用，应用代码不会引用。
 */
import { type Card, isUp, type Rng, seededRng } from "../game/cards.js";
import { type BetInput, type GameState, type LegalBets, type RoundRecord, type Side, act, clearTable, legalBets, lightsOf, newGame, selectCard, startRound } from "../game/engine.js";
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

// ---------- 剥削型基准对手 ----------
//
// 下面这些策略专门针对「内置机器人容易被读」的地方：过牌 = 弱牌、加注幅度 = 牌力、
// 面对大码几乎必弃。它们全部只用公开信息：自己的手牌 / 打出的牌、双方指示灯（`aiLights`
// 只看机器人牌的 UP/DOWN 类别，不看点数）、本局动作 `s.actions`、历史记录 `s.history`、
// 命数与押注。绝不读 `s.players.ai.hand[i].rank`、`s.players.ai.chosen!.rank` 或 `s.deck`。

/** 本局机器人是否已经过牌（公开动作）。 */
const botChecked = (s: GameState) => s.actions.some((a) => a.side === "ai" && a.type === "check");
/** 加注到 to，自动夹进合法区间。 */
const rise = (l: LegalBets, to: number): BetInput => ({
  type: "raise",
  raiseTo: Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, Math.round(to)))
});

/** 惩罚过牌：机器人一过牌就最小加注偷池，其余按稳健型打。 */
export const checkPunisher: Strategy = {
  name: "惩罚过牌",
  select: tight.select,
  bet: (s, rng) => {
    const l = legalBets(s, "player");
    const p = q(s, s.players.player.chosen!);
    if (l.canRaise && botChecked(s) && p > 0.1) return rise(l, l.minRaiseTo);
    return tight.bet(s, rng);
  }
};

/**
 * 读动作：把「大码 = 强牌、过牌 = 弱牌」当成真话来打。
 * 机器人加注幅度（= 我要跟的额度）≥ max(2, 0.4·(M−1)) 且自己不是绝强牌就弃；
 * 机器人过牌就用 min+1 偷；其余按稳健型打。
 */
export const tellReader: Strategy = {
  name: "读动作",
  select: tight.select,
  bet: (s, rng) => {
    const l = legalBets(s, "player");
    const p = q(s, s.players.player.chosen!);
    const big = Math.max(2, 0.4 * (s.maxStake - 1));
    if (l.canCall && l.callAmount >= big && p <= 0.85) return { type: "fold" };
    if (l.canRaise && botChecked(s) && p > 0.15) return rise(l, l.minRaiseTo + 1);
    return tight.bet(s, rng);
  }
};

/** 极化：只有最强（>0.8，大码）和最弱（<0.2，中码诈唬）才加注，中间一律过牌 / 跟小注。 */
export const polarized: Strategy = {
  name: "极化",
  select: tight.select,
  bet: (s) => {
    const l = legalBets(s, "player");
    const p = q(s, s.players.player.chosen!);
    const span = l.maxRaiseTo - l.minRaiseTo;
    if (l.canCall) {
      if (p > 0.8) return l.canRaise ? rise(l, l.maxRaiseTo) : { type: "call" };
      return p >= 0.45 || (l.callAmount <= 1 && p >= 0.3) ? { type: "call" } : { type: "fold" };
    }
    if (l.canRaise && p > 0.8) return rise(l, l.maxRaiseTo);
    if (l.canRaise && p < 0.2) return rise(l, l.minRaiseTo + span * 0.5);
    return { type: "check" };
  }
};

/** 诈唬狂：能加注就 min+1，面对加注只有 q>0.7 才跟。 */
export const bluffer: Strategy = {
  name: "诈唬狂",
  select: tight.select,
  bet: (s) => {
    const l = legalBets(s, "player");
    const p = q(s, s.players.player.chosen!);
    if (l.canCall) return p > 0.7 ? { type: "call" } : { type: "fold" };
    if (l.canRaise) return rise(l, l.minRaiseTo + 1);
    return { type: "check" };
  }
};

/** 十局一换：每 10 局在稳健与诈唬狂之间整体切换，考验对手模型的适应速度。 */
const switcherPhase = (s: GameState) => (Math.floor((s.round - 1) / 10) % 2 === 0 ? tight : bluffer);
export const switcher: Strategy = {
  name: "十局一换",
  select: (s, rng) => switcherPhase(s).select(s, rng),
  bet: (s, rng) => switcherPhase(s).bet(s, rng)
};

/** 换码：前 14 局「弱牌大码、强牌小码」，第 15 局起反过来，专治把额度当牌力读的模型。 */
export const sizeSwitcher: Strategy = {
  name: "换码",
  select: tight.select,
  bet: (s) => {
    const l = legalBets(s, "player");
    const p = q(s, s.players.player.chosen!);
    const early = s.round < 15;
    const big = l.maxRaiseTo;
    const small = l.minRaiseTo;
    if (l.canCall) {
      if (p >= 0.75 && l.canRaise) return rise(l, early ? small : big);
      return p >= 0.4 || (l.callAmount <= 1 && p > 0.25) ? { type: "call" } : { type: "fold" };
    }
    if (l.canRaise) {
      if (p < 0.35) return rise(l, early ? big : small);
      if (p > 0.7) return rise(l, early ? small : big);
    }
    return { type: "check" };
  }
};

/** 机器人最近若干局的公开动作统计。 */
export interface BotTendencies {
  /** 不面对加注时选择过牌的比例。 */
  checkRate: number;
  /** 面对加注时弃牌的比例。 */
  foldToRaise: number;
  /** 全部决策里加注的比例。 */
  raiseRate: number;
  /** 统计到的机器人决策数。 */
  samples: number;
}

/**
 * 只用 `s.history[*].actions`（公开动作）统计机器人最近 rounds 局的倾向。
 * 回放每一局的押注水平以区分「他能过牌」和「他在面对加注」。
 */
export function botTendencies(s: GameState, rounds = 12): BotTendencies {
  let checks = 0;
  let checkSpots = 0;
  let folds = 0;
  let faced = 0;
  let raises = 0;
  let acts = 0;
  for (const r of s.history.slice(-rounds)) {
    const st: Record<Side, number> = { player: 1, ai: 1 }; // 双方底注各 1
    for (const a of r.actions) {
      const opp: Side = a.side === "ai" ? "player" : "ai";
      if (a.side === "ai") {
        acts += 1;
        if (st[opp] > st.ai) {
          faced += 1;
          if (a.type === "fold") folds += 1;
        } else {
          checkSpots += 1;
          if (a.type === "check") checks += 1;
        }
        if (a.type === "raise") raises += 1;
      }
      if (a.type === "raise") st[a.side] = a.raiseTo ?? st[a.side];
      else if (a.type === "call") st[a.side] = st[opp];
    }
  }
  return {
    checkRate: checkSpots > 0 ? checks / checkSpots : 0,
    foldToRaise: faced > 0 ? folds / faced : 0,
    raiseRate: acts > 0 ? raises / acts : 0,
    samples: acts
  };
}

/**
 * 反学习：读机器人最近 12 局的公开动作，按它的漏洞切换打法。
 * 弃牌率 > 0.6 → 每手 min+1 施压；过牌率 > 0.6 → 它一过牌就偷；否则按稳健型打。
 */
export const counterLearner: Strategy = {
  name: "反学习",
  select: tight.select,
  bet: (s, rng) => {
    const l = legalBets(s, "player");
    const p = q(s, s.players.player.chosen!);
    const t = botTendencies(s, 12);
    if (t.samples >= 6 && t.foldToRaise > 0.6) {
      if (l.canRaise) return rise(l, l.minRaiseTo + 1);
      if (l.canCall) return p >= 0.35 ? { type: "call" } : { type: "fold" };
      return { type: "check" };
    }
    if (t.samples >= 6 && t.checkRate > 0.6 && botChecked(s) && l.canRaise) return rise(l, l.minRaiseTo + 1);
    return tight.bet(s, rng);
  }
};

/** 全部基准对手，按「越靠后越针对机器人的可读性」排列。 */
export const BENCH_STRATEGIES: Strategy[] = [
  random,
  station,
  tight,
  oldBot,
  checkPunisher,
  tellReader,
  polarized,
  bluffer,
  switcher,
  sizeSwitcher,
  counterLearner
];

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

// ---------- 泄露度量与耗时 ----------

/** 排名（并列取中位名次），用于 Mann–Whitney AUC 和 Spearman。 */
function midRanks(xs: number[]): number[] {
  const n = xs.length;
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && xs[idx[j + 1]] === xs[idx[i]]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k]] = r;
    i = j + 1;
  }
  return ranks;
}

/** 用 score 预测二元 label 的 AUC（Mann–Whitney U / n1n2）；某一类为空时返回 NaN。 */
export function rocAuc(scores: number[], labels: boolean[]): number {
  const ranks = midRanks(scores);
  let sumPos = 0;
  let nPos = 0;
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i]) {
      sumPos += ranks[i];
      nPos += 1;
    }
  }
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return NaN;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Spearman 秩相关；样本 < 3 或某一列全并列时返回 NaN。 */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length < 3) return NaN;
  const rx = midRanks(xs);
  const ry = midRanks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}

export interface LatencyStats {
  count: number;
  median: number;
  mean: number;
  max: number;
}

function latency(ms: number[]): LatencyStats {
  if (ms.length === 0) return { count: 0, median: 0, mean: 0, max: 0 };
  const s = ms.slice().sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { count: s.length, median: mid, mean: s.reduce((a, b) => a + b, 0) / s.length, max: s[s.length - 1] };
}

/** 一次「双方押注相同时的首个动作」样本。 */
export interface TellSample {
  /** 机器人这一局打出的点数。 */
  rank: number;
  /** 打出的点数在其指示灯类别（UP 8–A / DOWN 2–7）内的相对强度，∈[0,1]。 */
  strength: number;
  /** 打出的点数在全部 13 个点数里的相对强度（按点数序，2 当最小）。 */
  absStrength: number;
  /** 机器人自己的灯：UP2 / DOWN2 时对手已知打出的类别，MIX 时类别本身也是隐藏信息。 */
  ctx: "UP2" | "MIX" | "DOWN2";
  raised: boolean;
  /** 加注额占可加空间的比例 f = (raiseTo − from)/(M − from)；没加注或没空间时为 null。 */
  f: number | null;
}

export interface TellStats {
  /**
   * 主指标：用「是否加注」预测「同类别内相对强度 ≥ 0.5」的 AUC。
   * 0.5 = 完全读不出，1 = 加注即强牌。只看类别内是因为 UP2 / DOWN2 时类别本身已由指示灯公开。
   */
  auc: number;
  /** 加注额度 f 与类别内相对强度的 Spearman 相关（只统计加注的样本）。 */
  spearman: number;
  /**
   * 副指标：用「是否加注」预测「打出的是 UP 牌（点数 ≥ 8）」的 AUC。
   * MIX 灯时类别是隐藏信息，所以这一项才是「整张牌有多好读」的上界。
   */
  aucAbs: number;
  /** 加注额度 f 与绝对点数强弱的 Spearman 相关。 */
  spearmanAbs: number;
  samples: number;
  raises: number;
  /** 加注样本占全部样本的比例，方便解读 AUC。 */
  raiseRate: number;
  bet: LatencyStats;
  select: LatencyStats;
  wins: number;
  games: number;
  rounds: number;
  raw: TellSample[];
}

/** 点数在其指示灯类别内的相对强度（按点数序，忽略「2 克 A」）。 */
export function rankStrength(rank: number): number {
  return rank >= 8 ? (rank - 8) / 6 : (rank - 2) / 5;
}
/** 点数在全部 13 个点数里的相对强度（按点数序，忽略「2 克 A」）。 */
export const absRankStrength = (rank: number): number => (rank - 2) / 12;

/**
 * 泄露度量：让机器人对 opponent 打 games 局，记录它每局「双方押注相同时的首个动作」，
 * 看「是否加注 / 加注多大」能多准地读出它手上那张牌在灯类别内的强弱。
 * 顺带统计 botBet / botSelect 的单次决策耗时。
 */
export function measureTells(
  bot: BotSide = { select: botSelect, bet: botBet, view: publicView },
  games = 20,
  seed = 21,
  opponent: Strategy = tight,
  lives = 12
): TellStats {
  const raw: TellSample[] = [];
  const betMs: number[] = [];
  const selectMs: number[] = [];
  let wins = 0;
  let rounds = 0;
  for (let g = 0; g < games; g += 1) {
    const rng = seededRng(seed * 1000 + g);
    const s = newGame({ rng, firstMover: "random", playerLives: lives, aiLives: lives });
    startRound(s, rng);
    let guard = 0;
    while (s.phase !== "gameover" && guard < 600) {
      guard += 1;
      const t0 = performance.now();
      const sel = bot.select(bot.view(s), rng);
      selectMs.push(performance.now() - t0);
      selectCard(s, "ai", sel.cardId!);
      selectCard(s, "player", opponent.select(s, rng));
      let acted = false;
      while (s.phase === "betting") {
        if (s.toAct === "ai") {
          const from = s.players.ai.stake;
          const equal = from === s.players.player.stake;
          const M = s.maxStake;
          const t1 = performance.now();
          const d = bot.bet(bot.view(s), rng);
          betMs.push(performance.now() - t1);
          const b = d.bet!;
          if (!acted && equal) {
            const raised = b.type === "raise";
            const rank = s.players.ai.chosen!.rank;
            // 指示灯（含已选的牌）：手上只有 2 张，所以 up 为 0/1/2。
            const up = [s.players.ai.chosen!, ...s.players.ai.hand].filter(isUp).length;
            raw.push({
              rank,
              strength: rankStrength(rank),
              absStrength: absRankStrength(rank),
              ctx: up === 2 ? "UP2" : up === 0 ? "DOWN2" : "MIX",
              raised,
              f: raised && M > from ? (b.raiseTo! - from) / (M - from) : null
            });
          }
          acted = true;
          act(s, "ai", b);
        } else {
          act(s, "player", opponent.bet(s, rng));
        }
      }
      rounds += 1;
      if (s.phase === "showdown") {
        clearTable(s);
        startRound(s, rng);
      }
    }
    if (s.winner ? s.winner === "ai" : s.players.ai.lives > s.players.player.lives) wins += 1;
  }
  const flags = raw.map((r) => (r.raised ? 1 : 0));
  const auc = rocAuc(flags, raw.map((r) => r.strength >= 0.5));
  const aucAbs = rocAuc(flags, raw.map((r) => r.rank >= 8));
  const sized = raw.filter((r) => r.f != null);
  const sp = spearman(sized.map((r) => r.f!), sized.map((r) => r.strength));
  const spAbs = spearman(sized.map((r) => r.f!), sized.map((r) => r.absStrength));
  const raises = raw.filter((r) => r.raised).length;
  return {
    auc,
    spearman: sp,
    aucAbs,
    spearmanAbs: spAbs,
    samples: raw.length,
    raises,
    raiseRate: raw.length > 0 ? raises / raw.length : 0,
    bet: latency(betMs),
    select: latency(selectMs),
    wins,
    games,
    rounds,
    raw
  };
}

/** 只要耗时的话可以直接用这个（内部就是 measureTells）。 */
export function measureLatency(
  bot: BotSide = { select: botSelect, bet: botBet, view: publicView },
  games = 20,
  seed = 21
): { bet: LatencyStats; select: LatencyStats } {
  const t = measureTells(bot, games, seed);
  return { bet: t.bet, select: t.select };
}
