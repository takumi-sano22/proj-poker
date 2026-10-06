// Range（相手が持ちうる 2 枚の組の集合）の表記と展開。
// 表記は一般的な略記（docs/research/02 §9 Range Thinking）で、カンマ区切りの要素を並べる:
//   "TT"（Pocket Pair）・"TT+"（TT〜AA）・"99-66"（66〜99）・"AKs"（Suited）・"AKo"（Offsuit）・"AK"（両方）・
//   "ATs+"（ATs〜AKs。Kicker を 1 つ下まで上げる）・"A5s-A2s"（A2s〜A5s）・"random"（全 1326 通り）。
// 不正な表記は例外にする（黙って読み替えない）。
import { RANKS, SUITS, type Card, type Rank } from "./card.js";

/** 相手の 2 枚の組（Combo）。 */
export type Combo = readonly [Card, Card];

// 表記の Rank 文字。添字が Rank − 2 に対応する（card.ts と同じ）。
const RANK_CHARS = "23456789TJQKA";

/** Range の表記を Combo の列にする。重複は 1 つにまとめ、順序は表記の順（同じ表記なら同じ順）。 */
export function parseRange(notation: string): Combo[] {
  const tokens = notation
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (tokens.length === 0) {
    throw new RangeError(`Range の表記が空: "${notation}"`);
  }
  const seen = new Set<string>();
  const combos: Combo[] = [];
  for (const token of tokens) {
    for (const combo of expandToken(token)) {
      const key = comboKey(combo);
      if (seen.has(key)) continue;
      seen.add(key);
      combos.push(combo);
    }
  }
  return combos;
}

/** Combo の向きによらない同一性のキー。 */
export function comboKey(combo: Combo): string {
  const [a, b] = combo.map(cardKey).sort() as [string, string];
  return `${a}${b}`;
}

function cardKey(card: Card): string {
  return `${RANK_CHARS.charAt(card.rank - 2)}${card.suit}`;
}

function expandToken(token: string): Combo[] {
  if (token === "random") return allCombos();
  const dash = token.split("-");
  if (dash.length === 2) {
    return expandDash(token, dash[0] as string, dash[1] as string);
  }
  const plus = token.endsWith("+");
  const hand = parseHandClass(plus ? token.slice(0, -1) : token, token);
  if (!plus) return classCombos(hand);
  if (hand.high === hand.low) {
    // "TT+": TT から AA まで。
    return RANKS.filter((r) => r >= hand.high).flatMap((r) =>
      classCombos({ high: r, low: r, kind: "pair" }),
    );
  }
  // "ATs+": Kicker を High の 1 つ下まで上げる。
  return RANKS.filter((r) => r >= hand.low && r < hand.high).flatMap((r) =>
    classCombos({ ...hand, low: r }),
  );
}

function expandDash(token: string, left: string, right: string): Combo[] {
  const a = parseHandClass(left, token);
  const b = parseHandClass(right, token);
  if (a.kind === "pair" && b.kind === "pair") {
    const lo = Math.min(a.high, b.high);
    const hi = Math.max(a.high, b.high);
    return RANKS.filter((r) => r >= lo && r <= hi).flatMap((r) =>
      classCombos({ high: r, low: r, kind: "pair" }),
    );
  }
  if (a.kind === b.kind && a.high === b.high) {
    const lo = Math.min(a.low, b.low);
    const hi = Math.max(a.low, b.low);
    return RANKS.filter((r) => r >= lo && r <= hi).flatMap((r) =>
      classCombos({ ...a, low: r }),
    );
  }
  throw new RangeError(`範囲の両端が揃っていない: "${token}"`);
}

/** 手の種類（"AKs" など）。pair は high = low、any は Suited と Offsuit の両方。 */
interface HandClass {
  readonly high: Rank;
  readonly low: Rank;
  readonly kind: "pair" | "suited" | "offsuit" | "any";
}

function parseHandClass(text: string, token: string): HandClass {
  const high = rankOf(text.charAt(0), token);
  const low = rankOf(text.charAt(1), token);
  const suffix = text.slice(2);
  if (high === low) {
    if (suffix !== "") throw new RangeError(`不正な Range 表記: "${token}"`);
    return { high, low, kind: "pair" };
  }
  if (high < low) {
    // "KA" のような逆順は読み替えない（表記の揺れを黙って通さない）。
    throw new RangeError(`高い Rank を先に書く: "${token}"`);
  }
  if (suffix === "s") return { high, low, kind: "suited" };
  if (suffix === "o") return { high, low, kind: "offsuit" };
  if (suffix === "") return { high, low, kind: "any" };
  throw new RangeError(`不正な Range 表記: "${token}"`);
}

function rankOf(char: string, token: string): Rank {
  const index = RANK_CHARS.indexOf(char);
  if (char === "" || index < 0) {
    throw new RangeError(`不正な Range 表記: "${token}"`);
  }
  return RANKS[index] as Rank;
}

/** 手の種類の全 Combo（Pair 6・Suited 4・Offsuit 12）。 */
function classCombos(hand: HandClass): Combo[] {
  const combos: Combo[] = [];
  for (let i = 0; i < SUITS.length; i++) {
    for (let j = 0; j < SUITS.length; j++) {
      const s1 = SUITS[i] as Card["suit"];
      const s2 = SUITS[j] as Card["suit"];
      if (hand.kind === "pair") {
        if (j <= i) continue;
      } else if (hand.kind === "suited") {
        if (i !== j) continue;
      } else if (hand.kind === "offsuit") {
        if (i === j) continue;
      }
      combos.push([
        { rank: hand.high, suit: s1 },
        { rank: hand.low, suit: s2 },
      ]);
    }
  }
  return combos;
}

/** 52 枚から 2 枚を選ぶ全 1326 通り。 */
function allCombos(): Combo[] {
  const cards = RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
  const combos: Combo[] = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      combos.push([cards[j] as Card, cards[i] as Card]);
    }
  }
  return combos;
}
