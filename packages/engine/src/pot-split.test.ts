import { describe, expect, it } from "vitest";
import { splitPot } from "./pot-split.js";

const RULE = "first_left_of_button";

describe("splitPot", () => {
  it("割り切れるなら均等に分ける", () => {
    expect(splitPot(6, ["a", "b", "c"], RULE)).toEqual([
      { playerId: "a", amount: 2 },
      { playerId: "b", amount: 2 },
      { playerId: "c", amount: 2 },
    ]);
  });

  it("勝者 1 人なら Pot 全額", () => {
    expect(splitPot(7, ["a"], RULE)).toEqual([{ playerId: "a", amount: 7 }]);
  });

  it("端数は Button の左に近い勝者（配列の先頭）から 1 Chip ずつ配る", () => {
    // 5 / 2 = 2 余り 1 → 先頭の a が 3
    expect(splitPot(5, ["a", "b"], RULE)).toEqual([
      { playerId: "a", amount: 3 },
      { playerId: "b", amount: 2 },
    ]);
    // 14 / 3 = 4 余り 2 → 先頭 2 人が 5
    expect(splitPot(14, ["a", "b", "c"], RULE)).toEqual([
      { playerId: "a", amount: 5 },
      { playerId: "b", amount: 5 },
      { playerId: "c", amount: 4 },
    ]);
    // 5 / 5 の境界: 余り 4（勝者数 − 1）なら最後の 1 人だけ 1 Chip 少ない
    expect(splitPot(9, ["a", "b", "c", "d", "e"], RULE)).toEqual([
      { playerId: "a", amount: 2 },
      { playerId: "b", amount: 2 },
      { playerId: "c", amount: 2 },
      { playerId: "d", amount: 2 },
      { playerId: "e", amount: 1 },
    ]);
  });

  it("Pot が勝者数より小さくても配り切る", () => {
    expect(splitPot(1, ["a", "b", "c"], RULE)).toEqual([
      { playerId: "a", amount: 1 },
      { playerId: "b", amount: 0 },
      { playerId: "c", amount: 0 },
    ]);
  });

  it("不正な入力は例外にする（黙って Chip を失わない）", () => {
    expect(() => splitPot(5, [], RULE)).toThrow(RangeError);
    expect(() => splitPot(2.5, ["a"], RULE)).toThrow(RangeError);
    expect(() => splitPot(-1, ["a"], RULE)).toThrow(RangeError);
  });
});
