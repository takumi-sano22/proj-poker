import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { cardToString, createDeck } from "./card.js";
import {
  createRng,
  createShuffledDeck,
  randomInt,
  shuffle,
  shuffleDeck,
} from "./rng.js";
import { propertyParams } from "./testing/property.js";

const deckKey = (seed: number): string =>
  createShuffledDeck(seed).map(cardToString).join(" ");

describe("seed 付き RNG", () => {
  it("同じ seed なら同じ乱数列になる", () => {
    const a = createRng(123);
    const b = createRng(123);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it("乱数は [0, 1) に収まる", () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("整数でない seed は拒否する", () => {
    expect(() => createRng(1.5)).toThrow(RangeError);
    expect(() => createRng(Number.NaN)).toThrow(RangeError);
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("randomInt は範囲内の整数を返し、不正な上限を拒否する", () => {
    const rng = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      seen.add(randomInt(rng, 6));
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(() => randomInt(rng, 0)).toThrow(RangeError);
    expect(() => randomInt(rng, 2.5)).toThrow(RangeError);
  });

  it("Math.random と Date を使わない（Engine の決定論）", () => {
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");
    try {
      createShuffledDeck(99);
      expect(random).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
  });
});

describe("Deck のシャッフル", () => {
  it("同じ seed なら同じ Deck、違う seed なら（この組では）違う Deck", () => {
    expect(deckKey(42)).toBe(deckKey(42));
    expect(deckKey(42)).not.toBe(deckKey(43));
  });

  it("シャッフル後も重複なしの 52 枚で、新品の Deck と同じ集合", () => {
    const shuffled = createShuffledDeck(2024);
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled.map(cardToString))).toEqual(
      new Set(createDeck().map(cardToString)),
    );
  });

  it("seed 42 の Deck 先頭 5 枚を固定する（アルゴリズム変更の検知用の回帰ピン）", () => {
    // 手計算ではなく現行実装の出力を固定したもの。mulberry32 / Fisher-Yates を意図して変えたときだけ更新する。
    expect(createShuffledDeck(42).slice(0, 5).map(cardToString))
      .toMatchInlineSnapshot(`
      [
        "4s",
        "Ts",
        "3d",
        "Ad",
        "As",
      ]
    `);
  });

  it("shuffle は元の配列を変更しない", () => {
    const original = [1, 2, 3, 4, 5];
    const copy = [...original];
    shuffle(original, createRng(5));
    expect(original).toEqual(copy);
  });

  it("負数・巨大な seed も受け付け、決定論的に動く", () => {
    expect(deckKey(-1)).toBe(deckKey(-1));
    expect(deckKey(2 ** 40)).toBe(deckKey(2 ** 40));
  });

  it("Property: 任意の seed で、決定論的な 52 枚の置換になる", () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 31), max: 2 ** 32 }), (seed) => {
        const a = createShuffledDeck(seed).map(cardToString);
        const b = shuffleDeck(createRng(seed)).map(cardToString);
        expect(a).toEqual(b);
        expect(new Set(a).size).toBe(52);
      }),
      propertyParams(),
    );
  });
});
