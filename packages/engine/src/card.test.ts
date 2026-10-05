import { describe, expect, it } from "vitest";
import {
  DECK_SIZE,
  cardToString,
  cardsEqual,
  createDeck,
  parseCard,
  parseCards,
} from "./card.js";

describe("Card / Deck", () => {
  it("新品の Deck は重複なしの 52 枚（INV-TEST-001 の最小形）", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(DECK_SIZE);
    expect(DECK_SIZE).toBe(52);
    expect(new Set(deck.map(cardToString)).size).toBe(52);
  });

  it("Suit ごとに 13 枚、Rank ごとに 4 枚ある", () => {
    const deck = createDeck();
    for (const suit of ["c", "d", "h", "s"]) {
      expect(deck.filter((c) => c.suit === suit)).toHaveLength(13);
    }
    for (let rank = 2; rank <= 14; rank++) {
      expect(deck.filter((c) => c.rank === rank)).toHaveLength(4);
    }
  });

  it("文字列表記と Card が往復できる（全 52 枚）", () => {
    for (const card of createDeck()) {
      expect(parseCard(cardToString(card))).toEqual(card);
    }
  });

  it("代表的な表記を正しく解釈する", () => {
    expect(parseCard("As")).toEqual({ rank: 14, suit: "s" });
    expect(parseCard("Td")).toEqual({ rank: 10, suit: "d" });
    expect(parseCard("2c")).toEqual({ rank: 2, suit: "c" });
    expect(parseCards(" Kh  Qh ")).toEqual([
      { rank: 13, suit: "h" },
      { rank: 12, suit: "h" },
    ]);
    expect(parseCards("")).toEqual([]);
  });

  it("不正な表記は例外にする", () => {
    for (const bad of ["", "A", "Asd", "1s", "Ax", "as", "10s"]) {
      expect(() => parseCard(bad)).toThrow(RangeError);
    }
  });

  it("cardsEqual は Rank と Suit が同じときだけ true", () => {
    expect(cardsEqual(parseCard("As"), parseCard("As"))).toBe(true);
    expect(cardsEqual(parseCard("As"), parseCard("Ad"))).toBe(false);
    expect(cardsEqual(parseCard("As"), parseCard("Ks"))).toBe(false);
  });
});
