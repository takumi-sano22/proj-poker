// Range の表記の展開と、Range Model の Config（標準・狭い・広い）のテスト。Combo 数は手計算。
import { describe, expect, it } from "vitest";
import {
  LOOSE_RANGE_PROFILE,
  RANGE_PROFILES,
  STANDARD_RANGE_PROFILE,
  TIGHT_RANGE_PROFILE,
  type RangeProfile,
} from "./range-config.js";
import { comboKey, parseRange } from "./range.js";

describe("parseRange", () => {
  it.each([
    // Pocket Pair は 4 枚から 2 枚 = 6、Suited は 4、Offsuit は 4 × 3 = 12。
    ["AA", 6],
    ["AKs", 4],
    ["AKo", 12],
    ["AK", 16],
    // 22〜AA の 13 種類 × 6 = 78。
    ["22+", 78],
    // TT・JJ・QQ・KK・AA = 5 × 6。
    ["TT+", 30],
    // 66〜99 の 4 種類 × 6。
    ["99-66", 24],
    ["66-99", 24],
    // ATs・AJs・AQs・AKs = 4 × 4。
    ["ATs+", 16],
    // A2s〜A5s = 4 × 4。
    ["A5s-A2s", 16],
    // A2〜AK の 12 種類 × 12。
    ["A2o+", 144],
    ["random", 1326],
    // 重複はまとめる（AKs は AK に含まれる）。
    ["AK, AKs", 16],
  ])("%s は %i 通り", (notation, count) => {
    const combos = parseRange(notation);
    expect(combos).toHaveLength(count);
    expect(new Set(combos.map(comboKey)).size).toBe(count);
  });

  it("Suited は同じ Suit、Offsuit は違う Suit、Pair は同じ Rank", () => {
    expect(parseRange("AKs").every(([a, b]) => a.suit === b.suit)).toBe(true);
    expect(parseRange("AKo").every(([a, b]) => a.suit !== b.suit)).toBe(true);
    expect(parseRange("QQ").every(([a, b]) => a.rank === b.rank)).toBe(true);
  });

  it.each(["", "AX", "KA", "AKx", "AAs", "A5s-K2s", "AKs-AQo", "A"])(
    "不正な表記 %j は例外にする",
    (notation) => {
      expect(() => parseRange(notation)).toThrow(RangeError);
    },
  );

  it("同じ表記なら同じ順序になる（決定論）", () => {
    expect(parseRange(STANDARD_RANGE_PROFILE.open.BTN)).toEqual(
      parseRange(STANDARD_RANGE_PROFILE.open.BTN),
    );
  });
});

/** Profile の Range の表記を全部並べる（名前つき）。 */
function notations(profile: RangeProfile): [string, string][] {
  return [
    ...Object.entries(profile.open).map(
      ([position, n]) => [`open.${position}`, n] as [string, string],
    ),
    ["limp", profile.limp],
    ["callOpen", profile.callOpen],
    ["threeBet", profile.threeBet],
    ["callThreeBet", profile.callThreeBet],
    ["fourBetPlus", profile.fourBetPlus],
  ];
}

describe("Range Model の Config", () => {
  it("全 Profile の表記が展開できる", () => {
    for (const profile of RANGE_PROFILES) {
      for (const [, notation] of notations(profile)) {
        expect(parseRange(notation).length).toBeGreaterThan(0);
      }
    }
  });

  it("標準の open は Early から Late へ広がる（docs/research/02 §8）", () => {
    const count = (position: keyof RangeProfile["open"]): number =>
      parseRange(STANDARD_RANGE_PROFILE.open[position]).length;
    expect(count("UTG")).toBeLessThan(count("HJ"));
    expect(count("HJ")).toBeLessThan(count("CO"));
    expect(count("CO")).toBeLessThan(count("BTN"));
  });

  it("どの Spot でも 狭い想定 < 標準 < 広い想定（D08 の別 Range 想定）", () => {
    const tight = notations(TIGHT_RANGE_PROFILE);
    const standard = notations(STANDARD_RANGE_PROFILE);
    const loose = notations(LOOSE_RANGE_PROFILE);
    standard.forEach(([name, notation], i) => {
      const t = parseRange((tight[i] as [string, string])[1]).length;
      const s = parseRange(notation).length;
      const l = parseRange((loose[i] as [string, string])[1]).length;
      expect(t, `${name}: tight < standard`).toBeLessThan(s);
      expect(s, `${name}: standard < loose`).toBeLessThan(l);
    });
    expect(TIGHT_RANGE_PROFILE.postflop.betOrRaiseKeep).toBeLessThan(
      STANDARD_RANGE_PROFILE.postflop.betOrRaiseKeep,
    );
    expect(STANDARD_RANGE_PROFILE.postflop.callKeep).toBeLessThan(
      LOOSE_RANGE_PROFILE.postflop.callKeep,
    );
  });
});
