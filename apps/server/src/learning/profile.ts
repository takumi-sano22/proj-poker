// Player Profile（docs/07 §4・D18・D104・D111）。Structured Profile が正本で、自然言語の Profile はそこからの決定論のテンプレート文。
// - 入力は Ability Evidence（Pass A の reviews の最新 Version だけ。Pass B は入れない）。Review 済みの判断だけを数える（D115）
// - Recent（直近の有効 Decision。数は Config の暫定値）と Long-term（全有効 Evidence）を分ける（D104）
// - 都度計算し、保存しない（D111）。Hypothesis は Snapshot を読まず、同じ Evidence から作る（Snapshot と同じ関数）
// - 自然言語は LLM を呼ばずにテンプレートで作り（API の課金経路を増やさない）、過去の自然言語を次の入力にしない
//   （renderProfileText は Structured Profile だけを受け取る）
// ユーザーの弱点なので、CPU の KnowledgeState・Prompt・CPU Memory には渡さない（不変条件 2。learning-isolation.test.ts）。
import {
  buildAbilityEvidence,
  type AbilityEvidenceOptions,
  type ScoreSource,
} from "./ability-evidence.js";
import { hypothesesFromEvidence, type Hypothesis } from "./hypothesis.js";
import {
  DEFAULT_HYPOTHESIS_POLICY,
  type HypothesisPolicy,
  type HypothesisStatus,
  type HypothesisType,
} from "./hypothesis-policy.js";
import { scoreEvidence, type AbilityScore, type ScoreValue } from "./score.js";
import type { AbilityDimension } from "./scoring-policy.js";

export interface ProfilePolicy {
  readonly version: string;
  /** Recent に入れる直近の有効 Decision の数。 */
  readonly recentDecisions: number;
  /** Hypothesis の Policy（Ability Evidence の ScoringPolicy もこれで決まる）。 */
  readonly hypothesisPolicy: HypothesisPolicy;
}

/**
 * phase6_profile_v1（D104。数値は OI-006 の暫定値）。有効 Decision は Pass A の Review がある判断（D115）。
 * Recent は直近 100 件。値を変えるときは Version を上げた Policy を足す。
 */
export const PHASE6_PROFILE_V1: ProfilePolicy = {
  version: "phase6_profile_v1",
  recentDecisions: 100,
  hypothesisPolicy: DEFAULT_HYPOTHESIS_POLICY,
};

export const DEFAULT_PROFILE_POLICY = PHASE6_PROFILE_V1;

/** Recent / Long-term の 1 つの区分。 */
export interface ProfileWindow {
  /** この区分に入った有効 Decision（Review 済みの判断）の数。 */
  readonly reviewed: number;
  /** そのうち Poker Decision の集計に入った数（insufficient_evidence を除く）。 */
  readonly scored: number;
  readonly overall: ScoreValue;
  readonly abilities: readonly AbilityScore[];
}

/** Structured Profile（正本）。同じ入力・同じ Policy からは同じ結果。 */
export interface StructuredProfile {
  readonly policyVersion: string;
  readonly hypothesisPolicyVersion: string;
  readonly scoringPolicyVersion: string;
  readonly heroId: string;
  /** 対象の判断の数（M）と Review 済みの数（N）（D115）。 */
  readonly decisions: { readonly total: number; readonly reviewed: number };
  /** 直近 window 件の有効 Decision。 */
  readonly recent: ProfileWindow & { readonly window: number };
  /** 全有効 Evidence。 */
  readonly longTerm: ProfileWindow;
  /** Long-term の Evidence から作った Weakness Hypothesis（Policy の type の順）。 */
  readonly hypotheses: readonly Hypothesis[];
}

export interface ProfileOptions extends AbilityEvidenceOptions {
  readonly policy?: ProfilePolicy;
}

