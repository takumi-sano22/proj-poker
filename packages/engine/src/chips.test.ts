import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHIP_DENOMINATIONS,
  composeChips,
  type ChipCount,
  type ChipDenomination,
} from "./chips.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";

const total = (stacks: readonly ChipCount[]) =>
  stacks.reduce((sum, s) => sum + s.denomination.value * s.count, 0);

describe("Chip の額面 Preset（D92・OI-004 の暫定値）", () => {
  it("1 白・5 赤・25 緑・100 黒・500 紫で、卓の設定（Table Config）が持つ", () => {
    expect(DEFAULT_CHIP_DENOMINATIONS.map((d) => [d.value, d.color])).toEqual([
      [1, "white"],
      [5, "red"],
      [25, "green"],
      [100, "black"],
      [500, "purple"],
    ]);
    expect(PHASE1_CASH_PRESET.chipDenominations).toBe(
      DEFAULT_CHIP_DENOMINATIONS,
    );
  });
});

describe("composeChips", () => {
  const brief = (amount: number) =>
    composeChips(amount).map((s) => [s.denomination.value, s.count]);

  it("大きい額面から貪欲に組み、枚数 0 の額面は含めない", () => {
    expect(brief(0)).toEqual([]);
    expect(brief(1)).toEqual([[1, 1]]);
    expect(brief(200)).toEqual([[100, 2]]);
    expect(brief(37)).toEqual([
      [25, 1],
      [5, 2],
      [1, 2],
    ]);
    expect(brief(1234)).toEqual([
      [500, 2],
      [100, 2],
      [25, 1],
      [5, 1],
      [1, 4],
    ]);
  });

  it("不正な額は例外にする（黙って丸めない）", () => {
    expect(() => composeChips(-1)).toThrow(RangeError);
    expect(() => composeChips(1.5)).toThrow(RangeError);
    expect(() => composeChips(Number.NaN)).toThrow(RangeError);
    expect(() => composeChips(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it("1 が無い額面では端数を組めないので例外にする。不正・重複した額面も例外", () => {
    const noOne: ChipDenomination[] = [{ value: 5, color: "red" }];
    expect(() => composeChips(7, noOne)).toThrow(RangeError);
    expect(composeChips(10, noOne)).toHaveLength(1);
    expect(() => composeChips(1, [{ value: 0, color: "white" }])).toThrow(
      RangeError,
    );
    expect(() =>
      composeChips(1, [
        { value: 1, color: "white" },
        { value: 1, color: "red" },
      ]),
    ).toThrow(RangeError);
  });
});

describe("composeChips: Property", () => {
  it("構成の合計 = 額（Chip は増減しない）で、枚数は 1 以上の整数・額面は大きい順", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (amount) => {
        const stacks = composeChips(amount);
        expect(total(stacks)).toBe(amount);
        expect(
          stacks.every((s) => Number.isSafeInteger(s.count) && s.count >= 1),
        ).toBe(true);
        const values = stacks.map((s) => s.denomination.value);
        expect(values).toEqual([...values].sort((a, b) => b - a));
        expect(new Set(values).size).toBe(values.length);
      }),
    );
  });

  it("Preset では、下の額面は上の額面に満たない枚数に収まる（整理済みの積み）", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (amount) => {
        const stacks = composeChips(amount);
        for (const [i, s] of stacks.entries()) {
          const upper = stacks[i - 1];
          if (upper === undefined) continue;
          // 1 つ上の額面（Preset に隣り合う額面）の 1 枚分に満たない
          expect(s.denomination.value * s.count).toBeLessThan(
            upper.denomination.value,
          );
        }
      }),
    );
  });

  it("貪欲法の枚数が最小（動的計画法の最小枚数と一致する）", () => {
    const limit = 1500;
    const best = new Array<number>(limit + 1).fill(Infinity);
    best[0] = 0;
    for (let a = 1; a <= limit; a++) {
      for (const d of DEFAULT_CHIP_DENOMINATIONS) {
        const prev = best[a - d.value];
        if (
          d.value <= a &&
          prev !== undefined &&
          prev + 1 < (best[a] ?? Infinity)
        ) {
          best[a] = prev + 1;
        }
      }
    }
    fc.assert(
      fc.property(fc.integer({ min: 0, max: limit }), (amount) => {
        const pieces = composeChips(amount).reduce((n, s) => n + s.count, 0);
        expect(pieces).toBe(best[amount]);
      }),
    );
  });
});
