import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitPot } from "./pot-split.js";

describe("splitPot: Property", () => {
  it("Σ 配分 = Pot（端数込みで Chip が保存される。INV-TEST-005）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 8 }),
        (pot, winners) => {
          const ids = Array.from({ length: winners }, (_, i) => `p${i}`);
          const awards = splitPot(pot, ids, "first_left_of_button");
          expect(awards.reduce((sum, a) => sum + a.amount, 0)).toBe(pot);
          expect(awards.map((a) => a.playerId)).toEqual(ids);
          expect(awards.every((a) => Number.isSafeInteger(a.amount))).toBe(
            true,
          );
        },
      ),
    );
  });

  it("配分は floor(pot / n) か +1 のどちらかで、+1 は先頭から連続する", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 8 }),
        (pot, winners) => {
          const ids = Array.from({ length: winners }, (_, i) => `p${i}`);
          const amounts = splitPot(pot, ids, "first_left_of_button").map(
            (a) => a.amount,
          );
          const base = Math.floor(pot / winners);
          const extra = pot % winners;
          expect(amounts).toEqual(
            amounts.map((_, i) => base + (i < extra ? 1 : 0)),
          );
        },
      ),
    );
  });
});
