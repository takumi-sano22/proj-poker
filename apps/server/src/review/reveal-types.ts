// Reveal Review（Pass B。docs/05 §7）と Follow-up Q&A（#83）の型。
// Pass B は Hand 後の Learning-only Full Reveal（projectLearningReveal）で答え合わせをする別の Pass で、Pass A の Review は書き換えない。
// Pass B には評価（Assessment）を付けない（結果論を判断の評価に混ぜない。不変条件 3）。
import type {
  ActionType,
  Card,
  PositionName,
  RangeAssumption,
  Street,
} from "@proj-poker/engine";
import type {
  DecisionContextEvidence,
  ReviewDepth,
  ReviewEvidence,
  ReviewExplanation,
  ReviewGeneratedBy,
  ReviewModelRole,
  ReviewPass,
} from "./types.js";

/** 役の名前（Engine の HandCategory を読める語にしたもの）。 */
export type MadeHand =
  | "high_card"
  | "pair"
  | "two_pair"
  | "three_of_a_kind"
  | "straight"
  | "flush"
  | "full_house"
  | "four_of_a_kind"
  | "straight_flush";

/** Hand 後に見せた相手 1 人の札と、判断時点の読み（仮定した Range）との比較。 */
export interface RevealVillainEvidence {
  readonly playerId: string;
  /** Hero の画面に出ている名前（文ではこの名前で呼ぶ。#96）。 */
  readonly displayName?: string;
  readonly position: PositionName;
  readonly holeCards: readonly Card[];
  /** 判断時点で Fold していなかった（Hero と Pot を争っていた）か。 */
  readonly activeAtDecision: boolean;
  /** 判断時点に仮定した Range（標準の想定。Pass A の Range Evidence と同じ作り方）。Fold 済みの相手は null。 */
  readonly assumedRange: RangeAssumption | null;
  /** 実際の札が、判断時点に仮定した Range に入っていたか。Fold 済みの相手は null。 */
  readonly inAssumedRange: boolean | null;
  /** 判断時点の Board での実際の役（Preflop は Board が無いので null）。 */
  readonly madeHandAtDecision: MadeHand | null;
}

/** 実際の Equity（相手の実際の札に対する、判断時点の Board からの Showdown までの勝率）と、判断時点に仮定した Range に対する Equity。 */
export interface RevealEquityEvidence {
  readonly id: string;
  /** 判断時点に仮定した Range に対する Equity（Pass A の Math Evidence と同じ計算）。出せなければ null。 */
  readonly assumed: number | null;
  /** 判断時点で Fold していなかった相手全員の実際の札に対する Equity。 */
  readonly actual: {
    readonly equity: number;
    readonly win: number;
    readonly tie: number;
    readonly method: "exact" | "monte_carlo";
    readonly trials: number;
  } | null;
  /** 判断時点の Board での Hero の役（Preflop は null）。 */
  readonly heroMadeHandAtDecision: MadeHand | null;
}

/** Bluff / Value の答え合わせ 1 つ分（判断時点までの Bet / Raise と、Hero の判断が Bet / Raise ならその判断）。 */
export interface AggressionCheck {
  readonly playerId: string;
  readonly isHero: boolean;
  /** Review の対象の判断そのものか（Hero の Bet / Raise）。 */
  readonly isDecision: boolean;
  readonly street: Street;
  readonly action: ActionType;
  readonly toAmount: number;
  /** その Action の時点で Pot を争っていた人数（Action した本人を含む）。 */
  readonly playersInPot: number;
  /** その Action の時点の Board での、本人の実際の札の、残りの相手の実際の札に対する Equity。 */
  readonly actorEquity: number | null;
  /** actorEquity が公平な取り分（1 / playersInPot）以上なら value、未満なら bluff。出せなければ null。 */
  readonly label: "value" | "bluff" | null;
}

/** Pass B の Evidence。Learning-only の情報（全員の札）を含むので、CPU の入力・Pass A の入力には渡さない（INV-TEST-008）。 */
export interface RevealEvidence {
  readonly pass: "reveal";
  readonly handId: string;
  readonly decisionIndex: number;
  /** 判断時点の卓（Pass A と同じ Decision Context）。 */
  readonly context: DecisionContextEvidence;
  readonly reveal: {
    readonly id: string;
    /** 学習用の開示であることの印（projectLearningReveal の値の印をそのまま持つ）。 */
    readonly visibility: "learning_only";
    readonly villains: readonly RevealVillainEvidence[];
    /** Hand の最後までに公開された Board（Deck の残りは含まない）。 */
    readonly finalBoard: readonly Card[];
  };
  readonly equity: RevealEquityEvidence;
  readonly aggression: {
    readonly id: string;
    readonly items: readonly AggressionCheck[];
    /** value / bluff の決め方（暫定の基準。Evidence と一緒に Review AI へ渡す）。 */
    readonly rule: string;
  };
}

