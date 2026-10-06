// Review の画面の文言（#84・docs/05 §8〜§10・docs/06 §10・§11）。サーバーが返した Review の値を読める文にするだけで、
// 評価・計算はしない（評価は Review AI と Gate、数値は Engine が決める）。
// 生成の待ち・失敗の案内では内部実装（モデル名・呼んでいる API）を前面に出さない（docs/06 §11）。
import type { ImportantSpotReason, PreflopSpot } from "@proj-poker/engine";
import { ACTION_TERMS, termLabel, type Term } from "./format.js";
import { describeAction } from "./view-model.js";
import type { ReplayDecision } from "./api.js";
import type {
  Assessment,
  Confidence,
  MadeHand,
  ReviewGeneratedBy,
  ReviewGeneration,
  SolverActionFrequency,
  SolverEvidence,
  SolverUnsupportedReason,
} from "./review-api.js";

/** 段階評価の表記（日本語 + docs/05 §8 の語）。点数にはしない。 */
export const ASSESSMENT_TERMS: Readonly<Record<Assessment, Term>> = {
  strong: { ja: "良い判断", term: "Strong" },
  reasonable: { ja: "妥当", term: "Reasonable" },
  mixed_marginal: { ja: "どちらもあり得る", term: "Mixed / Marginal" },
  improvement_suggested: {
    ja: "改善の余地あり",
    term: "Improvement Suggested",
  },
  major_leak: { ja: "大きな損失", term: "Major Leak" },
  insufficient_evidence: {
    ja: "根拠が足りない",
    term: "Insufficient Evidence",
  },
};

/** 段階評価の色の分類（CSS の修飾子）。良い / 中間 / 注意 / 悪い / 保留。 */
export function assessmentTone(
  assessment: Assessment,
): "good" | "neutral" | "caution" | "bad" | "unknown" {
  switch (assessment) {
    case "strong":
    case "reasonable":
      return "good";
    case "mixed_marginal":
      return "neutral";
    case "improvement_suggested":
      return "caution";
    case "major_leak":
      return "bad";
    case "insufficient_evidence":
      return "unknown";
  }
}

export const CONFIDENCE_LABELS: Readonly<Record<Confidence, string>> = {
  low: "低い",
  medium: "中くらい",
  high: "高い",
};

export const IMPORTANT_SPOT_REASON_LABELS: Readonly<
  Record<ImportantSpotReason, string>
> = {
  big_pot: "大きい Pot",
  all_in: "All-in",
  river_big_bet: "River の大きい Bet",
  ruling: "Dealer の裁定",
};

/** Hero の判断の 1 行（進行ログと同じ書き方。例: "コール（Call） 10" / "レイズ（Raise） 30 まで"）。 */
export function decisionLabel(
  decision: Pick<ReplayDecision, "action" | "amount" | "toAmount" | "allIn">,
): string {
  return describeAction(decision);
}

/** Review の Version の選択肢の表記（例: "Version 2（最新）"）。 */
export function versionLabel(version: number, latest: boolean): string {
  return latest ? `Version ${version}（最新）` : `Version ${version}`;
}

/**
 * 生成の待ち・失敗の案内。待ちは「作っています」だけにし、長く待っているとき（delayed）だけ補足する。
 * 失敗は種類ごとに、Hero が次にできること（もう一度作る・ログインし直す・枠が戻るまで待つ）を添える。idle は null。
 */
export function generationMessage(
  generation: ReviewGeneration,
  subject: string,
  delayed: boolean,
): string | null {
  switch (generation.state) {
    case "idle":
      return null;
    case "pending": {
      const base =
        generation.depth === "deep"
          ? `詳しい${spaced(subject)}を作っています…（標準より時間がかかります）`
          : `${spaced(subject, false)}を作っています…`;
      return delayed
        ? `${base} 時間がかかっています。このままお待ちください。`
        : base;
    }
    case "failed":
      switch (generation.kind) {
        case "unauthenticated":
          return `AI にログインしていないため、${spaced(subject, false)}を作れませんでした。ログインし直してから、もう一度作ってください。`;
        case "usage_limit":
          return `AI の利用枠の上限に達したため、${spaced(subject, false)}を作れませんでした。枠が戻ってから、もう一度作ってください。`;
        case "timeout":
          return `${spaced(subject, false)}が時間内にできませんでした。もう一度作ってください。`;
        case "error":
          return `${spaced(subject, false)}を作れませんでした。もう一度作ってください。`;
      }
  }
}

/** 英字の語を日本語の文に入れるときは前後に空白を置く（"詳しい Review を"）。leading が false なら前は空けない（文頭・読点の後）。 */
export function spaced(word: string, leading = true): string {
  const before = leading && /^[A-Za-z]/.test(word) ? " " : "";
  const after = /[A-Za-z]$/.test(word) ? " " : "";
  return `${before}${word}${after}`;
}

