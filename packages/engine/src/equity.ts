// Equity（Showdown までの勝率の期待値。引き分けは等分）を決定論で計算する（docs/research/02 §4。Math は LLM に計算させない）。
// - 相手が 1 人で、評価の回数（Combo 数 × 残りの Board の出方）が上限以内なら全列挙（exact）。Flop・Turn・River はこれに入る。
// - それ以外（Preflop・Multiway）は seed 固定の Monte Carlo。同じ入力・同じ seed・同じ試行回数なら必ず同じ結果になる。
// 乱数は rng.ts の seed 付き RNG だけを使い、Math.random・時刻には依存しない。
import type { Card } from "./card.js";
import { cardCode, handScore, type CardCode } from "./hand-strength.js";
import type { Combo } from "./range.js";
import { createRng, randomInt } from "./rng.js";

export interface EquityOptions {
  /** Monte Carlo の seed。 */
  readonly seed: number;
  /** Monte Carlo の試行回数。 */
  readonly samples: number;
  /** 全列挙する評価の回数（相手の Combo 数 × Board の出方）の上限。超えたら Monte Carlo にする。 */
  readonly maxExactEvaluations: number;
}

/**
 * 既定値。性能の上限（Flop の手札 vs Range を 500ms 以内）を守る値にしてある（equity.test.ts で測る）。
 * - maxExactEvaluations: Flop の残り 2 枚の出方は最大 1081 通りで、相手が 1 人なら全 1326 Combo（Board と札を除くと 1081）
 *   でも約 117 万回で収まる。Preflop（残り 5 枚・約 171 万通り × Combo）は超えるので Monte Carlo になる。
 * - samples: 2 万回で標準誤差は約 0.35%（√(0.25 / 20000)）。
 */
export const DEFAULT_EQUITY_OPTIONS: EquityOptions = {
  seed: 1,
  samples: 20_000,
  maxExactEvaluations: 1_200_000,
};

export interface EquityResult {
  /** Hero の Equity（0〜1。引き分けは人数で等分）。 */
  readonly equity: number;
  /** Hero が単独で勝つ割合。 */
  readonly win: number;
  /** Hero が引き分ける（他の誰かと同じ最強の役）割合。 */
  readonly tie: number;
  readonly method: "exact" | "monte_carlo";
  /** 数えた組（exact は相手の Combo と Board の出方の組、Monte Carlo は有効だった試行）の数。 */
  readonly trials: number;
  /** Monte Carlo の seed（exact は null）。 */
  readonly seed: number | null;
}

/**
 * Hero の 2 枚と Board（0・3・4・5 枚）で、相手ごとの Range に対する Equity を計算する。
 * Range の Combo のうち、Hero の札・Board と重なるものは除く。相手が複数なら、相手同士の札も重ならないように選ぶ。
 */
export function equityVsRanges(
  hero: readonly Card[],
  board: readonly Card[],
  ranges: readonly (readonly Combo[])[],
  options: EquityOptions = DEFAULT_EQUITY_OPTIONS,
): EquityResult {
  if (hero.length !== 2) {
    throw new RangeError(`Hero の札は 2 枚: ${hero.length} 枚`);
  }
  if (![0, 3, 4, 5].includes(board.length)) {
    throw new RangeError(`Board は 0・3・4・5 枚: ${board.length} 枚`);
  }
  if (ranges.length === 0) {
    throw new RangeError("相手の Range が 1 つも無い");
  }
  const known = [...hero, ...board].map(cardCode);
  if (new Set(known).size !== known.length) {
    throw new RangeError("Hero の札と Board に同じ Card がある");
  }
  const dead = new Set(known);
  const live = ranges.map((range) =>
    range
      .map(([a, b]) => [cardCode(a), cardCode(b)] as const)
      .filter(([a, b]) => !dead.has(a) && !dead.has(b)),
  );
  if (live.some((r) => r.length === 0)) {
    throw new RangeError("Hero の札・Board を除くと空になる Range がある");
  }

  const deck: CardCode[] = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) deck.push(c);
  const missing = 5 - board.length;
  const boardCodes = board.map(cardCode);
  const heroCodes = hero.map(cardCode);

  if (live.length === 1) {
    const runouts = countCombinations(deck.length, missing);
    if (
      (live[0] as RangeCodes).length * runouts <=
      options.maxExactEvaluations
    ) {
      return exactHeadsUp(
        heroCodes,
        boardCodes,
        live[0] as RangeCodes,
        deck,
        missing,
      );
    }
  }
  return monteCarlo(heroCodes, boardCodes, live, deck, missing, options);
}

type RangeCodes = readonly (readonly [CardCode, CardCode])[];

