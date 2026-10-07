// Ability Evidence（docs/07 §2・D103・D115）。Event Log（正本）の Hero の判断と、その判断の Pass A の Review（reviews）から作る。
// - 入力は Pass A だけ。Pass B（reveal_reviews）は型の上でも受け取らない（Hindsight を Score に混ぜない。D111・不変条件 3）
// - Review を作らない。Review の無い判断は「対象の判断の数（M）」にだけ数え、Evidence を作らない（D115: 課金を増やさない）
// - 都度計算し、保存しない（D111）
import { heroDecisions, type HandEvent } from "@proj-poker/engine";
import { isHandEnd } from "../event-store.js";
import type { ReviewStore } from "../review/review-store.js";
import type {
  Assessment,
  Confidence,
  EvidenceIdSet,
  ReviewDepth,
  ReviewRecord,
} from "../review/types.js";
import type {
  AbilityAssignment,
  DecisionFeatures,
  ScoringPolicy,
} from "./scoring-policy.js";

/** 1 つの判断の Ability Evidence（その判断の最新の Pass A の Review 1 つから作る）。 */
export interface AbilityEvidence {
  /** `<handId>/d<decisionIndex>/v<Review の Version>`。同じ入力からは同じ ID。 */
  readonly id: string;
  readonly handId: string;
  readonly decisionIndex: number;
  readonly actionSeq: number;
  readonly reviewId: string;
  readonly reviewVersion: number;
  readonly depth: ReviewDepth;
  readonly assessment: Assessment;
  readonly confidence: Confidence;
  /** Assessment の点。insufficient_evidence は null（Poker Decision の集計から除く）。 */
  readonly points: number | null;
  /** Confidence から決めた集計の Weight（点数は変えない）。 */
  readonly confidenceWeight: number;
  /** Poker Decision の Ability への割り当て。 */
  readonly abilities: readonly AbilityAssignment[];
  /** Live Mechanics（D48: Poker Decision と別の Score）。 */
  readonly liveMechanics: {
    readonly points: number;
    readonly rulingNotes: DecisionFeatures["rulingNotes"];
  };
  /** Review が根拠にした Evidence の ID（provenance）。 */
  readonly reviewEvidenceIds: EvidenceIdSet;
  /** 割り当てに使った判断時点の特徴（Hypothesis の type の分類にも使う。#114）。 */
  readonly features: DecisionFeatures;
}

/** Score の入力。Hand は古い順（Trend はこの順で見る）。 */
export interface ScoreSource {
  readonly hands: readonly (readonly HandEvent[])[];
  /** Pass A の Review（reviews）。Pass B の Store は渡せない。 */
  readonly reviews: Pick<ReviewStore, "list">;
  readonly heroId: string;
}

export interface AbilityEvidenceOptions {
  /** 集計から除く Hand の handId（D116: Drill の Hand。drills テーブルは #117 で作るので、呼び出し側が渡す）。 */
  readonly excludeHandIds?: ReadonlySet<string>;
}

export interface AbilityEvidenceSet {
  /** 対象の判断の数（M）: 終わった Hand の Hero の判断（除外した Hand を除く）。 */
  readonly decisionCount: number;
  /** Pass A の Review がある判断の数（N）。 */
  readonly reviewedCount: number;
  /** 判断の順（Hand の順 → 判断の順）。 */
  readonly evidence: readonly AbilityEvidence[];
}

export function buildAbilityEvidence(
  source: ScoreSource,
  policy: ScoringPolicy,
  options: AbilityEvidenceOptions = {},
): AbilityEvidenceSet {
  const exclude = options.excludeHandIds ?? new Set<string>();
  let decisionCount = 0;
  const evidence: AbilityEvidence[] = [];

  for (const events of source.hands) {
    // Review を作れるのは終わった Hand だけ（review-service と同じ条件）。進行中の Hand は M にも数えない。
    if (!events.some(isHandEnd)) continue;
    const started = events.find((e) => e.type === "HAND_STARTED");
    if (started === undefined) {
      // 終わった Hand に開始の Event が無いのは壊れた Log。黙って読み飛ばさない。
      throw new RangeError("HAND_STARTED の無い Hand の Event Log は読めない");
    }
    if (exclude.has(started.handId)) continue;

    for (const decision of heroDecisions(events, source.heroId)) {
      decisionCount++;
      const review = policy.selectReview(
        source.reviews.list(started.handId, decision.index, "decision"),
      );
      if (review === null) continue;
      evidence.push(toAbilityEvidence(review, policy));
    }
  }

  return { decisionCount, reviewedCount: evidence.length, evidence };
}

function toAbilityEvidence(
  review: ReviewRecord,
  policy: ScoringPolicy,
): AbilityEvidence {
  const features = decisionFeatures(review);
  return {
    id: `${review.handId}/d${review.decisionIndex}/v${review.version}`,
    handId: review.handId,
    decisionIndex: review.decisionIndex,
    actionSeq: review.actionSeq,
    reviewId: review.reviewId,
    reviewVersion: review.version,
    depth: review.depth,
    assessment: review.assessment,
    confidence: review.confidence,
    points: policy.assessmentPoints[review.assessment],
    confidenceWeight: policy.confidenceWeights[review.confidence],
    abilities: policy.assignAbilities(features),
    liveMechanics: {
      points: policy.liveMechanicsPoints(features.rulingNotes),
      rulingNotes: features.rulingNotes,
    },
    reviewEvidenceIds: review.evidenceIds,
    features,
  };
}

/** 判断の特徴を、Review が持つ判断時点の Evidence（Pass A の入力）だけから作る。 */
export function decisionFeatures(review: ReviewRecord): DecisionFeatures {
  const { context, math } = review.evidence;
  return {
    street: context.street,
    action: context.decision.action,
    callAmount: math.callAmount,
    aggressive: context.decision.toAmount > context.currentBet,
    preflopUnraised:
      context.street === "preflop" && context.currentBet <= context.bigBlind,
    rulingNotes: context.rulingNotes,
  };
}
