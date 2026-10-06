// Equity の Property Test。全列挙の Hand vs Hand は、両者の Equity の和がちょうど 1 になる（引き分けは等分）。
// fast-check の seed は実行ごとに変わる。失敗時は fast-check が seed と縮小済みの反例を出すので、equity.test.ts に固定で足す。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDeck, type Card } from "./card.js";
import { equityVsRanges } from "./equity.js";
import type { Combo } from "./range.js";

const deck = createDeck();

describe("equityVsRanges: Property", () => {
  it("Flop・Turn・River の Hand vs Hand は全列挙で、Equity の和が 1", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(deck, { minLength: 9, maxLength: 9 }),
        fc.constantFrom(3, 4, 5),
        (cards: Card[], boardSize: number) => {
          const a = cards.slice(0, 2);
          const b = cards.slice(2, 4);
          const board = cards.slice(4, 4 + boardSize);
          const ab = equityVsRanges(a, board, [[b as unknown as Combo]]);
          const ba = equityVsRanges(b, board, [[a as unknown as Combo]]);
          expect(ab.method).toBe("exact");
          expect(ab.trials).toBe(ba.trials);
          // 勝ち・引き分けの回数は整数なので、割合の和は浮動小数の誤差の範囲で 1。
          expect(ab.equity + ba.equity).toBeCloseTo(1, 12);
          expect(ab.tie).toBe(ba.tie);
        },
      ),
      { numRuns: 60 },
    );
  });
});