/** Pass B の Evidence の ID。cited は Review AI が根拠に挙げた ID。 */
export interface RevealEvidenceIdSet {
  readonly context: readonly string[];
  readonly reveal: readonly string[];
  readonly equity: readonly string[];
  readonly aggression: readonly string[];
  readonly cited: readonly string[];
}

/** Pass B の説明（読みと実際の比較・実際の Equity・Bluff / Value の答え合わせ・次に活かす点）。 */
export interface RevealExplanation {
  readonly readComparison: string;
  readonly actualEquity: string;
  readonly bluffValue: string;
  readonly takeaways: readonly string[];
}

/** 保存する前の Pass B（Version・ID・時刻は Store が付ける）。Assessment は持たない。 */
export interface RevealReviewDraft {
  readonly handId: string;
  readonly decisionIndex: number;
  readonly actionSeq: number;
  readonly pass: "reveal";
  readonly depth: ReviewDepth;
  readonly modelRole: ReviewModelRole;
  /** Review AI を呼んだときの具体モデル名。Gate で止めた（呼んでいない）なら null。 */
  readonly concreteModel: string | null;
  readonly generatedBy: ReviewGeneratedBy;
  readonly evidenceIds: RevealEvidenceIdSet;
  readonly explanation: RevealExplanation;
  readonly evidence: RevealEvidence;
  readonly failure: {
    readonly kind: "invalid_output";
    readonly attempts: readonly {
      readonly stage: string;
      readonly reason: string;
    }[];
  } | null;
}

/** 保存した Pass B（reveal_reviews の行）。上書きしない（D39）。 */
export interface RevealReviewRecord extends RevealReviewDraft {
  readonly reviewId: string;
  /** 同じ Hand・判断の中の Pass B の版（1 から）。 */
  readonly version: number;
  /** ISO 8601（UTC）。 */
  readonly createdAt: string;
}

/** Follow-up の質問の対象（Pass と Version で指定した 1 つの Review）。 */
export type FollowUpTarget =
  | {
      readonly pass: "decision";
      readonly reviewId: string;
      readonly handId: string;
      readonly decisionIndex: number;
      readonly version: number;
      readonly evidence: ReviewEvidence;
      readonly explanation: ReviewExplanation;
    }
  | {
      readonly pass: "reveal";
      readonly reviewId: string;
      readonly handId: string;
      readonly decisionIndex: number;
      readonly version: number;
      readonly evidence: RevealEvidence;
      readonly explanation: RevealExplanation;
    };

/**
 * Follow-up の答え。scope は、その Pass の Evidence で答えられたか（answered）、範囲の外だったか（out_of_scope）、
 * Review AI の出力を 2 回続けて検証できず答えなかったか（unanswered。Fallback だけが使う）。
 */
export interface FollowUpAnswer {
  readonly scope: "answered" | "out_of_scope" | "unanswered";
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

/** 保存する前の Follow-up の 1 ターン（質問と答え）。 */
export interface FollowUpDraft {
  readonly reviewId: string;
  readonly pass: ReviewPass;
  readonly handId: string;
  readonly decisionIndex: number;
  /** 質問の対象の Review の Version。 */
  readonly reviewVersion: number;
  readonly depth: ReviewDepth;
  readonly modelRole: ReviewModelRole;
  readonly concreteModel: string;
  /** Follow-up は Gate を持たない（対象の Review の Evidence をそのまま使う）。 */
  readonly generatedBy: Exclude<ReviewGeneratedBy, "sufficiency_gate">;
  readonly question: string;
  readonly answer: FollowUpAnswer;
  readonly failure: RevealReviewDraft["failure"];
}

/** 保存した Follow-up の 1 ターン（review_followups の行）。上書きしない。 */
export interface FollowUpRecord extends FollowUpDraft {
  readonly followupId: string;
  /** その Review の Version の中のターンの順番（1 から）。 */
  readonly turn: number;
  /** ISO 8601（UTC）。 */
  readonly createdAt: string;
}
