// 表示用の整形と用語。金額は常に実額を正本にし、BB 換算は補助として添える（D49・docs/06 §2）。
// 用語は「日本語 + 標準 Poker Term」で出す（docs/06 §7）。
import type { ActionType, Card, Rank, Street, Suit } from "@proj-poker/engine";

const chipFormat = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 0,
});
const bbFormat = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 1,
});

/** Chip の実額（最小単位の整数。D74）を表示用の文字列にする。 */
export function formatChips(amount: number): string {
  return chipFormat.format(amount);
}

/** BB 換算（補助表示）。小数第 1 位まで。 */
export function formatBB(amount: number, bigBlind: number): string {
  if (bigBlind <= 0) return "";
  return `${bbFormat.format(amount / bigBlind)} BB`;
}

/** 用語の表記。ja は日本語の説明、term は標準 Poker Term。 */
export interface Term {
  readonly ja: string;
  readonly term: string;
}

export function termLabel(t: Term): string {
  return `${t.ja}（${t.term}）`;
}

export const ACTION_TERMS: Readonly<Record<ActionType, Term>> = {
  fold: { ja: "フォールド", term: "Fold" },
  check: { ja: "チェック", term: "Check" },
  call: { ja: "コール", term: "Call" },
  bet: { ja: "ベット", term: "Bet" },
  raise: { ja: "レイズ", term: "Raise" },
  all_in: { ja: "オールイン", term: "All-in" },
};

export const STREET_TERMS: Readonly<Record<Street, Term>> = {
  preflop: { ja: "プリフロップ", term: "Preflop" },
  flop: { ja: "フロップ", term: "Flop" },
  turn: { ja: "ターン", term: "Turn" },
  river: { ja: "リバー", term: "River" },
};

export const TERMS = {
  pot: { ja: "ポット", term: "Pot" },
  button: { ja: "ボタン", term: "BTN" },
  smallBlind: { ja: "スモールブラインド", term: "SB" },
  bigBlind: { ja: "ビッグブラインド", term: "BB" },
  stack: { ja: "スタック", term: "Stack" },
  showdown: { ja: "ショーダウン", term: "Showdown" },
  uncalledBet: { ja: "戻ったベット", term: "Uncalled Bet" },
} as const satisfies Record<string, Term>;

const RANK_LABELS: Readonly<Record<Rank, string>> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

export const SUIT_SYMBOLS: Readonly<Record<Suit, string>> = {
  c: "♣",
  d: "♦",
  h: "♥",
  s: "♠",
};

const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  c: "クラブ",
  d: "ダイヤ",
  h: "ハート",
  s: "スペード",
};

export function rankLabel(rank: Rank): string {
  return RANK_LABELS[rank];
}

/** 卓のログ用の短い表記（例: "A♠"）。 */
export function cardShortLabel(card: Card): string {
  return `${RANK_LABELS[card.rank]}${SUIT_SYMBOLS[card.suit]}`;
}

/** 読み上げ用の表記（例: "スペードの A"）。 */
export function cardSpokenLabel(card: Card): string {
  return `${SUIT_NAMES[card.suit]}の ${RANK_LABELS[card.rank]}`;
}

/** Suit が赤（ハート・ダイヤ）か。色は CSS のトークンで決める。 */
export function isRedSuit(suit: Suit): boolean {
  return suit === "h" || suit === "d";
}
