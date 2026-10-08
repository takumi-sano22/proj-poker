// payoutsByPlace の Property（#186・docs/02 §7）。割合（合計 100%）と Prize Pool を変えても、合計の保存と端数の配り方が崩れないこと。
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { propertyParams } from "./testing/property.js";
import { payoutsByPlace } from "./tournament-payout.js";

/** 合計 100 の 1 以上の整数の列（1〜8 個。上位ほど多いか同じに並べる）。 */
const percentagesArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 99 }), { maxLength: 7 })
  .map((cuts) => {
    const points = [0, ...[...cuts].sort((a, b) => a - b), 100];
    return points
      .slice(1)
      .map((p, i) => p - (points[i] as number))
      .sort((a, b) => b - a);
  });

describe("payoutsByPlace: Property", () => {
  it("Σ 順位ごとの賞金 = Prize Pool。各順位は切り捨ての額か +1 で、+1 は上位から連続し、上位ほど多いか同じ", () => {
    fc.assert(
      fc.property(
        percentagesArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        (percentages, pool) => {
          const amounts = payoutsByPlace(
            { kind: "percentages", percentages },
            pool,
          );
          expect(amounts).toHaveLength(percentages.length);
          expect(amounts.reduce((sum, a) => sum + a, 0)).toBe(pool);
          const extras = amounts.map(
            (a, i) => a - Math.floor((pool * (percentages[i] as number)) / 100),
          );
          expect(extras.every((e) => e === 0 || e === 1)).toBe(true);
          const ones = extras.filter((e) => e === 1).length;
          expect(extras.slice(0, ones).every((e) => e === 1)).toBe(true);
          expect(
            amounts.every((a, i) => i === 0 || a <= (amounts[i - 1] as number)),
          ).toBe(true);
        },
      ),
      propertyParams(),
    );
  });
});
