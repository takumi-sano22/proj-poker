// Learning の API（#116）。型はサーバーの応答（SessionReview / ProfileResponse）のうち、画面が使う項目だけを写す。
// どちらも読み取りだけで、Review を作らない（D115）。値は Pass A の Review 済みの判断と Hero 自身の Stats だけから作られ、
// Hidden Persona・CPU の Private な状態・他者の札・Pass B は届かない。
import type {
  ActionType,
  Card,
  ImportantSpotReason,
  StatTable,
  Street,
} from "@proj-poker/engine";
import { getJson } from "./api.js";
import type { Assessment, Confidence } from "./review-api.js";

/** Ability Dimension（docs/07 §2。サーバーの ScoringPolicy の一覧。並びはサーバーが決める）。 */
export type AbilityDimension =
  | "preflop"
  | "postflop"
  | "bet_sizing"
  | "pot_equity_math"
  | "range_reading"
  | "opponent_adaptation"
  | "position"
  | "live_mechanics";

/** Score の Confidence（集計に入った件数から決まる。insufficient は Score が null）。 */
export type ScoreConfidence = "insufficient" | "low" | "medium" | "high";

export type TrendDirection =
  "improving" | "stable" | "declining" | "insufficient";

/** Score と、必ず一緒に見せる Confidence・Sample Size・Trend（点数だけを見せない。docs/07 §2）。 */
export interface ScoreValue {
  /** 0〜100（小数第 1 位まで）。集計に入る判断が無ければ null。 */
  readonly score: number | null;
  readonly confidence: ScoreConfidence;
  readonly sampleSize: number;
  readonly trend: { readonly direction: TrendDirection };
}

export interface AbilityScore extends ScoreValue {
  readonly ability: AbilityDimension;
}

/** Strength / Leak の判断 1 つ（Pass A の段階評価と判断時点の特徴だけ）。 */
export interface SessionDecisionRef {
  readonly handId: string;
  /** Session の中の Hand の番号（1 始まり）。 */
  readonly handNumber: number;
  readonly decisionIndex: number;
  readonly street: Street;
  readonly action: ActionType;
  readonly assessment: Assessment;
  readonly confidence: Confidence;
}

/** Important Hands の 1 行（結果を見ずに選ばれる）。 */
export interface SessionImportantHand {
  readonly handId: string;
  readonly handNumber: number;
  readonly heroHoleCards: readonly Card[] | null;
  readonly reasons: readonly ImportantSpotReason[];
  readonly decisions: { readonly total: number; readonly reviewed: number };
  readonly leakCount: number;
  readonly strengthCount: number;
}

/** Hero 自身の Stats（他 Player の行は届かない）。 */
export interface HeroStats {
  readonly version: string;
  readonly hands: number;
  readonly overall: StatTable | null;
}

export interface SessionReview {
  readonly policyVersion: string;
  readonly scoringPolicyVersion: string;
  readonly hands: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly bigBlind: number | null;
  /** Hero の収支（実額）。 */
  readonly heroNet: number;
  readonly decisionQuality: {
    /** 対象の判断の数（M）。 */
    readonly total: number;
    /** Pass A の Review がある判断の数（N）。 */
    readonly reviewed: number;
    readonly scored: number;
    readonly insufficientEvidence: number;
    readonly assessments: Readonly<Record<Assessment, number>>;
    readonly overall: ScoreValue;
  };
  readonly abilities: readonly AbilityScore[];
  readonly strengths: readonly SessionDecisionRef[];
  readonly leaks: readonly SessionDecisionRef[];
  readonly importantHands: readonly SessionImportantHand[];
  readonly heroStats: HeroStats;
  /** Drill の入口（#117）。候補（Leak の最初の判断）があれば始められる。 */
  readonly recommendedDrill: {
    readonly available: boolean;
    readonly candidate: SessionDecisionRef | null;
  };
}

/** Weakness Hypothesis の状態（docs/07 §5）。 */
export type HypothesisStatus =
  | "suspected"
  | "supported"
  | "strong"
  | "improving"
  | "resolved"
  | "insufficient_data";

/** Hypothesis の判断の分類（サーバーの HypothesisPolicy の一覧。Version ごとに変わりうる）。 */
export type HypothesisType =
  | "preflop_unraised"
  | "preflop_facing_raise"
  | "postflop_facing_bet"
  | "postflop_unbet"
  | "bet_raise";

export interface Hypothesis {
  readonly hypothesisId: string;
  readonly type: HypothesisType;
  readonly status: HypothesisStatus;
  readonly supportingEvidenceIds: readonly string[];
  readonly counterEvidenceIds: readonly string[];
  readonly policyVersion: string;
  readonly computedAt: string;
}

export interface ProfileWindow {
  readonly reviewed: number;
  readonly scored: number;
  readonly overall: ScoreValue;
  readonly abilities: readonly AbilityScore[];
}

export interface PlayerProfile {
  readonly policyVersion: string;
  readonly decisions: { readonly total: number; readonly reviewed: number };
  readonly recent: ProfileWindow & { readonly window: number };
  readonly longTerm: ProfileWindow;
  readonly hypotheses: readonly Hypothesis[];
}

export interface ProfileResponse {
  readonly profile: PlayerProfile;
  /** Structured Profile からの決定論の文（表示用の派生）。 */
  readonly text: string;
  readonly heroStats: HeroStats;
}

/** handId の Hand が属する Session の Session Review。 */
export function fetchSessionReview(handId: string): Promise<SessionReview> {
  return getJson<SessionReview>(
    `/api/learning/session-review/${encodeURIComponent(handId)}`,
  );
}

/** Recent / Long-term の Player Profile。 */
export function fetchProfile(): Promise<ProfileResponse> {
  return getJson<ProfileResponse>("/api/learning/profile");
}
