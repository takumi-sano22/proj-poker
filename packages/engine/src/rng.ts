// seed を注入できる RNG とシャッフル。
// Engine は Math.random / Date を使わない（同じ seed なら同じ Deck を再現するため。docs/02 §10 の best-effort 再現）。
import { createDeck, type Card } from "./card.js";

/** [0, 1) の一様乱数を返す関数。呼ぶたびに内部状態が進む。 */
export type Rng = () => number;

/**
 * mulberry32。32bit 状態の小さな PRNG で、依存なしに書ける。
 * 暗号用途ではない（ゲームの再現性が目的）。状態が 32bit なので、seed 空間は 2^32 に限られる。
 */
export function createRng(seed: number): Rng {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`seed は整数で指定する: ${seed}`);
  }
  // 負数や 2^32 超の seed も、下位 32bit に畳んで受け付ける。
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [0, maxExclusive) の整数を返す。 */
export function randomInt(rng: Rng, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(`maxExclusive は正の整数: ${maxExclusive}`);
  }
  // 剰余バイアスは 2^32 に対して十分小さい（最大 52 要素）ため、棄却サンプリングは省く。
  return Math.floor(rng() * maxExclusive);
}

/** Fisher-Yates。元の配列は変更せず、新しい配列を返す。 */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    // noUncheckedIndexedAccess 下でも添字は範囲内（0 <= j <= i < length）。
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/** 新品の Deck を RNG でシャッフルして返す。 */
export function shuffleDeck(rng: Rng): Card[] {
  return shuffle(createDeck(), rng);
}

/** seed から Deck を作る。同じ seed なら必ず同じ順序になる。 */
export function createShuffledDeck(seed: number): Card[] {
  return shuffleDeck(createRng(seed));
}
