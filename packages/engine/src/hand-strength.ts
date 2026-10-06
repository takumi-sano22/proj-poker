// Equity の列挙用の、速い役の強さ（score）の計算。
// hand-evaluator.ts の evaluateHand は読みやすさを優先して 7 枚なら 21 通りの 5 枚組を全部評価するので、
// Flop から River までの全列挙（数十万回の評価）には遅い。ここでは Card を整数のコードで持ち、Rank の枚数と Suit ごとの
// Rank の bit から直接役を決める。返す score は evaluateHand(...).score と同じ値（同じ式で畳む）で、一致は Property Test で確かめる。
// 役の名前・最強の 5 枚が要る表示は evaluateHand を使い、ここは比較用の数値だけを返す。
import { SUITS, type Card } from "./card.js";
import { HandCategory } from "./hand-evaluator.js";

/** Card の整数コード（0〜51）= (Rank − 2) × 4 + Suit の添字。Equity の列挙で Card を軽く持つための内部表現。 */
export type CardCode = number;

export function cardCode(card: Card): CardCode {
  return (card.rank - 2) * 4 + SUITS.indexOf(card.suit);
}

export function cardFromCode(code: CardCode): Card {
  return {
    rank: ((code >> 2) + 2) as Card["rank"],
    suit: SUITS[code & 3] as Card["suit"],
  };
}

// evaluateHand の score と同じ畳み方（tiebreakers 5 桁を 15 進数に並べ、category を最上位に置く）。
const BASE = 15;
const CATEGORY_UNIT = BASE ** 5;

// 1 回の評価の作業領域。Engine は同期的に 1 つずつ評価するので、毎回の割り当てを避けて使い回す。
const rankCount = new Uint8Array(15);
const suitCount = new Uint8Array(4);
const suitRanks = new Uint16Array(4);

/** 5〜7 枚のコードの役の強さ。値が大きいほど強く、同じ値は同じ強さ（Split）。evaluateHand(...).score と一致する。 */
export function handScore(codes: readonly CardCode[]): number {
  rankCount.fill(0);
  suitCount.fill(0);
  suitRanks.fill(0);
  let rankBits = 0;
  for (const code of codes) {
    const rank = (code >> 2) + 2;
    const suit = code & 3;
    rankCount[rank] = (rankCount[rank] as number) + 1;
    suitCount[suit] = (suitCount[suit] as number) + 1;
    suitRanks[suit] = (suitRanks[suit] as number) | (1 << rank);
    rankBits |= 1 << rank;
  }

  let flushBits = 0;
  for (let s = 0; s < 4; s++) {
    if ((suitCount[s] as number) >= 5) flushBits = suitRanks[s] as number;
  }
  if (flushBits !== 0) {
    const high = straightHigh(flushBits);
    if (high !== 0) return score(HandCategory.StraightFlush, high, 0, 0, 0, 0);
  }

  // 枚数ごとの Rank（高い順）。7 枚なら Quads は 1 つ、Trips は 2 つまで。Pair は上位 2 つだけ持つ。
  let quad = 0;
  let trip1 = 0;
  let trip2 = 0;
  let pair1 = 0;
  let pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const n = rankCount[r] as number;
    if (n === 4) quad = r;
    else if (n === 3) {
      if (trip1 === 0) trip1 = r;
      else trip2 = r;
    } else if (n === 2) {
      if (pair1 === 0) pair1 = r;
      else if (pair2 === 0) pair2 = r;
    }
  }

  if (quad !== 0) {
    const [k] = topRanks(rankBits & ~(1 << quad), 1);
    return score(HandCategory.FourOfAKind, quad, k ?? 0, 0, 0, 0);
  }
  if (trip1 !== 0 && (trip2 !== 0 || pair1 !== 0)) {
    // 2 つ目の Trips も Pair として使える（強い方を Pair に取る）。
    return score(
      HandCategory.FullHouse,
      trip1,
      Math.max(trip2, pair1),
      0,
      0,
      0,
    );
  }
  if (flushBits !== 0) {
    const [a, b, c, d, e] = topRanks(flushBits, 5);
    return score(HandCategory.Flush, a ?? 0, b ?? 0, c ?? 0, d ?? 0, e ?? 0);
  }
  const high = straightHigh(rankBits);
  if (high !== 0) return score(HandCategory.Straight, high, 0, 0, 0, 0);
  if (trip1 !== 0) {
    const [a, b] = topRanks(rankBits & ~(1 << trip1), 2);
    return score(HandCategory.ThreeOfAKind, trip1, a ?? 0, b ?? 0, 0, 0);
  }
  if (pair2 !== 0) {
    // 3 つ目の Pair の Rank も Kicker の候補になる（rankBits に残る）。
    const [k] = topRanks(rankBits & ~(1 << pair1) & ~(1 << pair2), 1);
    return score(HandCategory.TwoPair, pair1, pair2, k ?? 0, 0, 0);
  }
  if (pair1 !== 0) {
    const [a, b, c] = topRanks(rankBits & ~(1 << pair1), 3);
    return score(HandCategory.Pair, pair1, a ?? 0, b ?? 0, c ?? 0, 0);
  }
  const [a, b, c, d, e] = topRanks(rankBits, 5);
  return score(HandCategory.HighCard, a ?? 0, b ?? 0, c ?? 0, d ?? 0, e ?? 0);
}

function score(
  category: HandCategory,
  t0: number,
  t1: number,
  t2: number,
  t3: number,
  t4: number,
): number {
  return (
    category * CATEGORY_UNIT +
    (((t0 * BASE + t1) * BASE + t2) * BASE + t3) * BASE +
    t4
  );
}

/** Rank の bit（bit r = Rank r）の中の Straight の最高位。無ければ 0。Wheel（A-2-3-4-5）は 5。 */
function straightHigh(bits: number): number {
  // Ace（bit 14）を 1 としても数えるため bit 1 に写す。
  const withLowAce = bits | (((bits >> 14) & 1) << 1);
  for (let high = 14; high >= 5; high--) {
    if (((withLowAce >> (high - 4)) & 0b11111) === 0b11111) return high;
  }
  return 0;
}

/** Rank の bit から高い順に n 個の Rank を取る。 */
function topRanks(bits: number, n: number): number[] {
  const ranks: number[] = [];
  for (let r = 14; r >= 2 && ranks.length < n; r--) {
    if ((bits >> r) & 1) ranks.push(r);
  }
  return ranks;
}
