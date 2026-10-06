import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildPots, type PotContributor } from "./side-pots.js";
import { propertyParams } from "./testing/property.js";

const c = (
  playerId: string,
  totalCommitted: number,
  folded = false,
): PotContributor => ({ playerId, totalCommitted, folded });

describe("buildPots", () => {
  it("全員の Commit が同じなら Main Pot だけ", () => {
    expect(buildPots([c("a", 100), c("b", 100), c("c", 100)])).toEqual([
      { amount: 300, eligible: ["a", "b", "c"] },
    ]);
  });

  it("All-in の額ごとに段を切る（Main → Side の順。期待値は手計算）", () => {
    // 段: 30 / 80 / 100。Main = 30 × 4、Side 1 = 50 × 3、Side 2 = 20 × 2。
    expect(
      buildPots([c("a", 30), c("b", 80), c("c", 100), c("d", 100)]),
    ).toEqual([
      { amount: 120, eligible: ["a", "b", "c", "d"] },
      { amount: 150, eligible: ["b", "c", "d"] },
      { amount: 40, eligible: ["c", "d"] },
    ]);
  });

  it("Fold した Player の Chip は入った段の Pot に死に金として残り、その Player は争えない", () => {
    // 段は Fold していない a（50）と c（200）だけ。b の 120 は Main に 50、Side に 70。
    expect(buildPots([c("a", 50), c("b", 120, true), c("c", 200)])).toEqual([
      { amount: 150, eligible: ["a", "c"] },
      { amount: 220, eligible: ["c"] },
    ]);
  });

  it("Fold した Player の額は段を作らない（同じ顔ぶれの Pot に分けない）", () => {
    expect(buildPots([c("a", 2, true), c("b", 10), c("c", 10)])).toEqual([
      { amount: 22, eligible: ["b", "c"] },
    ]);
  });

  it("最後の段より上にある Fold した Player の Chip も取りこぼさず最後の Pot に入れる", () => {
    expect(buildPots([c("a", 10), c("b", 30, true)])).toEqual([
      { amount: 40, eligible: ["a"] },
    ]);
  });

  it("争える Player がいない・Commit が不正なら RangeError", () => {
    expect(() => buildPots([c("a", 10, true), c("b", 10, true)])).toThrow(
      RangeError,
    );
    expect(() => buildPots([c("a", -1), c("b", 10)])).toThrow(RangeError);
    expect(() => buildPots([c("a", 1.5), c("b", 10)])).toThrow(RangeError);
  });

  it("Property: Σ Pot = Σ Commit、各 Pot は正の額、Side Pot ほど争える顔ぶれが狭まる", () => {
    const contributors = fc
      .array(
        fc.record({
          totalCommitted: fc.integer({ min: 0, max: 1000 }),
          folded: fc.boolean(),
        }),
        { minLength: 2, maxLength: 8 },
      )
      .filter((cs) => cs.some((x) => !x.folded && x.totalCommitted > 0));
    fc.assert(
      fc.property(contributors, (raw) => {
        const cs = raw.map((x, i) => ({ playerId: `p${i}`, ...x }));
        const pots = buildPots(cs);
        const total = cs.reduce((sum, x) => sum + x.totalCommitted, 0);
        expect(pots.reduce((sum, p) => sum + p.amount, 0)).toBe(total);
        pots.forEach((pot, i) => {
          expect(pot.amount).toBeGreaterThan(0);
          expect(pot.eligible.length).toBeGreaterThan(0);
          const previous = pots[i - 1];
          if (previous !== undefined) {
            expect(pot.eligible.length).toBeLessThan(previous.eligible.length);
            expect(previous.eligible).toEqual(
              expect.arrayContaining([...pot.eligible]),
            );
          }
        });
      }),
      propertyParams(300),
    );
  });
});