/** 相手 1 人の全列挙。Board の出方ごとに Hero の役を 1 回だけ評価し、相手の Combo と重なる出方は数えない。 */
function exactHeadsUp(
  hero: readonly CardCode[],
  board: readonly CardCode[],
  range: RangeCodes,
  deck: readonly CardCode[],
  missing: number,
): EquityResult {
  const runouts = combinations(deck, missing);
  const heroScores = runouts.map((r) => handScore([...hero, ...board, ...r]));
  const villainCards: CardCode[] = [
    0,
    0,
    ...board,
    ...new Array<number>(missing).fill(0),
  ];
  const offset = 2 + board.length;
  let wins = 0;
  let ties = 0;
  let trials = 0;
  for (const [a, b] of range) {
    villainCards[0] = a;
    villainCards[1] = b;
    for (let i = 0; i < runouts.length; i++) {
      const runout = runouts[i] as readonly CardCode[];
      if (runout.includes(a) || runout.includes(b)) continue;
      for (let k = 0; k < missing; k++)
        villainCards[offset + k] = runout[k] as number;
      const diff = (heroScores[i] as number) - handScore(villainCards);
      if (diff > 0) wins++;
      else if (diff === 0) ties++;
      trials++;
    }
  }
  return {
    equity: (wins + ties / 2) / trials,
    win: wins / trials,
    tie: ties / trials,
    method: "exact",
    trials,
    seed: null,
  };
}

// 相手の Combo を選び直す回数の上限（他の相手・Board と重なったとき）。届かない試行は数えない。
const MAX_REDRAWS = 100;

/** seed 固定の Monte Carlo。相手の Combo を Range から一様に選び、残りの Board を残りの Card から一様に配る。 */
function monteCarlo(
  hero: readonly CardCode[],
  board: readonly CardCode[],
  ranges: readonly RangeCodes[],
  deck: readonly CardCode[],
  missing: number,
  options: EquityOptions,
): EquityResult {
  const rng = createRng(options.seed);
  const used = new Uint8Array(52);
  const fullBoard: CardCode[] = [
    ...board,
    ...new Array<number>(missing).fill(0),
  ];
  const villains: CardCode[][] = ranges.map(() => [0, 0]);
  const cards: CardCode[] = new Array<number>(7).fill(0);
  let equity = 0;
  let wins = 0;
  let ties = 0;
  let trials = 0;
  for (let s = 0; s < options.samples; s++) {
    used.fill(0);
    let ok = true;
    for (let v = 0; v < ranges.length && ok; v++) {
      const range = ranges[v] as RangeCodes;
      ok = false;
      for (let t = 0; t < MAX_REDRAWS; t++) {
        const [a, b] = range[randomInt(rng, range.length)] as readonly [
          CardCode,
          CardCode,
        ];
        if (used[a] || used[b]) continue;
        used[a] = 1;
        used[b] = 1;
        (villains[v] as CardCode[])[0] = a;
        (villains[v] as CardCode[])[1] = b;
        ok = true;
        break;
      }
    }
    if (!ok) continue;
    for (let k = 0; k < missing; k++) {
      let c: CardCode;
      do {
        c = deck[randomInt(rng, deck.length)] as CardCode;
      } while (used[c]);
      used[c] = 1;
      fullBoard[board.length + k] = c;
    }
    for (let k = 0; k < 5; k++) cards[2 + k] = fullBoard[k] as number;
    cards[0] = hero[0] as number;
    cards[1] = hero[1] as number;
    const heroScore = handScore(cards);
    let best = 0;
    let tiedWithHero = 0;
    for (const [a, b] of villains as [CardCode, CardCode][]) {
      cards[0] = a;
      cards[1] = b;
      const score = handScore(cards);
      if (score > best) best = score;
      if (score === heroScore) tiedWithHero++;
    }
    trials++;
    if (heroScore > best) {
      wins++;
      equity += 1;
    } else if (heroScore === best) {
      ties++;
      equity += 1 / (tiedWithHero + 1);
    }
  }
  if (trials === 0) {
    throw new RangeError("相手の Range が互いに重なり、有効な試行が無い");
  }
  return {
    equity: equity / trials,
    win: wins / trials,
    tie: ties / trials,
    method: "monte_carlo",
    trials,
    seed: options.seed,
  };
}

/** n から k を選ぶ組の数。 */
function countCombinations(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

/** items から k 個を選ぶ全ての組（元の順序を保つ）。 */
function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  const result: T[][] = [];
  const pick = (start: number, chosen: T[]): void => {
    if (chosen.length === k) {
      result.push([...chosen]);
      return;
    }
    for (let i = start; i <= items.length - (k - chosen.length); i++) {
      chosen.push(items[i] as T);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return result;
}