/** Event Log と Pass A の Review から Structured Profile を作る。Hand は古い順に渡す。 */
export function computePlayerProfile(
  source: ScoreSource,
  options: ProfileOptions = {},
): StructuredProfile {
  const policy = options.policy ?? DEFAULT_PROFILE_POLICY;
  const hypothesisPolicy = policy.hypothesisPolicy;
  const scoringPolicy = hypothesisPolicy.scoringPolicy;
  const set = buildAbilityEvidence(source, scoringPolicy, options);
  // Evidence は判断の順なので、末尾の window 件が直近の有効 Decision（slice(-0) は全件になるので、始まりの位置で切る）。
  const recentEvidence = set.evidence.slice(
    Math.max(0, set.evidence.length - policy.recentDecisions),
  );

  const window = (evidence: typeof set.evidence): ProfileWindow => {
    const scores = scoreEvidence(evidence, scoringPolicy);
    return {
      reviewed: evidence.length,
      scored: scores.scored,
      overall: scores.overall,
      abilities: scores.abilities,
    };
  };

  return {
    policyVersion: policy.version,
    hypothesisPolicyVersion: hypothesisPolicy.version,
    scoringPolicyVersion: scoringPolicy.version,
    heroId: source.heroId,
    decisions: { total: set.decisionCount, reviewed: set.reviewedCount },
    recent: { ...window(recentEvidence), window: policy.recentDecisions },
    longTerm: window(set.evidence),
    hypotheses: hypothesesFromEvidence(set.evidence, hypothesisPolicy),
  };
}

const ABILITY_LABELS: Readonly<Record<AbilityDimension, string>> = {
  preflop: "Preflop",
  postflop: "Postflop",
  bet_sizing: "Bet Sizing",
  pot_equity_math: "Pot / Equity Math",
  range_reading: "Range Reading",
  opponent_adaptation: "Opponent Adaptation",
  position: "Position",
  live_mechanics: "Live Mechanics",
};

const TYPE_LABELS: Readonly<Record<HypothesisType, string>> = {
  preflop_unraised: "Preflop で誰も Raise していない場面",
  preflop_facing_raise: "Preflop で Raise に直面した場面",
  postflop_facing_bet: "Flop 以降で Bet に直面した場面",
  postflop_unbet: "Flop 以降で Bet に直面していない場面",
  bet_raise: "Bet / Raise で額を引き上げた判断",
};

const STATUS_LABELS: Readonly<Record<HypothesisStatus, string>> = {
  suspected: "疑い",
  supported: "裏付けあり",
  strong: "強い",
  improving: "改善中",
  resolved: "解消",
  insufficient_data: "データ不足",
};

/**
 * Structured Profile から自然言語の Profile を作る（決定論のテンプレート。LLM を呼ばない）。
 * 表示用の派生で、正本にも次の計算の入力にもしない（引数は Structured Profile だけ）。
 */
export function renderProfileText(profile: StructuredProfile): string {
  const lines = [
    `Review 済みの判断 ${profile.decisions.reviewed} 件（対象の判断 ${profile.decisions.total} 件中）から作った Profile です。`,
    `直近 ${profile.recent.reviewed} 件の Overall: ${scoreText(profile.recent.overall)}`,
    `全期間の Overall: ${scoreText(profile.longTerm.overall)}`,
  ];

  const improving = profile.longTerm.abilities
    .filter((a) => a.trend.direction === "improving")
    .map((a) => ABILITY_LABELS[a.ability]);
  if (improving.length > 0) {
    lines.push(`上向きの Ability: ${improving.join("、")}`);
  }

  const unresolved = profile.hypotheses.filter(
    (h) => h.status !== "resolved" && h.status !== "improving",
  );
  const easing = profile.hypotheses.filter(
    (h) => h.status === "resolved" || h.status === "improving",
  );
  lines.push(
    unresolved.length > 0
      ? `未解決の弱点の仮説: ${unresolved.map(hypothesisText).join("、")}`
      : "未解決の弱点の仮説: なし",
  );
  if (easing.length > 0) {
    lines.push(`改善・解消した仮説: ${easing.map(hypothesisText).join("、")}`);
  }
  return lines.join("\n");
}

function scoreText(value: ScoreValue): string {
  if (value.score === null) return "まだ数えられる判断がありません";
  return `${value.score} 点（Confidence ${value.confidence}・${value.sampleSize} 件）`;
}

function hypothesisText(h: Hypothesis): string {
  return `${TYPE_LABELS[h.type]}（${STATUS_LABELS[h.status]}・支持 ${h.supportingEvidenceIds.length} 件 / 反証 ${h.counterEvidenceIds.length} 件）`;
}
