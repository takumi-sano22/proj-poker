// Ability / Overall Score（docs/07 §2・D05・D34・D48・D103・D115）。Ability Evidence を ScoringPolicy で集計する。
// - Score は点数だけでなく Policy の Version・Confidence・Sample Size・Evidence IDs・Trend と一緒に返す
// - 対象の判断の数（M）と Review 済みの数（N）を必ず返す（D115）
// - Overall は Poker Decision だけ。Live Mechanics は別の Score（D48）
// - 都度計算し、保存しない（D111）
import {
  buildAbilityEvidence,
  type AbilityEvidence,
  type AbilityEvidenceOptions,
  type ScoreSource,
} from "./ability-evidence.js";
import {
  DEFAULT_SCORING_POLICY,
  type AbilityDimension,
  type ScoreConfidence,
  type ScoringPolicy,
  type TrendDirection,
} from "./scoring-policy.js";

export interface Trend {
  readonly direction: TrendDirection;
  /** 直近 window 件の Score。件数が足りなければ null。 */
  readonly recentScore: number | null;
  /** その前の window 件の Score。件数が足りなければ null。 */
  readonly previousScore: number | null;
  readonly window: number;
}

export interface ScoreValue {
  /** 0〜100（小数第 1 位まで）。集計に入る Evidence が無ければ null。 */
  readonly score: number | null;
  readonly confidence: ScoreConfidence;
  /** 集計に入った Evidence の数。 */
  readonly sampleSize: number;
  /** 集計に入った Ability Evidence の ID（判断の順）。 */
  readonly evidenceIds: readonly string[];
  readonly trend: Trend;
}

export interface AbilityScore extends ScoreValue {
  readonly ability: AbilityDimension;
}

export interface ScoreReport {
  readonly policyVersion: string;
  readonly heroId: string;
  readonly decisions: {
    /** 対象の判断の数（M）。 */
    readonly total: number;
    /** Pass A の Review がある判断の数（N）。 */
    readonly reviewed: number;
    /** N のうち、Poker Decision の集計に入った数（insufficient_evidence を除く）。 */
    readonly scored: number;
    /** N のうち、insufficient_evidence の数。 */
    readonly insufficientEvidence: number;
  };
  /** Poker Decision の Overall Score（Live Mechanics を含めない。D48）。 */
  readonly overall: ScoreValue;
  /** Policy の Ability の一覧の順。 */
  readonly abilities: readonly AbilityScore[];
  readonly evidence: readonly AbilityEvidence[];
}

export interface ScoreOptions extends AbilityEvidenceOptions {
  readonly policy?: ScoringPolicy;
}

/** Event Log と Pass A の Review から、Hero の Ability / Overall Score を計算する。同じ入力・同じ Policy からは同じ結果。 */
export function computeScoreReport(
  source: ScoreSource,
  options: ScoreOptions = {},
): ScoreReport {
  const policy = options.policy ?? DEFAULT_SCORING_POLICY;
  const set = buildAbilityEvidence(source, policy, options);
  const scores = scoreEvidence(set.evidence, policy);

  return {
    policyVersion: policy.version,
    heroId: source.heroId,
    decisions: {
      total: set.decisionCount,
      reviewed: set.reviewedCount,
      scored: scores.scored,
      insufficientEvidence: set.reviewedCount - scores.scored,
    },
    overall: scores.overall,
    abilities: scores.abilities,
    evidence: set.evidence,
  };
}

/** Ability Evidence の列（判断の順）の集計。Player Profile の Recent / Long-term（#114）も同じ集計を使う。 */
export interface EvidenceScores {
  /** Poker Decision の集計に入った数（insufficient_evidence を除く）。 */
  readonly scored: number;
  readonly overall: ScoreValue;
  readonly abilities: readonly AbilityScore[];
}

/** Ability Evidence の列を Policy で集計する。同じ列・同じ Policy からは同じ結果。 */
export function scoreEvidence(
  evidence: readonly AbilityEvidence[],
  policy: ScoringPolicy,
): EvidenceScores {
  const scored = evidence.filter((e) => e.points !== null);

  const abilities = policy.abilities.map((ability): AbilityScore => {
    if (ability === "live_mechanics") {
      // Live Mechanics は Assessment を使わないので、insufficient_evidence の判断も数える。裁定は決定論なので Weight は 1。
      return {
        ability,
        ...aggregate(
          evidence.map((e) => ({
            id: e.id,
            points: e.liveMechanics.points,
            weight: 1,
          })),
          policy,
        ),
      };
    }
    const items = scored.flatMap((e) =>
      e.abilities
        .filter((a) => a.ability === ability)
        .map((a) => ({
          id: e.id,
          points: e.points as number,
          weight: e.confidenceWeight * a.weight,
        })),
    );
    return { ability, ...aggregate(items, policy) };
  });

  return {
    scored: scored.length,
    overall: aggregate(
      scored.map((e) => ({
        id: e.id,
        points: e.points as number,
        weight: e.confidenceWeight,
      })),
      policy,
    ),
    abilities,
  };
}

interface WeightedPoints {
  readonly id: string;
  readonly points: number;
  readonly weight: number;
}

/** Weight 付きの平均と、その Confidence・Trend。items は判断の順。 */
function aggregate(
  items: readonly WeightedPoints[],
  policy: ScoringPolicy,
): ScoreValue {
  const { window, minDelta } = policy.trend;
  let trend: Trend = {
    direction: "insufficient",
    recentScore: null,
    previousScore: null,
    window,
  };
  if (items.length >= window * 2) {
    const recentScore = weightedMean(items.slice(-window));
    const previousScore = weightedMean(items.slice(-window * 2, -window));
    if (recentScore !== null && previousScore !== null) {
      const delta = recentScore - previousScore;
      trend = {
        direction:
          delta >= minDelta
            ? "improving"
            : delta <= -minDelta
              ? "declining"
              : "stable",
        recentScore,
        previousScore,
        window,
      };
    }
  }
  return {
    score: weightedMean(items),
    confidence: policy.scoreConfidence(items.length),
    sampleSize: items.length,
    evidenceIds: items.map((i) => i.id),
    trend,
  };
}

function weightedMean(items: readonly WeightedPoints[]): number | null {
  let sum = 0;
  let weights = 0;
  for (const i of items) {
    sum += i.points * i.weight;
    weights += i.weight;
  }
  if (weights === 0) return null;
  // 浮動小数の誤差で表示が揺れないよう、小数第 1 位で丸める。
  return Math.round((sum / weights) * 10) / 10;
}
