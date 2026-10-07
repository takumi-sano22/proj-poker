// Weakness Hypothesis（docs/07 §5・docs/04 §7・D18・D104・D113）。Ability Evidence（Pass A の reviews の最新 Version）を
// HypothesisPolicy で type に分け、Supporting / Counter Evidence の ID から状態を決定論で決める。LLM を状態遷移の正本にしない。
// - 入力は Pass A だけ（Pass B の reveal_reviews は ScoreSource の型の上でも渡せない）。Review の無い判断は数えない（D115）
// - 同じ Evidence・同じ Policy からは同じ Hypothesis（ID も Evidence ID から決まる）
// - 保存は hypothesis-snapshot.ts の Snapshot（reviews から作り直せる派生データ。D113）
// ユーザーの弱点なので、CPU の KnowledgeState・Prompt・CPU Memory には渡さない（不変条件 2。learning-isolation.test.ts）。
import {
  buildAbilityEvidence,
  type AbilityEvidence,
  type AbilityEvidenceOptions,
  type ScoreSource,
} from "./ability-evidence.js";
import {
  DEFAULT_HYPOTHESIS_POLICY,
  type HypothesisPolicy,
  type HypothesisStatus,
  type HypothesisType,
} from "./hypothesis-policy.js";

export interface Hypothesis {
  /** `<Policy の Version>/<type>`。同じ Policy・同じ type なら同じ ID。 */
  readonly hypothesisId: string;
  readonly type: HypothesisType;
  readonly status: HypothesisStatus;
  /** 弱点を支持する Ability Evidence の ID（判断の順）。 */
  readonly supportingEvidenceIds: readonly string[];
  /** 弱点に反する Ability Evidence の ID（判断の順）。 */
  readonly counterEvidenceIds: readonly string[];
  /** 計算した HypothesisPolicy の Version（ScoringPolicy の Version もこれで決まる）。 */
  readonly policyVersion: string;
}

export interface HypothesisOptions extends AbilityEvidenceOptions {
  readonly policy?: HypothesisPolicy;
}

/** Event Log と Pass A の Review から、Hero の Weakness Hypothesis を作る。Hand は古い順に渡す（直近の窓をこの順で見る）。 */
export function buildHypotheses(
  source: ScoreSource,
  options: HypothesisOptions = {},
): readonly Hypothesis[] {
  const policy = options.policy ?? DEFAULT_HYPOTHESIS_POLICY;
  const set = buildAbilityEvidence(source, policy.scoringPolicy, options);
  return hypothesesFromEvidence(set.evidence, policy);
}

/**
 * Ability Evidence の列（判断の順）から Hypothesis を作る。Supporting Evidence が 1 件も無い type は Hypothesis にしない
 * （弱点の疑いが無い）。Policy の type の順に返す。
 */
export function hypothesesFromEvidence(
  evidence: readonly AbilityEvidence[],
  policy: HypothesisPolicy,
): readonly Hypothesis[] {
  const supporting = new Set(policy.supportingAssessments);
  const counter = new Set(policy.counterAssessments);
  // type ごとの判定に使う Evidence（判断の順）。true が Supporting、false が Counter。
  const byType = new Map<HypothesisType, { id: string; supports: boolean }[]>();
  for (const e of evidence) {
    // insufficient_evidence（点が無い）は Score と同じく数えない。
    if (e.points === null) continue;
    const supports = supporting.has(e.assessment);
    if (!supports && !counter.has(e.assessment)) continue;
    for (const type of policy.classify(e.features)) {
      const list = byType.get(type) ?? [];
      list.push({ id: e.id, supports });
      byType.set(type, list);
    }
  }

  const hypotheses: Hypothesis[] = [];
  for (const type of policy.types) {
    const items = byType.get(type) ?? [];
    const supportingIds = items.filter((i) => i.supports).map((i) => i.id);
    if (supportingIds.length === 0) continue;
    hypotheses.push({
      hypothesisId: `${policy.version}/${type}`,
      type,
      status: hypothesisStatus(
        items.map((i) => i.supports),
        policy,
      ),
      supportingEvidenceIds: supportingIds,
      counterEvidenceIds: items.filter((i) => !i.supports).map((i) => i.id),
      policyVersion: policy.version,
    });
  }
  return hypotheses;
}

/**
 * Supporting（true）/ Counter（false）の列（判断の順）から状態を決める。
 * 全体の Supporting の割合で strong / supported / suspected を決め、直近の窓で Supporting が減っていれば improving、
 * 無くなっていれば resolved にする（Counter Evidence で弱くなる）。
 */
export function hypothesisStatus(
  supports: readonly boolean[],
  policy: HypothesisPolicy,
): HypothesisStatus {
  const t = policy.thresholds;
  const n = supports.length;
  if (n < t.minSample) return "insufficient_data";

  const s = supports.filter(Boolean).length;
  // 窓より古い Evidence があるときだけ、直近の傾向を見る（窓だけでは「前より良くなった」と言えない）。
  const hasHistory = n > t.recentWindow;
  const recentSupporting = supports
    .slice(-t.recentWindow)
    .filter(Boolean).length;
  if (hasHistory && recentSupporting === 0) return "resolved";

  const rate = s / n;
  const level: HypothesisStatus =
    s >= t.strong.minSupporting && rate >= t.strong.minRate
      ? "strong"
      : s >= t.supported.minSupporting && rate >= t.supported.minRate
        ? "supported"
        : "suspected";
  if (
    level !== "suspected" &&
    hasHistory &&
    recentSupporting <= t.improvingMaxRecentSupporting
  ) {
    return "improving";
  }
  return level;
}
