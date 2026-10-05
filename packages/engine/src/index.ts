// Poker Engine の公開入口。このパッケージは I/O・DB・LLM を import しない（CLAUDE.md 不変条件 1・2、D68）。
export const ENGINE_PACKAGE_NAME = "@proj-poker/engine";

export {
  DECK_SIZE,
  RANKS,
  SUITS,
  cardToString,
  cardsEqual,
  createDeck,
  parseCard,
  parseCards,
} from "./card.js";
export type { Card, Rank, Suit } from "./card.js";

export {
  createRng,
  createShuffledDeck,
  randomInt,
  shuffle,
  shuffleDeck,
} from "./rng.js";
export type { Rng } from "./rng.js";

export { HandCategory, compareHands, evaluateHand } from "./hand-evaluator.js";
export type { HandValue } from "./hand-evaluator.js";
