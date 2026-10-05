import { describe, expect, it } from "vitest";
import { cardToString, createDeck, parseCards } from "./card.js";
import { HandCategory, compareHands, evaluateHand } from "./hand-evaluator.js";

const evalText = (text: string) => evaluateHand(parseCards(text));

// 期待値はすべて手で決めたもの（Engine の出力のコピーではない）。
describe("Hand Evaluator: カテゴリごとの固定ケース（5 枚）", () => {
  const cases: {
    name: string;
    cards: string;
    category: HandCategory;
    tiebreakers: number[];
  }[] = [
    {
      name: "High Card",
      cards: "Ah Kd 9s 5c 3d",
      category: HandCategory.HighCard,
      tiebreakers: [14, 13, 9, 5, 3],
    },
    {
      name: "Pair",
      cards: "9h 9d As 5c 3d",
      category: HandCategory.Pair,
      tiebreakers: [9, 14, 5, 3, 0],
    },
    {
      name: "Two Pair",
      cards: "Kh Kd 9s 9c 3d",
      category: HandCategory.TwoPair,
      tiebreakers: [13, 9, 3, 0, 0],
    },
    {
      name: "Three of a Kind",
      cards: "7h 7d 7s Kc 3d",
      category: HandCategory.ThreeOfAKind,
      tiebreakers: [7, 13, 3, 0, 0],
    },
    {
      name: "Straight",
      cards: "5h 6d 7s 8c 9d",
      category: HandCategory.Straight,
      tiebreakers: [9, 0, 0, 0, 0],
    },
    {
      name: "Straight（Broadway）",
      cards: "Th Jd Qs Kc Ad",
      category: HandCategory.Straight,
      tiebreakers: [14, 0, 0, 0, 0],
    },
    {
      name: "Straight（Wheel は 5-high）",
      cards: "Ah 2d 3s 4c 5d",
      category: HandCategory.Straight,
      tiebreakers: [5, 0, 0, 0, 0],
    },
    {
      name: "Flush",
      cards: "Ah Jh 9h 5h 3h",
      category: HandCategory.Flush,
      tiebreakers: [14, 11, 9, 5, 3],
    },
    {
      name: "Full House",
      cards: "Qh Qd Qs 4c 4d",
      category: HandCategory.FullHouse,
      tiebreakers: [12, 4, 0, 0, 0],
    },
    {
      name: "Four of a Kind",
      cards: "9h 9d 9s 9c Kd",
      category: HandCategory.FourOfAKind,
      tiebreakers: [9, 13, 0, 0, 0],
    },
    {
      name: "Straight Flush",
      cards: "5h 6h 7h 8h 9h",
      category: HandCategory.StraightFlush,
      tiebreakers: [9, 0, 0, 0, 0],
    },
    {
      name: "Straight Flush（Steel Wheel）",
      cards: "Ah 2h 3h 4h 5h",
      category: HandCategory.StraightFlush,
      tiebreakers: [5, 0, 0, 0, 0],
    },
    {
      name: "Straight Flush（Royal）",
      cards: "Th Jh Qh Kh Ah",
      category: HandCategory.StraightFlush,
      tiebreakers: [14, 0, 0, 0, 0],
    },
    {
      // K-A-2-3-4 は Straight ではない（Ace は端でしか 1 にならない）。
      name: "Wrap-around は Straight にならない",
      cards: "Qh Kd Ah 2c 3d",
      category: HandCategory.HighCard,
      tiebreakers: [14, 13, 12, 3, 2],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const value = evalText(c.cards);
      expect(value.category).toBe(c.category);
      expect(value.tiebreakers).toEqual(c.tiebreakers);
      expect(value.bestFive).toHaveLength(5);
    });
  }

  it("Wheel の bestFive は 5-4-3-2-A の順に並ぶ", () => {
    expect(evalText("Ah 2d 3s 4c 5d").bestFive.map(cardToString)).toEqual([
      "5d",
      "4c",
      "3s",
      "2d",
      "Ah",
    ]);
  });

  it("Full House の bestFive は Trips → Pair の順に並ぶ", () => {
    expect(evalText("4c Qh 4d Qd Qs").bestFive.map(cardToString)).toEqual([
      "Qh",
      "Qd",
      "Qs",
      "4c",
      "4d",
    ]);
  });
});

