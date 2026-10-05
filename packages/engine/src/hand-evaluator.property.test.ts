import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDeck, type Card } from "./card.js";
import {
  compareHands,
  evaluateHand,
  type HandValue,
} from "./hand-evaluator.js";

const deck = createDeck();

// 重複のない n 枚の Hand を生成する（52 枚の部分集合を任意の順序で）。
const distinctCards = (n: number): fc.Arbitrary<Card[]> =>
  fc
    .shuffledSubarray(deck, { minLength: n, maxLength: n })
    .map((cards) => cards);
const sevenCards = distinctCards(7);

// score の符号化とは独立に、(category, tiebreakers) を辞書式で比較する参照実装。
function lexicographic(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return Math.sign(a.category - b.category);
  for (let i = 0; i < a.tiebreakers.length; i++) {
    const diff = (a.tiebreakers[i] ?? 0) - (b.tiebreakers[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

describe("Hand Evaluator: Property", () => {
  it("反対称性: compare(a, b) = -compare(b, a)", () => {
    fc.assert(
      fc.property(sevenCards, sevenCards, (x, y) => {
        const a = evaluateHand(x);
        const b = evaluateHand(y);
        expect(compareHands(a, b)).toBe(-compareHands(b, a) || 0);
      }),
    );
  });

  it("反射性: 自分自身との比較は 0", () => {
    fc.assert(
      fc.property(sevenCards, (x) => {
        const a = evaluateHand(x);
        expect(compareHands(a, a)).toBe(0);
      }),
    );
  });

  it("推移律: a >= b かつ b >= c なら a >= c", () => {
    fc.assert(
      fc.property(sevenCards, sevenCards, sevenCards, (x, y, z) => {
        const [a, b, c] = [x, y, z].map(evaluateHand) as [
          HandValue,
          HandValue,
          HandValue,
        ];
        if (compareHands(a, b) >= 0 && compareHands(b, c) >= 0) {
          expect(compareHands(a, c)).toBeGreaterThanOrEqual(0);
        }
        if (compareHands(a, b) <= 0 && compareHands(b, c) <= 0) {
          expect(compareHands(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("score の大小は (category, tiebreakers) の辞書式比較と一致する", () => {
    fc.assert(
      fc.property(sevenCards, sevenCards, (x, y) => {
        const a = evaluateHand(x);
        const b = evaluateHand(y);
        expect(compareHands(a, b)).toBe(lexicographic(a, b));
      }),
    );
  });

  it("カードの並び順を入れ替えても結果は変わらない", () => {
    fc.assert(
      fc.property(
        sevenCards.chain((cards) =>
          fc.tuple(
            fc.constant(cards),
            fc.shuffledSubarray(cards, { minLength: 7, maxLength: 7 }),
          ),
        ),
        ([cards, permuted]) => {
          expect(evaluateHand(permuted).score).toBe(evaluateHand(cards).score);
        },
      ),
    );
  });

  it("単調性: カードを足しても評価は下がらない（5 → 6 → 7 枚）", () => {
    fc.assert(
      fc.property(sevenCards, (cards) => {
        const five = evaluateHand(cards.slice(0, 5)).score;
        const six = evaluateHand(cards.slice(0, 6)).score;
        const seven = evaluateHand(cards).score;
        expect(six).toBeGreaterThanOrEqual(five);
        expect(seven).toBeGreaterThanOrEqual(six);
      }),
    );
  });

  it("bestFive は入力の中の 5 枚で、評価し直すと同じ score になる", () => {
    fc.assert(
      fc.property(sevenCards, (cards) => {
        const value = evaluateHand(cards);
        expect(value.bestFive).toHaveLength(5);
        for (const picked of value.bestFive) {
          expect(cards).toContainEqual(picked);
        }
        expect(evaluateHand(value.bestFive).score).toBe(value.score);
      }),
    );
  });
});
