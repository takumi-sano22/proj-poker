// Session Review（docs/07 §6・docs/06 §14・D16・D32・D34・D49・D111・D115・D116）。1 Session の Hand から、Session の終わりに
// 見る振り返りを都度計算する（保存しない。D111）。
// - Decision Quality Summary と Score は Pass A の Review がある判断だけで計算し、対象の判断の数（M）と Review 済みの数（N）を必ず返す。
//   Review を作る経路は持たない（D115: 自動・一括の Review をしない）
// - 収支は実額（Hero の Stack の差）を正本にし、BB は表示側の補助（D49）。収支で Score・Strength / Leak を決めない（結果論にしない）
// - Important Hands は判断時点の Hero Information Set から選んだ Important Spot（#78）と、Pass A の段階評価だけで選ぶ（結果を見ない）
// - Stats は Hero の行だけを返す（他 Player の詳細 HUD を出さない。D32）。入力は public の Event だけ（stats.ts）
// - Hidden Persona・CPU の Private な状態・他者の Hidden Cards・Pass B（Learning-only Reveal）は入力にも応答にも入れない
// - Drill の Hand は excludeHandIds で除く（D116。呼び出し側が drills テーブルの Hand を渡す）
import {
  extractImportantSpots,
  heroInformationSets,
  projectHeroView,
  projectPlayerStats,
  visibleEvents,
  type ActionType,
  type Card,
  type HandEvent,
  type ImportantSpotReason,
  type PlayerStats,
  type StatTable,
  type Street,
} from "@proj-poker/engine";
import { isHandEnd } from "../event-store.js";
import type { Assessment, Confidence } from "../review/types.js";
import type { AbilityEvidence, ScoreSource } from "./ability-evidence.js";
import {
  computeScoreReport,
  type AbilityScore,
  type ScoreReport,
  type ScoreValue,
} from "./score.js";
import {
  DEFAULT_SCORING_POLICY,
  type ScoringPolicy,
} from "./scoring-policy.js";

/** Session Review の選び方（Strength / Leak・Important Hands）。値はすべて OI-006 の暫定値で、変えるときは Version を足す。 */
export interface SessionReviewPolicy {
  readonly version: string;
  /** Strength に入れる Pass A の段階評価。 */
  readonly strengthAssessments: readonly Assessment[];
  /** Leak に入れる Pass A の段階評価（重い順。Recommended Drill の候補の順にも使う）。 */
  readonly leakAssessments: readonly Assessment[];
  /** Important Hands に出す Hand の上限。 */
  readonly maxImportantHands: number;
}

/**
 * phase6_session_review_v1（OI-006 の暫定値）。Strength は strong、Leak は major_leak / improvement_suggested の判断。
 * reasonable・mixed_marginal は「強み・弱み」と言い切れないので、どちらにも入れない。Important Hands は 5 Hand まで。
 */
export const PHASE6_SESSION_REVIEW_V1: SessionReviewPolicy = {
  version: "phase6_session_review_v1",
  strengthAssessments: ["strong"],
  leakAssessments: ["major_leak", "improvement_suggested"],
  maxImportantHands: 5,
};

export const DEFAULT_SESSION_REVIEW_POLICY = PHASE6_SESSION_REVIEW_V1;

/** Session の 1 Hand（Event と記録時刻）。Hand は保存の古い順（論理順序。D117）に渡す。時刻は表示用。 */
export interface SessionHandRecord {
  readonly handId: string;
  readonly events: readonly HandEvent[];
  /** Hand の最初の Event を記録した時刻（ISO 8601・UTC）。 */
  readonly startedAt: string;
  /** Hand の最後の Event を記録した時刻（ISO 8601・UTC）。 */
  readonly endedAt: string;
}

/** Strength / Leak に出す判断 1 つ（Pass A の Review の段階評価と、判断時点の特徴だけ）。 */
export interface SessionDecisionRef {
  readonly handId: string;
  /** Session の中の Hand の番号（1 始まり）。 */
  readonly handNumber: number;
  readonly decisionIndex: number;
  readonly street: Street;
  readonly action: ActionType;
  readonly assessment: Assessment;
  readonly confidence: Confidence;
  /** 使った Review の Version（D115: 判断ごとの最新）。 */
  readonly reviewVersion: number;
}

/** Important Hands の 1 行（結果を見ずに選ぶ）。 */
export interface SessionImportantHand {
  readonly handId: string;
  readonly handNumber: number;
  /** Hero の札（配られる前に打ち切った Hand は null）。 */
  readonly heroHoleCards: readonly Card[] | null;
  /** この Hand の Important Spot の理由（重ならないよう、Important Spot の順に集める）。 */
  readonly reasons: readonly ImportantSpotReason[];
  readonly importantSpotCount: number;
  /** この Hand の Hero の判断の数と、Pass A の Review がある数。 */
  readonly decisions: { readonly total: number; readonly reviewed: number };
  readonly leakCount: number;
  readonly strengthCount: number;
}

