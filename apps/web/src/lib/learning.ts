// Session Review / Learning の画面の文言（#116・docs/07 §2〜§6・docs/06 §14）。サーバーが計算した値を読める文にするだけで、
// 評価・集計はしない（Score・Stats・Hypothesis はサーバーが Event Log と Pass A の Review から計算する。D111）。
// 点数だけを見せず、Confidence・件数・Review 済みの数と一緒に出す（docs/07 §2・D115）。
import {
  STAT_DEFINITIONS,
  type StatId,
  type StatValue,
} from "@proj-poker/engine";
import { formatChipsWithBB, type Term } from "./format.js";
import type {
  AbilityDimension,
  HypothesisStatus,
  HypothesisType,
  ScoreConfidence,
  ScoreValue,
  TrendDirection,
} from "./learning-api.js";

/** Ability の表記（日本語 + docs/07 §2 の語）。 */
export const ABILITY_TERMS: Readonly<Record<AbilityDimension, Term>> = {
  preflop: { ja: "プリフロップ", term: "Preflop" },
  postflop: { ja: "ポストフロップ", term: "Postflop" },
  bet_sizing: { ja: "ベット額", term: "Bet Sizing" },
  pot_equity_math: { ja: "ポットと勝率の計算", term: "Pot / Equity Math" },
  range_reading: { ja: "レンジの読み", term: "Range Reading" },
  opponent_adaptation: { ja: "相手への適応", term: "Opponent Adaptation" },
  position: { ja: "ポジション", term: "Position" },
  live_mechanics: { ja: "ライブの所作", term: "Live Mechanics" },
};

export const SCORE_CONFIDENCE_LABELS: Readonly<
  Record<ScoreConfidence, string>
> = {
  insufficient: "判断なし",
  low: "低い",
  medium: "中くらい",
  high: "高い",
};

export const TREND_LABELS: Readonly<Record<TrendDirection, string>> = {
  improving: "上向き",
  stable: "横ばい",
  declining: "下向き",
  insufficient: "件数不足",
};

export const HYPOTHESIS_TYPE_LABELS: Readonly<Record<HypothesisType, string>> =
  {
    preflop_unraised: "Preflop で誰も Raise していない場面",
    preflop_facing_raise: "Preflop で Raise に直面した場面",
    postflop_facing_bet: "Flop 以降で Bet に直面した場面",
    postflop_unbet: "Flop 以降で Bet に直面していない場面",
    bet_raise: "Bet / Raise で額を引き上げた判断",
  };

export const HYPOTHESIS_STATUS_LABELS: Readonly<
  Record<HypothesisStatus, string>
> = {
  suspected: "疑い",
  supported: "裏付けあり",
  strong: "強い",
  improving: "改善中",
  resolved: "解消",
  insufficient_data: "データ不足",
};

/** Hypothesis の状態の色の分類（段階評価と同じ CSS の修飾子を使う）。 */
export function hypothesisTone(
  status: HypothesisStatus,
): "good" | "neutral" | "caution" | "bad" | "unknown" {
  switch (status) {
    case "resolved":
    case "improving":
      return "good";
    case "suspected":
      return "neutral";
    case "supported":
      return "caution";
    case "strong":
      return "bad";
    case "insufficient_data":
      return "unknown";
  }
}

/** 点数の表記。点数だけにせず、Confidence と件数を添える。集計に入る判断が無ければ点数を出さない。 */
export function scoreText(value: ScoreValue): string {
  if (value.score === null) return "まだ数えられる判断がありません";
  return `${value.score} 点`;
}

export function scoreMeta(value: ScoreValue): string {
  return `確度 ${SCORE_CONFIDENCE_LABELS[value.confidence]}・${value.sampleSize} 件`;
}

/**
 * 件数の注意（Confidence / Sample Caveat）。件数が少ないほど強く注意する。結果（収支）には触れない。
 */
export function sampleCaveat(
  reviewed: number,
  total: number,
  confidence: ScoreConfidence,
): string {
  if (total === 0) return "この Session には Hero の判断がありません。";
  if (reviewed === 0) {
    return "Review 済みの判断がまだ無いため、Score を出していません。Hand の Review を作ると、その判断が数に入ります。";
  }
  switch (confidence) {
    case "insufficient":
      return "Review はありますが、根拠が足りない判断だけなので Score を出していません。";
    case "low":
      return "数えた判断が少なく、Score は大きく揺れます。傾向の目安として見てください。";
    case "medium":
      return "数えた判断はある程度ありますが、まだ揺れます。";
    case "high":
      return "数えた判断が多く、Score は比較的安定しています。";
  }
}

/** Session の長さ（分。1 分未満は「1 分未満」）。 */
export function durationText(durationMs: number | null): string {
  if (durationMs === null) return "—";
  const minutes = Math.floor(durationMs / 60000);
  if (minutes < 1) return "1 分未満";
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
}

/** 収支の表記（実額が正本・BB は補助。D49）。符号を付ける（Replay の一覧と同じ書き方）。 */
export function netText(
  net: number,
  bigBlind: number,
  showBB: boolean,
): string {
  const sign = net > 0 ? "+" : net < 0 ? "−" : "±";
  return `${sign}${formatChipsWithBB(Math.abs(net), bigBlind, showBB)}`;
}

/** Stats の表記（日本語 + 標準 Term）。並びは Engine の定義の順。 */
export const STAT_TERMS: Readonly<Record<StatId, Term>> = {
  vpip: { ja: "自分から Pot に入った割合", term: "VPIP" },
  pfr: { ja: "Preflop で Raise した割合", term: "PFR" },
  three_bet: { ja: "3ベット", term: "3-bet" },
  fold_to_three_bet: { ja: "3ベットに Fold", term: "Fold to 3-bet" },
  cbet_flop: { ja: "継続ベット（Flop）", term: "C-bet" },
  fold_to_cbet_flop: { ja: "継続ベットに Fold", term: "Fold to C-bet" },
  aggression_frequency: { ja: "攻めの頻度", term: "AFq" },
  aggression_factor: { ja: "攻めの比率", term: "AF" },
};

export const STAT_IDS: readonly StatId[] = STAT_DEFINITIONS.map((d) => d.id);

/**
 * Stats 1 つの表記。分子 / 分母を必ず出す（2 / 3 と 200 / 300 を同じに見せない。docs/07 §3）。
 * 機会が 0 なら値を出さない。
 */
export function statText(id: StatId, value: StatValue): string {
  const def = STAT_DEFINITIONS.find((d) => d.id === id);
  const fraction = `${value.numerator} / ${value.denominator}`;
  if (value.denominator === 0) return `—（${fraction}）`;
  const ratio = value.numerator / value.denominator;
  return def?.kind === "ratio"
    ? `${ratio.toFixed(1)}（${fraction}）`
    : `${Math.round(ratio * 100)}%（${fraction}）`;
}