describe("Hand Evaluator: 強さの順序（弱い順に並べ、隣同士が厳密に増加する）", () => {
  const ascending: { note: string; cards: string }[] = [
    { note: "High Card 7-high", cards: "7h 5d 4s 3c 2d" },
    {
      note: "High Card 7-high、Kicker が上 (7-6-4-3-2)",
      cards: "7h 6d 4s 3c 2d",
    },
    { note: "High Card Ace-high", cards: "Ah 9d 4s 3c 2d" },
    { note: "Pair of 2 (A-K-Q Kicker)", cards: "2h 2d As Kc Qd" },
    { note: "Pair of 3（低い Kicker）", cards: "3h 3d 4s 5c 7d" },
    { note: "Pair of 3（Kicker が 1 つ上）", cards: "3h 3d 4s 6c 7d" },
    { note: "Pair of Aces", cards: "Ah Ad 4s 3c 2d" },
    { note: "Two Pair 3 と 2", cards: "3h 3d 2s 2c 4d" },
    { note: "Two Pair 3 と 2（Kicker が上）", cards: "3h 3d 2s 2c 5d" },
    { note: "Two Pair 4 と 2（高い方のペアが優先）", cards: "4h 4d 2s 2c 3d" },
    { note: "Two Pair A と K", cards: "Ah Ad Ks Kc 2d" },
    { note: "Trips of 2", cards: "2h 2d 2s Kc Qd" },
    { note: "Trips of 3", cards: "3h 3d 3s 4c 5d" },
    { note: "Wheel (5-high Straight)", cards: "Ah 2d 3s 4c 5d" },
    { note: "6-high Straight（Wheel より強い）", cards: "2h 3d 4s 5c 6d" },
    { note: "Broadway", cards: "Th Jd Qs Kc Ad" },
    { note: "Flush 7-high 側 (7-5-4-3-2)", cards: "7h 5h 4h 3h 2h" },
    { note: "Flush (7-6-4-3-2)", cards: "7h 6h 4h 3h 2h" },
    { note: "Flush Ace-high", cards: "Ah 9h 4h 3h 2h" },
    { note: "Full House 2 over A", cards: "2h 2d 2s Ac Ad" },
    {
      note: "Full House 3 over 2（Trips の Rank が優先）",
      cards: "3h 3d 3s 2c 2d",
    },
    { note: "Quads of 2", cards: "2h 2d 2s 2c 3d" },
    { note: "Quads of 2（Kicker が上）", cards: "2h 2d 2s 2c Ad" },
    { note: "Quads of 3", cards: "3h 3d 3s 3c 2d" },
    { note: "Steel Wheel", cards: "Ah 2h 3h 4h 5h" },
    { note: "6-high Straight Flush", cards: "2s 3s 4s 5s 6s" },
    { note: "Royal Flush", cards: "Th Jh Qh Kh Ah" },
  ];

  it("全ペアで、弱い方が弱いと判定される（推移律込み）", () => {
    const values = ascending.map((a) => evalText(a.cards));
    for (let i = 0; i < values.length; i++) {
      for (let j = 0; j < values.length; j++) {
        const expected = Math.sign(i - j);
        expect(
          compareHands(values[i]!, values[j]!),
          `${ascending[i]!.note} vs ${ascending[j]!.note}`,
        ).toBe(expected);
      }
    }
  });
});

describe("Hand Evaluator: 同価値（Split）", () => {
  it("Suit だけが違う同じ Rank 構成は 0", () => {
    expect(
      compareHands(evalText("Ah Kd 9s 5c 3d"), evalText("Ad Kc 9h 5s 3c")),
    ).toBe(0);
  });

  it("Board がそのまま最強の 5 枚なら、Hole Cards が違っても 0", () => {
    const board = "Th Jd Qs Kc Ad";
    expect(
      compareHands(evalText(`${board} 2c 3c`), evalText(`${board} 4d 5d`)),
    ).toBe(0);
  });

  it("同じ Flush でも Suit の違いでは差が出ない", () => {
    expect(
      compareHands(evalText("Ah Jh 9h 5h 3h"), evalText("As Js 9s 5s 3s")),
    ).toBe(0);
  });
});

