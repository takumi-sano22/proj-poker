// Review の API（#82・#83・#84）。型はサーバーの応答（ReviewStatus / RevealStatus / FollowUpStatus と、Review の Record）のうち、
// 画面が使う項目だけを写す。Pass A（decision）の応答は判断時点の情報だけで、全員の札は Pass B（reveal）の応答にだけ入る。
// 生成は非同期で、POST は待ちの状態を返し、GET で終わりを確かめる（ポーリング）。
import type {
  ActionType,
  AlternativeAction,
  Card,
  ImportantSpotReason,
  PositionName,
  PublicActionRecord,
  RangeAssumption,
  Street,
} from "@proj-poker/engine";
import { postJson } from "./api.js";

/** Review の Pass。decision は Pass A（判断時点の Review）、reveal は Pass B（Hand 後の答え合わせ）。 */
export type ReviewPass = "decision" | "reveal";

/** 標準か「詳しく」（Hero が選んだ Spot だけ。D97）。 */
export type ReviewDepth = "standard" | "deep";

/** 段階評価（docs/05 §8）。 */
export type Assessment =
  | "strong"
  | "reasonable"
  | "mixed_marginal"
  | "improvement_suggested"
  | "major_leak"
  | "insufficient_evidence";

export type Confidence = "low" | "medium" | "high";

/** 生成の失敗の種類（内部のエラー本文は届かない）。 */
export type ReviewFailureKind =
  "unauthenticated" | "usage_limit" | "timeout" | "error";

export type ReviewGeneration =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly depth: ReviewDepth }
  | {
      readonly state: "failed";
      readonly depth: ReviewDepth;
      readonly kind: ReviewFailureKind;
    };

/** どの経路で作った Review か（Insufficient Evidence の理由の出し分けに使う）。 */
export type ReviewGeneratedBy =
  "review_ai" | "sufficiency_gate" | "invalid_output_fallback";

/** 判断時点の卓（Decision Context）。他者の札は持たない。 */
export interface DecisionContext {
  readonly street: Street;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly heroId: string;
  readonly heroPosition: PositionName;
  readonly playerCount: number;
  readonly activePlayerCount: number;
  readonly heroHoleCards: readonly Card[];
  readonly board: readonly Card[];
  readonly pot: number;
  readonly currentBet: number;
  readonly seats: readonly {
    readonly playerId: string;
    readonly position: PositionName;
    readonly isHero: boolean;
    readonly stack: number;
    readonly streetCommitted: number;
    readonly folded: boolean;
    readonly allIn: boolean;
  }[];
  readonly actionHistory: readonly PublicActionRecord[];
  readonly decision: {
    readonly action: ActionType;
    readonly amount: number;
    readonly toAmount: number;
    readonly allIn: boolean;
  };
  readonly importantSpotReasons: readonly ImportantSpotReason[];
}

export interface MathEvidence {
  readonly id: string;
  readonly pot: number;
  readonly callAmount: number;
  readonly potOdds: number | null;
  readonly effectiveStack: number;
  readonly spr: number | null;
  readonly equity: {
    readonly equity: number;
    readonly method: "exact" | "monte_carlo";
  } | null;
  readonly alternatives: readonly AlternativeAction[];
  readonly assumptions: readonly string[];
}

export interface RangeEvidence {
  readonly id: string;
  readonly villains: readonly RangeAssumption[];
  readonly comparisons:
    | readonly {
        readonly id: string;
        readonly profileId: string;
        readonly label: string;
        readonly equity: number | null;
      }[]
    | null;
}

/** Solver の行動（"check" / "bet_50" / "all_in"）。 */
export interface SolverActionFrequency {
  readonly key: string;
  readonly action:
    | { readonly kind: "check" }
    | { readonly kind: "bet"; readonly potFraction: number }
    | { readonly kind: "all_in"; readonly amount: number };
  readonly frequency: number;
}

/** Solver が Unsupported にした理由（サーバーの UnsupportedReason）。 */
export type SolverUnsupportedReason =
  | "player_count"
  | "street"
  | "mode"
  | "rake"
  | "side_pot"
  | "bet_tree"
  | "solver_not_installed";

/** Solver Evidence。supported のときだけ Solver の結果があり、それ以外は Fallback の理由。 */
export type SolverEvidence =
  | {
      readonly status: "supported";
      readonly id: string;
      /** HU の Solver の結果（Multiway の Exact GTO ではない）。 */
      readonly scope: "heads_up";
      readonly strategy: readonly SolverActionFrequency[];
      readonly heroHandClass: string;
      readonly heroHandClassStrategy: Readonly<Record<string, number>> | null;
      readonly convergence: {
        readonly iterations: number;
        readonly note: string;
      };
      readonly assumptions: readonly string[];
      readonly warnings: readonly string[];
    }
  | {
      readonly status: "unsupported";
      readonly reason: SolverUnsupportedReason;
      readonly detail: string;
    }
  | {
      readonly status: "not_applicable";
      readonly reason: "preflop" | "not_root_node";
      readonly detail: string;
    }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly detail: string;
    };

export interface KnowledgeItem {
  readonly id: string;
  readonly title: string;
  readonly label: string;
  readonly body: string;
}

