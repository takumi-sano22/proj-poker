// 速い役の強さ（handScore）が、読みやすさ優先の Hand Evaluator（evaluateHand）と同じ値を返すことの Property Test。
// Equity の全列挙は handScore だけで勝敗を決めるので、ここが一致していれば Equity の勝敗判定は Hand Evaluator と同じになる。
// fast-check の seed は実行ごとに変わる（POKER_PROPERTY_SEED で固定。testing/property.ts）。失敗時は fast-check が seed と縮小済みの反例を出すので、hand-strength.test.ts に固定で足す。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDeck, type Card } from "./card.js";
import { evaluateHand } from "./hand-evaluator.js";
import { cardCode, cardFromCode, handScore } from "./hand-strength.js";
import { propertyParams } from "./testing/property.js";

const deck = createDeck();
const cardsOf = (min: number, max: number): fc.Arbitrary<Card[]> =>
  fc.shuffledSubarray(deck, { minLength: min, maxLength: max });

describe("handScore: Property", () => {
  it("5〜7 枚で evaluateHand の score と一致する", () => {
    fc.assert(
      fc.property(cardsOf(5, 7), (cards) => {
        expect(handScore(cards.map(cardCode))).toBe(evaluateHand(cards).score);
      }),
      propertyParams(3000),
    );
  });

  it("Flush・Straight が出やすい 1 Suit 寄りの 7 枚でも一致する", () => {
    // 半分以上を同じ Suit から取り、Straight Flush・Flush と Full House の優先順位の境目を多く通す。
    const hearts = deck.filter((c) => c.suit === "h");
    const others = deck.filter((c) => c.suit !== "h");
    fc.assert(
      fc.property(
        fc.shuffledSubarray(hearts, { minLength: 4, maxLength: 6 }),
        fc.shuffledSubarray(others, { minLength: 3, maxLength: 3 }),
        (h, o) => {
          const cards = [...h, ...o].slice(0, 7);
          expect(handScore(cards.map(cardCode))).toBe(
            evaluateHand(cards).score,
          );
        },
      ),
      propertyParams(2000),
    );
  });

  it("cardCode と cardFromCode は往復で同じ Card に戻る", () => {
    for (const card of deck) {
      expect(cardFromCode(cardCode(card))).toEqual(card);
    }
  });
});