/** Insufficient Evidence の理由（どの経路で評価を保留したか）。Review AI が評価した Review は null。 */
export function insufficientNote(
  generatedBy: ReviewGeneratedBy,
): string | null {
  switch (generatedBy) {
    case "review_ai":
      return null;
    case "sufficiency_gate":
      return "判断時点の情報からは評価に足りる根拠がそろわなかったため、評価を保留しています。";
    case "invalid_output_fallback":
      return "説明を検証できなかったため、評価を保留しています。もう一度作ると評価できることがあります。";
  }
}

const UNSUPPORTED_LABELS: Readonly<Record<SolverUnsupportedReason, string>> = {
  player_count:
    "3 人以上で Pot を争う場面（Multiway）は、Solver の対象外です。",
  street:
    "この Street は Solver で解いていません（Solver は Turn と River だけ）。",
  mode: "この卓の形式は Solver の対象外です。",
  rake: "Rake のある卓は Solver の対象外です。",
  side_pot: "Side Pot がある場面は Solver の対象外です。",
  bet_tree: "Bet の大きさが Solver の想定に当てはまりません。",
  solver_not_installed: "Solver が導入されていません。",
};

/**
 * Solver Evidence の見出しと前提。supported のときだけ Solver の結果を出し、それ以外は「使っていない理由」と Fallback を出す。
 * Solver の結果は Heads-Up の解で、Multiway の Exact GTO としては扱わない（不変条件 5）。
 */
export function solverNote(solver: SolverEvidence): {
  readonly supported: boolean;
  readonly reason: string;
} {
  switch (solver.status) {
    case "supported":
      return {
        supported: true,
        reason:
          "Heads-Up（2 人）の場面を Solver で解いた結果です。仮定した Range と Bet の大きさの前提つきで、唯一の正解ではありません。",
      };
    case "unsupported":
      return { supported: false, reason: UNSUPPORTED_LABELS[solver.reason] };
    case "not_applicable":
      return {
        supported: false,
        reason:
          solver.reason === "preflop"
            ? "Preflop は Solver を使っていません。"
            : "この Street の最初の判断ではないため、Solver の結果を当てはめていません。",
      };
    case "failed":
      return {
        supported: false,
        reason: "Solver が結果を返せませんでした。",
      };
  }
}

/** Solver を使わなかったときに代わりに使う根拠（docs/05 §10・OI-009）。 */
export const SOLVER_FALLBACK_NOTE =
  "代わりに、計算（Math）・相手の Range の仮定・知識（KB）の根拠で評価しています。";

/** Solver の行動の表記（例: "ベット（Bet） Pot の 50%"）。 */
export function solverActionLabel(
  action: SolverActionFrequency["action"],
): string {
  switch (action.kind) {
    case "check":
      return termLabel(ACTION_TERMS.check);
    case "bet":
      return `${termLabel(ACTION_TERMS.bet)} Pot の ${Math.round(action.potFraction * 100)}%`;
    case "all_in":
      return termLabel(ACTION_TERMS.all_in);
  }
}

export const MADE_HAND_LABELS: Readonly<Record<MadeHand, string>> = {
  high_card: "ハイカード（High Card）",
  pair: "ワンペア（Pair）",
  two_pair: "ツーペア（Two Pair）",
  three_of_a_kind: "スリーカード（Three of a Kind）",
  straight: "ストレート（Straight）",
  flush: "フラッシュ（Flush）",
  full_house: "フルハウス（Full House）",
  four_of_a_kind: "フォーカード（Four of a Kind）",
  straight_flush: "ストレートフラッシュ（Straight Flush）",
};

/** Follow-up の答えの範囲の注記。answered は null。 */
export function followUpScopeNote(
  scope: "answered" | "out_of_scope" | "unanswered",
  pass: "decision" | "reveal",
): string | null {
  switch (scope) {
    case "answered":
      return null;
    case "out_of_scope":
      return pass === "decision"
        ? "この Review（判断時点の情報）の範囲外の質問です。Hand 後の情報は「答え合わせ」で確かめられます。"
        : "この答え合わせの範囲外の質問です。";
    case "unanswered":
      return "答えを作れませんでした。言い換えて、もう一度質問してください。";
  }
}

/** 相手の Preflop の Action 列（Range の仮定の材料）の表記。 */
export const PREFLOP_SPOT_LABELS: Readonly<Record<PreflopSpot, string>> = {
  open: "最初にレイズ（Open）",
  limp: "リンプ（Limp）",
  call_open: "Open にコール（Call）",
  three_bet: "スリーベット（3-Bet）",
  call_three_bet: "3-Bet にコール（Call）",
  four_bet_plus: "フォーベット以上（4-Bet+）",
  check_option: "BB のチェック（Check）",
  not_acted: "まだ Action していない",
};