/** Pass A の Evidence（判断時点の情報だけ）。 */
export interface ReviewEvidence {
  readonly context: DecisionContext;
  readonly math: MathEvidence;
  readonly range: RangeEvidence;
  readonly solver: SolverEvidence;
  readonly knowledge: { readonly items: readonly KnowledgeItem[] };
}

/** Pass A の Review の 1 Version（上書きしない。D39）。 */
export interface ReviewRecord {
  readonly reviewId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly depth: ReviewDepth;
  readonly generatedBy: ReviewGeneratedBy;
  readonly assessment: Assessment;
  readonly confidence: Confidence;
  readonly assumptions: readonly string[];
  readonly evidenceIds: { readonly cited: readonly string[] };
  readonly explanation: {
    readonly practical: string;
    readonly theory: {
      readonly basis: "solver" | "general_theory" | "none";
      readonly text: string;
    };
    readonly exploit: {
      readonly basis: "observation" | "none";
      readonly text: string;
    };
    readonly conclusionChangers: readonly string[];
  };
  readonly evidence: ReviewEvidence;
}

/** 役の名前。 */
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

/** Pass B の Evidence（Hand 後に見せた全員の札を含む。学習用）。 */
export interface RevealEvidence {
  readonly context: DecisionContext;
  readonly reveal: {
    readonly villains: readonly {
      readonly playerId: string;
      readonly position: PositionName;
      readonly holeCards: readonly Card[];
      readonly activeAtDecision: boolean;
      readonly assumedRange: RangeAssumption | null;
      readonly inAssumedRange: boolean | null;
      readonly madeHandAtDecision: MadeHand | null;
    }[];
    readonly finalBoard: readonly Card[];
  };
  readonly equity: {
    readonly assumed: number | null;
    readonly actual: { readonly equity: number } | null;
    readonly heroMadeHandAtDecision: MadeHand | null;
  };
  readonly aggression: {
    readonly items: readonly {
      readonly playerId: string;
      readonly isHero: boolean;
      readonly isDecision: boolean;
      readonly street: Street;
      readonly action: ActionType;
      readonly toAmount: number;
      readonly playersInPot: number;
      readonly actorEquity: number | null;
      readonly label: "value" | "bluff" | null;
    }[];
    readonly rule: string;
  };
}

/** Pass B の 1 Version（評価を持たない）。 */
export interface RevealRecord {
  readonly reviewId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly depth: ReviewDepth;
  readonly generatedBy: ReviewGeneratedBy;
  readonly explanation: {
    readonly readComparison: string;
    readonly actualEquity: string;
    readonly bluffValue: string;
    readonly takeaways: readonly string[];
  };
  readonly evidence: RevealEvidence;
}

/** Pass ごとの状態（最新の Version・Version の数・生成の状態）。 */
export interface PassStatus<R> {
  readonly generation: ReviewGeneration;
  readonly latest: R | null;
  readonly versions: number;
}

export type ReviewStatus = PassStatus<ReviewRecord>;
export type RevealStatus = PassStatus<RevealRecord>;

export interface FollowUpTurn {
  readonly followupId: string;
  readonly turn: number;
  readonly depth: ReviewDepth;
  readonly question: string;
  readonly answer: {
    readonly scope: "answered" | "out_of_scope" | "unanswered";
    readonly text: string;
  };
}

export interface FollowUpStatus {
  readonly generation: ReviewGeneration;
  readonly turns: readonly FollowUpTurn[];
  readonly maxTurns: number;
}

/** Follow-up の質問の上限の文字数（サーバーの FOLLOWUP_QUESTION_MAX と同じ値）。 */
export const FOLLOWUP_QUESTION_MAX = 500;

function decisionPath(handId: string, decisionIndex: number): string {
  return `/api/reviews/hands/${encodeURIComponent(handId)}/decisions/${decisionIndex}`;
}

/** Pass の状態（GET）と生成（POST）の URL。Pass A は判断の URL、Pass B はその下の /reveal。 */
export function passPath(
  handId: string,
  decisionIndex: number,
  pass: ReviewPass,
): string {
  const base = decisionPath(handId, decisionIndex);
  return pass === "decision" ? base : `${base}/reveal`;
}

/** 指定した Version の Review（GET）の URL。 */
export function passVersionPath(
  handId: string,
  decisionIndex: number,
  pass: ReviewPass,
  version: number,
): string {
  return `${passPath(handId, decisionIndex, pass)}/versions/${version}`;
}

/** Review の Version への Follow-up（GET は履歴、POST は質問）の URL。 */
export function followUpsPath(
  handId: string,
  decisionIndex: number,
  pass: ReviewPass,
  version: number,
): string {
  return `${decisionPath(handId, decisionIndex)}/passes/${pass}/versions/${version}/followups`;
}

/** 新しい Version の生成を始める（待ちの状態を返す）。生成済みでも要求するたびに次の Version を作る（D39）。 */
export function requestPass<S>(path: string, depth: ReviewDepth): Promise<S> {
  return postJson<S>(path, depth === "deep" ? { depth } : {});
}

/** Follow-up の質問を送る（答えの生成を始め、待ちの状態を返す）。 */
export function askFollowUp(
  path: string,
  question: string,
  depth: ReviewDepth,
): Promise<FollowUpStatus> {
  return postJson<FollowUpStatus>(path, {
    question,
    ...(depth === "deep" ? { depth } : {}),
  });
}