describe("Hand Evaluator: 6〜7 枚から最強の 5 枚を選ぶ", () => {
  it("Three Pair の 7 枚は上位 2 ペア + 残りで最高の Kicker（2 のペアの片割れではなく 9）", () => {
    const value = evalText("Ah Ad Kc Ks 2d 2c 9h");
    expect(value.category).toBe(HandCategory.TwoPair);
    expect(value.tiebreakers).toEqual([14, 13, 9, 0, 0]);
  });

  it("Trips が 2 組ある 7 枚は Full House（高い方が Trips）", () => {
    const value = evalText("Qh Qd Qs 4c 4d 4h 2s");
    expect(value.category).toBe(HandCategory.FullHouse);
    expect(value.tiebreakers).toEqual([12, 4, 0, 0, 0]);
  });

  it("Trips + Pair 2 組の 7 枚は高い方のペアを使う Full House", () => {
    const value = evalText("9h 9d 9s 5c 5d 2h 2s");
    expect(value.category).toBe(HandCategory.FullHouse);
    expect(value.tiebreakers).toEqual([9, 5, 0, 0, 0]);
  });

  it("Quads + Trips の 7 枚は Quads（Kicker は残りの最高位）", () => {
    const value = evalText("9h 9d 9s 9c 5d 5h 5s");
    expect(value.category).toBe(HandCategory.FourOfAKind);
    expect(value.tiebreakers).toEqual([9, 5, 0, 0, 0]);
  });

  it("同じ Suit が 6 枚なら上位 5 枚の Flush", () => {
    const value = evalText("Ah Kh 9h 7h 4h 2h 3c");
    expect(value.category).toBe(HandCategory.Flush);
    expect(value.tiebreakers).toEqual([14, 13, 9, 7, 4]);
  });

  it("Straight と Flush が別々に成立していて Straight Flush でないなら Flush", () => {
    // ハート: 5,6,7,8,K,2 → Flush。5-9 の Straight は 9c を使うので Suit が揃わない。
    const value = evalText("5h 6h 7h 8h 9c Kh 2h");
    expect(value.category).toBe(HandCategory.Flush);
    expect(value.tiebreakers).toEqual([13, 8, 7, 6, 5]);
  });

  it("Straight が 6 連続なら最高位を取る", () => {
    const value = evalText("2c 3d 4h 5s 6c 7d 9h");
    expect(value.category).toBe(HandCategory.Straight);
    expect(value.tiebreakers).toEqual([7, 0, 0, 0, 0]);
  });

  it("Wheel + 6 がある 7 枚は 6-high Straight（Wheel より強い方を選ぶ）", () => {
    const value = evalText("Ah 2d 3s 4c 5d 6h 9c");
    expect(value.category).toBe(HandCategory.Straight);
    expect(value.tiebreakers[0]).toBe(6);
  });

  it("Flush の 7 枚に Straight Flush が含まれるなら Straight Flush", () => {
    const value = evalText("5h 6h 7h 8h 9h Kh 2c");
    expect(value.category).toBe(HandCategory.StraightFlush);
    expect(value.tiebreakers[0]).toBe(9);
  });

  it("6 枚でも評価できる", () => {
    const value = evalText("Ah Ad Ac Kh Kd 2c");
    expect(value.category).toBe(HandCategory.FullHouse);
    expect(value.tiebreakers).toEqual([14, 13, 0, 0, 0]);
  });

  it("Hole Cards の Kicker 差で勝敗が決まる（同じ Board）", () => {
    const board = "Ah 7d 4s 2c 9h";
    const aceKing = evalText(`${board} Ad Kc`); // Pair of A、Kicker K-9-7
    const aceQueen = evalText(`${board} As Qc`); // Pair of A、Kicker Q-9-7
    expect(compareHands(aceKing, aceQueen)).toBe(1);
    expect(compareHands(aceQueen, aceKing)).toBe(-1);
  });

  it("カードの並び順に依存しない", () => {
    const forward = evalText("Ah Ad Kc Ks 2d 2c 9h");
    const reversed = evalText("9h 2c 2d Ks Kc Ad Ah");
    expect(reversed.score).toBe(forward.score);
  });
});

describe("Hand Evaluator: 入力の検証", () => {
  it("5 枚未満・8 枚以上は例外", () => {
    expect(() => evalText("Ah Kd 9s 5c")).toThrow(RangeError);
    expect(() => evalText("")).toThrow(RangeError);
    expect(() => evalText("Ah Kd 9s 5c 3d 2d 7h 8h")).toThrow(RangeError);
  });

  it("重複カードは例外", () => {
    expect(() => evalText("Ah Ah 9s 5c 3d")).toThrow(RangeError);
  });
});

describe("Hand Evaluator: 5 枚の全組み合わせでカテゴリ別の出現数が既知の値と一致する", () => {
  // 52 枚から 5 枚を選ぶ 2,598,960 通りの内訳は組合せ論の既知の値（独立した正解）。
  // Royal Flush は Straight Flush（40 通り = 4 Suit × 10 種）に含まれる。
  const expectedCounts: Record<HandCategory, number> = {
    [HandCategory.HighCard]: 1_302_540,
    [HandCategory.Pair]: 1_098_240,
    [HandCategory.TwoPair]: 123_552,
    [HandCategory.ThreeOfAKind]: 54_912,
    [HandCategory.Straight]: 10_200,
    [HandCategory.Flush]: 5_108,
    [HandCategory.FullHouse]: 3_744,
    [HandCategory.FourOfAKind]: 624,
    [HandCategory.StraightFlush]: 40,
  };

  it("2,598,960 通りを全部評価する", { timeout: 120_000 }, () => {
    const deck = createDeck();
    const counts = new Array<number>(9).fill(0);
    const n = deck.length;
    for (let a = 0; a < n - 4; a++)
      for (let b = a + 1; b < n - 3; b++)
        for (let c = b + 1; c < n - 2; c++)
          for (let d = c + 1; d < n - 1; d++)
            for (let e = d + 1; e < n; e++) {
              const category = evaluateHand([
                deck[a]!,
                deck[b]!,
                deck[c]!,
                deck[d]!,
                deck[e]!,
              ]).category;
              counts[category] = (counts[category] ?? 0) + 1;
            }
    expect(counts.reduce((x, y) => x + y, 0)).toBe(2_598_960);
    for (const [category, expected] of Object.entries(expectedCounts)) {
      expect(counts[Number(category)], `category ${category}`).toBe(expected);
    }
  });
});