export interface SessionReview {
  readonly policyVersion: string;
  readonly scoringPolicyVersion: string;
  /** Session の終わった Hand の数（打ち切った Hand を含む。除外した Hand は数えない）。 */
  readonly hands: number;
  /** 最初の Hand の開始・最後の Hand の終わりの時刻と、その差（ミリ秒）。Hand が無ければ null。 */
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  /** BB 補助表示の基準（最後の Hand の BB）。Hand が無ければ null。 */
  readonly bigBlind: number | null;
  /** Hero の収支（実額。HAND_FINISHED の Stack − HAND_STARTED の Stack の和。打ち切った Hand は Chip が動かないので 0）。 */
  readonly heroNet: number;
  /** Decision Quality Summary（Pass A の Review 済みの判断だけ。D115）。 */
  readonly decisionQuality: {
    /** 対象の判断の数（M）。 */
    readonly total: number;
    /** Pass A の Review がある判断の数（N）。 */
    readonly reviewed: number;
    readonly scored: number;
    readonly insufficientEvidence: number;
    /** 段階評価ごとの判断の数（N の内訳）。 */
    readonly assessments: Readonly<Record<Assessment, number>>;
    /** Poker Decision の Overall（Live Mechanics を含めない。D48）。 */
    readonly overall: ScoreValue;
  };
  readonly abilities: readonly AbilityScore[];
  readonly strengths: readonly SessionDecisionRef[];
  readonly leaks: readonly SessionDecisionRef[];
  readonly importantHands: readonly SessionImportantHand[];
  /** Hero の Stats（他 Player の行は返さない）。 */
  readonly heroStats: {
    readonly version: string;
    readonly hands: number;
    readonly overall: StatTable | null;
  };
  /**
   * Recommended Drill の入口（D116・#117）。候補は Leak の最初の判断（Pass A の Review がある判断）。候補があれば、その判断から
   * Drill を始められる（POST /api/drills。Drill の Hand は通常の集計から除く）。
   */
  readonly recommendedDrill: {
    readonly available: boolean;
    readonly candidate: SessionDecisionRef | null;
  };
}

export interface SessionReviewOptions {
  readonly policy?: SessionReviewPolicy;
  readonly scoringPolicy?: ScoringPolicy;
  /** 集計から除く Hand（D116: Drill の Hand）。 */
  readonly excludeHandIds?: ReadonlySet<string>;
}

const ASSESSMENTS: readonly Assessment[] = [
  "strong",
  "reasonable",
  "mixed_marginal",
  "improvement_suggested",
  "major_leak",
  "insufficient_evidence",
];

/** 1 Session の Hand（保存の古い順。D117）と Pass A の Review から Session Review を作る。同じ入力からは同じ結果。 */
export function computeSessionReview(
  hands: readonly SessionHandRecord[],
  reviews: ScoreSource["reviews"],
  heroId: string,
  options: SessionReviewOptions = {},
): SessionReview {
  const policy = options.policy ?? DEFAULT_SESSION_REVIEW_POLICY;
  const scoringPolicy = options.scoringPolicy ?? DEFAULT_SCORING_POLICY;
  const exclude = options.excludeHandIds ?? new Set<string>();
  // Review を作れるのと同じ条件（終わった Hand）だけを Session の Hand として数える。除外した Hand は番号も振らない。
  const included = hands.filter(
    (h) => !exclude.has(h.handId) && h.events.some(isHandEnd),
  );
  const handNumbers = new Map(included.map((h, i) => [h.handId, i + 1]));

  const report = computeScoreReport(
    { hands: included.map((h) => h.events), reviews, heroId },
    { policy: scoringPolicy },
  );
  const refs = report.evidence.map((e) => toDecisionRef(e, handNumbers));
  const strengthSet = new Set(policy.strengthAssessments);
  const strengths = refs.filter((r) => strengthSet.has(r.assessment));
  // Leak は重い段階評価を先に、同じ段階評価の中は判断の順。
  const leaks = policy.leakAssessments.flatMap((a) =>
    refs.filter((r) => r.assessment === a),
  );

  const stats = projectPlayerStats(included.map((h) => h.events));
  const hero = stats.players.find((p: PlayerStats) => p.playerId === heroId);

  const first = included[0];
  const last = included.at(-1);
  return {
    policyVersion: policy.version,
    scoringPolicyVersion: report.policyVersion,
    hands: included.length,
    startedAt: first?.startedAt ?? null,
    endedAt: last?.endedAt ?? null,
    // 表示だけの値で、順序の判定には使わない（D117）。壁時計が後ろへ戻って差が負になったときは 0 にする。
    durationMs:
      first === undefined || last === undefined
        ? null
        : Math.max(0, Date.parse(last.endedAt) - Date.parse(first.startedAt)),
    bigBlind: last === undefined ? null : bigBlindOf(last.events),
    heroNet: included.reduce((sum, h) => sum + heroNetOf(h.events, heroId), 0),
    decisionQuality: {
      ...report.decisions,
      assessments: countAssessments(report),
      overall: report.overall,
    },
    abilities: report.abilities,
    strengths,
    leaks,
    importantHands: importantHands(included, report, heroId, policy),
    heroStats: {
      version: stats.version,
      hands: hero?.hands ?? 0,
      overall: hero?.overall ?? null,
    },
    recommendedDrill: {
      available: leaks[0] !== undefined,
      candidate: leaks[0] ?? null,
    },
  };
}

