// Card / Deck の型と生成。Engine の最下層で、他モジュールの依存先になる（D40: カードは決定論的 Engine が扱う）。

/** Rank は数値（2〜14、Ace=14）で持つ。比較・Kicker 判定を単純な数値比較にするため。 */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

/** Suit は 1 文字（c=Club / d=Diamond / h=Heart / s=Spade）。文字列表記 "As" の 2 文字目と一致させる。 */
export type Suit = "c" | "d" | "h" | "s";

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

export const RANKS: readonly Rank[] = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
];
export const SUITS: readonly Suit[] = ["c", "d", "h", "s"];

/** 52 枚の標準 Deck の枚数。Joker は使わない。 */
export const DECK_SIZE = RANKS.length * SUITS.length;

// 文字列表記の Rank 文字。添字が Rank - 2 に対応する。
const RANK_CHARS = "23456789TJQKA";

/** 全 52 枚を固定順（Suit → Rank 昇順）で返す。シャッフル前の「新品の Deck」。 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/** Card を "As" / "Td" / "2c" 形式の文字列にする（ログ・テスト用）。 */
export function cardToString(card: Card): string {
  return `${RANK_CHARS.charAt(card.rank - 2)}${card.suit}`;
}

/** "As" / "Td" 形式の文字列を Card にする。不正な表記は例外にする（黙って丸めない）。 */
export function parseCard(text: string): Card {
  if (text.length !== 2) {
    throw new RangeError(`不正なカード表記: "${text}"`);
  }
  const rankIndex = RANK_CHARS.indexOf(text.charAt(0));
  const suit = text.charAt(1);
  if (rankIndex < 0 || !isSuit(suit)) {
    throw new RangeError(`不正なカード表記: "${text}"`);
  }
  return { rank: RANKS[rankIndex] as Rank, suit };
}

/** 空白区切りの複数カード表記（"As Kd 7c"）を Card の配列にする。 */
export function parseCards(text: string): Card[] {
  const tokens = text.trim().split(/\s+/);
  return tokens[0] === "" ? [] : tokens.map(parseCard);
}

function isSuit(value: string): value is Suit {
  return (SUITS as readonly string[]).includes(value);
}

/** 同じ Rank と Suit なら同一カードとみなす。 */
export function cardsEqual(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}
