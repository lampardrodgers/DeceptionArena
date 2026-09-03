export type Suit = "S" | "H" | "D" | "C";

export interface Card {
  id: string;
  rank: number; // 2..14, 14 = A
  suit: Suit;
}

export const SUITS: Suit[] = ["S", "H", "D", "C"];
export const SUIT_SYMBOL: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const RANK_LABEL: Record<number, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A"
};

export function cardLabel(card: Card): string {
  return `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]}`;
}

/** One Poker: 8,9,10,J,Q,K,A are UP. 2..7 are DOWN. */
export function isUp(card: Card): boolean {
  return card.rank >= 8;
}

export function category(card: Card): "UP" | "DOWN" {
  return isUp(card) ? "UP" : "DOWN";
}

/**
 * Compare two played cards under One Poker rules.
 * Higher rank wins; A is highest; the single exception is that 2 beats A.
 * Suits never matter. Returns 1 if a wins, -1 if b wins, 0 for a draw.
 */
export function compareCards(a: Card, b: Card): -1 | 0 | 1 {
  if (a.rank === b.rank) return 0;
  if (a.rank === 2 && b.rank === 14) return 1;
  if (a.rank === 14 && b.rank === 2) return -1;
  return a.rank > b.rank ? 1 : -1;
}

/** Does `a` beat `b`? */
export function beats(a: Card, b: Card): boolean {
  return compareCards(a, b) === 1;
}

/** Build `copies` jokerless 52-card decks. Ids stay unique across copies (e.g. "KS#2"). */
export function createDeck(copies = 1): Card[] {
  const deck: Card[] = [];
  for (let copy = 1; copy <= copies; copy += 1) {
    for (const suit of SUITS) {
      for (let rank = 2; rank <= 14; rank += 1) {
        deck.push({ id: `${RANK_LABEL[rank]}${suit}${copies > 1 ? `#${copy}` : ""}`, rank, suit });
      }
    }
  }
  return deck;
}

export type Rng = () => number;

export function shuffle<T>(items: T[], rng: Rng = Math.random): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Deterministic PRNG (mulberry32) for tests and replays. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