function toDecisionRef(
  e: AbilityEvidence,
  handNumbers: ReadonlyMap<string, number>,
): SessionDecisionRef {
  return {
    handId: e.handId,
    handNumber: handNumbers.get(e.handId) ?? 0,
    decisionIndex: e.decisionIndex,
    street: e.features.street,
    action: e.features.action,
    assessment: e.assessment,
    confidence: e.confidence,
    reviewVersion: e.reviewVersion,
  };
}

function countAssessments(
  report: ScoreReport,
): Readonly<Record<Assessment, number>> {
  const counts = Object.fromEntries(ASSESSMENTS.map((a) => [a, 0])) as Record<
    Assessment,
    number
  >;
  for (const e of report.evidence) counts[e.assessment]++;
  return counts;
}

/**
 * Important Hands: Important Spot（判断時点の情報だけで選ぶ。#78）か、Leak / Strength の判断がある Hand。
 * Leak の多い Hand → Important Spot の多い Hand → Hand の順に並べ、上限で切る。収支（結果）では選ばない。
 */
function importantHands(
  hands: readonly SessionHandRecord[],
  report: ScoreReport,
  heroId: string,
  policy: SessionReviewPolicy,
): SessionImportantHand[] {
  const leakSet = new Set(policy.leakAssessments);
  const strengthSet = new Set(policy.strengthAssessments);
  const candidates = hands.flatMap((h, i): SessionImportantHand[] => {
    const evidence = report.evidence.filter((e) => e.handId === h.handId);
    const sets = heroInformationSets(h.events, heroId);
    const spots = extractImportantSpots(sets);
    const leakCount = evidence.filter((e) => leakSet.has(e.assessment)).length;
    const strengthCount = evidence.filter((e) =>
      strengthSet.has(e.assessment),
    ).length;
    if (spots.length === 0 && leakCount === 0 && strengthCount === 0) {
      return [];
    }
    const reasons: ImportantSpotReason[] = [];
    for (const r of spots.flatMap((s) => s.reasons)) {
      if (!reasons.includes(r)) reasons.push(r);
    }
    return [
      {
        handId: h.handId,
        handNumber: i + 1,
        heroHoleCards: heroHoleCardsOf(h.events, heroId),
        reasons,
        importantSpotCount: spots.length,
        decisions: {
          total: sets.length,
          reviewed: evidence.length,
        },
        leakCount,
        strengthCount,
      },
    ];
  });
  return candidates
    .sort(
      (a, b) =>
        b.leakCount - a.leakCount ||
        b.importantSpotCount - a.importantSpotCount ||
        a.handNumber - b.handNumber,
    )
    .slice(0, policy.maxImportantHands);
}

/** Hero の収支（実額）。HAND_FINISHED の無い Hand（打ち切り）は Chip が動かないので 0。 */
function heroNetOf(events: readonly HandEvent[], heroId: string): number {
  let before: number | undefined;
  let after: number | undefined;
  for (const e of events) {
    if (e.type === "HAND_STARTED") {
      before = e.seats.find((s) => s.playerId === heroId)?.stack;
    } else if (e.type === "HAND_FINISHED") {
      after = e.stacks.find((s) => s.playerId === heroId)?.amount;
    }
  }
  return before === undefined || after === undefined ? 0 : after - before;
}

function bigBlindOf(events: readonly HandEvent[]): number | null {
  const started = events.find((e) => e.type === "HAND_STARTED");
  return started?.type === "HAND_STARTED" ? started.bigBlind : null;
}

/** Hero の札（Hero に見える Event だけから読む）。 */
function heroHoleCardsOf(
  events: readonly HandEvent[],
  heroId: string,
): readonly Card[] | null {
  const view = projectHeroView(visibleEvents(events, heroId), heroId);
  return view.seats.find((s) => s.playerId === heroId)?.holeCards ?? null;
}
