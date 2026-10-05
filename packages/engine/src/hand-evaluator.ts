// Hand Evaluator。5〜7 枚から最強の 5 枚を選び、比較可能な値を返す（自作。外部ライブラリは使わない・D68）。
// 性能より正しさと読みやすさを優先し、7 枚なら 21 通りの 5 枚組を全部評価して最大を取る。
import { cardsEqual, type Card } from "./card.js";

/** 役のカテゴリ。値が大きいほど強い（Royal Flush は Ace-high の Straight Flush として表す）。 */
export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  ThreeOfAKind: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  FourOfAKind: 7,
  StraightFlush: 8,
} as const;
export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory];

export interface HandValue {
  readonly category: HandCategory;
  /**
   * 同カテゴリ内の強さを決める Rank 列（先頭ほど重要）。常に 5 要素。
   * 例: Full House は [trips, pair, 0, 0, 0]、Two Pair は [high pair, low pair, kicker, 0, 0]。
   * Straight 系は [straight の最高位] で、Wheel（A-2-3-4-5）は 5。
   */
  readonly tiebreakers: readonly number[];
  /** category と tiebreakers を 1 つの整数にしたもの。大小比較・ソート用。 */
  readonly score: number;
  /** 最強として選ばれた 5 枚（表示用。tiebreakers の順に並ぶ）。 */
  readonly bestFive: readonly Card[];
}

// tiebreakers は 0〜14 の 15 値を 5 桁並べるので、15 進数として score に畳む。
const TIEBREAK_BASE = 15;
const TIEBREAK_LENGTH = 5;
const CATEGORY_UNIT = TIEBREAK_BASE ** TIEBREAK_LENGTH;

/** 5〜7 枚の Hand を評価する。枚数が範囲外・重複カードありなら例外にする。 */
export function evaluateHand(cards: readonly Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) {
    throw new RangeError(`評価できるのは 5〜7 枚: ${cards.length} 枚`);
  }
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (cardsEqual(cards[i] as Card, cards[j] as Card)) {
        throw new RangeError("同じカードが重複している");
      }
    }
  }

  let best: HandValue | undefined;
  for (const five of combinations(cards, 5)) {
    const value = evaluateFive(five);
    if (best === undefined || value.score > best.score) {
      best = value;
    }
  }
  // 5 枚以上が保証されているので組が最低 1 つある。
  return best as HandValue;
}

/** 2 つの評価結果を比較する。a が強ければ正、b が強ければ負、同価値（Split）なら 0。 */
export function compareHands(a: HandValue, b: HandValue): number {
  return Math.sign(a.score - b.score);
}

/** ちょうど 5 枚を評価する。 */
function evaluateFive(five: readonly Card[]): HandValue {
  // 同 Rank のグループを (枚数 降順, Rank 降順) に並べる。Pair 系・Kicker の判定がこの順で揃う。
  const countByRank = new Map<number, number>();
  for (const card of five) {
    countByRank.set(card.rank, (countByRank.get(card.rank) ?? 0) + 1);
  }
  const groups = [...countByRank.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const counts = groups.map((g) => g.count);

  const isFlush = five.every((c) => c.suit === (five[0] as Card).suit);
  const straightHigh = straightHighRank(groups.map((g) => g.rank));

  let category: HandCategory;
  let tiebreakers: number[];
  if (straightHigh !== undefined && isFlush) {
    category = HandCategory.StraightFlush;
    tiebreakers = [straightHigh];
  } else if (counts[0] === 4) {
    category = HandCategory.FourOfAKind;
    tiebreakers = groups.map((g) => g.rank);
  } else if (counts[0] === 3 && counts[1] === 2) {
    category = HandCategory.FullHouse;
    tiebreakers = groups.map((g) => g.rank);
  } else if (isFlush) {
    category = HandCategory.Flush;
    tiebreakers = groups.map((g) => g.rank);
  } else if (straightHigh !== undefined) {
    category = HandCategory.Straight;
    tiebreakers = [straightHigh];
  } else if (counts[0] === 3) {
    category = HandCategory.ThreeOfAKind;
    tiebreakers = groups.map((g) => g.rank);
  } else if (counts[0] === 2 && counts[1] === 2) {
    category = HandCategory.TwoPair;
    tiebreakers = groups.map((g) => g.rank);
  } else if (counts[0] === 2) {
    category = HandCategory.Pair;
    tiebreakers = groups.map((g) => g.rank);
  } else {
    category = HandCategory.HighCard;
    tiebreakers = groups.map((g) => g.rank);
  }

  while (tiebreakers.length < TIEBREAK_LENGTH) {
    tiebreakers.push(0);
  }
  return {
    category,
    tiebreakers,
    score: toScore(category, tiebreakers),
    bestFive: sortForDisplay(
      five,
      groups.map((g) => g.rank),
      straightHigh,
    ),
  };
}

/**
 * 5 つの異なる Rank（降順）が Straight なら、その最高位を返す。違えば undefined。
 * Wheel（A-2-3-4-5）は Ace を 1 として扱うので最高位は 5。
 */
function straightHighRank(
  ranksDescending: readonly number[],
): number | undefined {
  if (ranksDescending.length !== 5) {
    return undefined; // ペアがあれば Rank は 5 種類にならない
  }
  const [r0, r1, r2, r3, r4] = ranksDescending as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (r0 - r4 === 4) {
    return r0;
  }
  if (r0 === 14 && r1 === 5 && r2 === 4 && r3 === 3 && r4 === 2) {
    return 5;
  }
  return undefined;
}

function toScore(
  category: HandCategory,
  tiebreakers: readonly number[],
): number {
  return (
    tiebreakers.reduce((acc, rank) => acc * TIEBREAK_BASE + rank, 0) +
    category * CATEGORY_UNIT
  );
}

// bestFive を役の意味の順（グループの強い順。Wheel は 5-4-3-2-A）に並べる。
function sortForDisplay(
  five: readonly Card[],
  groupRanks: readonly number[],
  straightHigh: number | undefined,
): Card[] {
  if (straightHigh === 5) {
    // Wheel の Ace は 1 として末尾に置く。
    const wheelRank = (card: Card): number =>
      card.rank === 14 ? 1 : card.rank;
    return [...five].sort((a, b) => wheelRank(b) - wheelRank(a));
  }
  return [...five].sort(
    (a, b) => groupRanks.indexOf(a.rank) - groupRanks.indexOf(b.rank),
  );
}

/** items から k 枚を選ぶ全ての組を、元の順序を保って列挙する。 */
function* combinations<T>(
  items: readonly T[],
  k: number,
  start = 0,
): Generator<T[]> {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = start; i <= items.length - k; i++) {
    for (const rest of combinations(items, k - 1, i + 1)) {
      yield [items[i] as T, ...rest];
    }
  }
}
