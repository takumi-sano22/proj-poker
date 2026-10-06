// Review Eval の指標の集計（docs/09 §6 の最小形）。数値はすべてここで機械的に出す（記憶で表を書かない。llm-quality-improvement 鉄則 8）。
// 決定論で数えられるものだけを扱う。Uncertainty の表現・Assumption を変えたときの Recommendation の変わり方は Judge（人間か LLM）が
// 要るので、ここでは測らない（docs/09 §6 に未測定と書く）。
import type { ReviewEvalRecord } from "./harness.js";

export interface ReviewEvalSummary {
  /** Review した判断の数（判断 × 繰り返し）。 */
  readonly reviews: number;
  /** 呼び出しの数（Retry を含む。Gate で止めた判断は 0 回）。 */
  readonly calls: number;
  /** Structured Output Valid 率: 呼び出しのうち検証（schema・grounding）を通った割合。 */
  readonly structuredOutputValidRate: number;
  /** Retry 率: 判断のうち 1 回目が不正で再要求した割合。 */
  readonly retryRate: number;
  /** Fallback 率: 判断のうち 2 回続けて不正で Insufficient Evidence にした割合。 */
  readonly fallbackRate: number;
  /** Insufficient Evidence 率（Gate・Fallback・Review AI 自身の判断のすべて）。 */
  readonly insufficientRate: number;
  /** 障害（Claude の呼び出しの失敗）の数。障害が出た実行は録画しない。 */
  readonly outages: number;
  /** Hindsight Leak / Hidden Information: Evidence か Prompt に判断時点の Hero が知り得ない情報が入っていた判断の数。1 件でも不合格。 */
  readonly hindsightLeaks: number;
  /** Math Grounding 率: Review AI が書いた判断のうち、Math Evidence の id を根拠に挙げた割合。 */
  readonly mathGroundingRate: number;
  /** KB Grounding 率: Review AI が書いた判断のうち、KB の項目（実在する id）を 1 つ以上根拠に挙げた割合。 */
  readonly kbGroundingRate: number;
  /** "Exact GTO" / "厳密な GTO" を含む説明の数（否定の文脈でも数える。表示だけで人が読んで確かめる）。 */
  readonly exactGtoMentions: number;
  readonly latencyMs: {
    readonly min: number;
    readonly median: number;
    readonly p90: number;
    readonly max: number;
  };
  /** 判断 → 段階評価 → 回数。 */
  readonly assessmentCounts: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  /** 判断 → Solver Evidence の状態。 */
  readonly solverStatus: Readonly<Record<string, string>>;
  readonly invalidOutputs: readonly string[];
  readonly leaks: readonly string[];
}

export interface ReviewEvalPopulation {
  readonly cases: readonly string[];
  readonly repeats: number;
}

/**
 * 集計の入口ガード（llm ガイダンス 7）: 判断の数が母集団とちょうど一致し、各判断がちょうど 1 回ずつあること。
 * 欠けた判断を黙って除外すると率が静かに崩れるので、合わなければ例外にする。
 */
export function assertReviewPopulation(
  records: readonly { readonly caseId: string; readonly repeat: number }[],
  population: ReviewEvalPopulation,
): void {
  const expected = new Set<string>();
  for (const c of population.cases) {
    for (let r = 1; r <= population.repeats; r++) expected.add(`${c}#${r}`);
  }
  const actual = records.map((r) => `${r.caseId}#${r.repeat}`);
  const duplicated = actual.filter((k, i) => actual.indexOf(k) !== i);
  const missing = [...expected].filter((k) => !actual.includes(k));
  const unknown = actual.filter((k) => !expected.has(k));
  if (duplicated.length + missing.length + unknown.length > 0) {
    throw new Error(
      `母集団と一致しない: 重複 ${duplicated.join(", ") || "なし"} / 欠け ${missing.join(", ") || "なし"} / 余分 ${unknown.join(", ") || "なし"}`,
    );
  }
}

export function summarizeReviewEval(
  records: readonly ReviewEvalRecord[],
  population: ReviewEvalPopulation,
): ReviewEvalSummary {
  assertReviewPopulation(records, population);
  const attempts = records.flatMap((r) => r.attempts);
  const reviews = records.length;
  const byAi = records.filter(
    (r) => r.final.kind === "review" && r.final.generatedBy === "review_ai",
  );
  const cited = (r: ReviewEvalRecord) =>
    r.final.kind === "review" ? r.final.cited : [];
  const assessmentCounts: Record<string, Record<string, number>> = {};
  const solverStatus: Record<string, string> = {};
  for (const r of records) {
    solverStatus[r.caseId] = r.solverStatus;
    if (r.final.kind !== "review") continue;
    const counts = (assessmentCounts[r.caseId] ??= {});
    counts[r.final.assessment] = (counts[r.final.assessment] ?? 0) + 1;
  }
  const ms = attempts.map((a) => a.ms);
  return {
    reviews,
    calls: attempts.length,
    structuredOutputValidRate: rate(
      attempts.filter((a) => a.check.ok).length,
      attempts.length,
    ),
    retryRate: rate(
      records.filter((r) => r.attempts.length >= 2).length,
      reviews,
    ),
    fallbackRate: rate(
      records.filter(
        (r) =>
          r.final.kind === "review" &&
          r.final.generatedBy === "invalid_output_fallback",
      ).length,
      reviews,
    ),
    insufficientRate: rate(
      records.filter(
        (r) =>
          r.final.kind === "review" &&
          r.final.assessment === "insufficient_evidence",
      ).length,
      reviews,
    ),
    outages: records.filter((r) => r.final.kind === "outage").length,
    hindsightLeaks: records.filter((r) => r.leaks.length > 0).length,
    mathGroundingRate: rate(
      byAi.filter((r) => cited(r).some((id) => id.startsWith("math:"))).length,
      byAi.length,
    ),
    kbGroundingRate: rate(
      byAi.filter((r) => cited(r).some((id) => id.startsWith("kb:"))).length,
      byAi.length,
    ),
    exactGtoMentions: records.filter(
      (r) =>
        r.final.kind === "review" &&
        /exact\s*gto|厳密な\s*GTO/i.test(r.final.text),
    ).length,
    latencyMs: {
      min: quantile(ms, 0),
      median: quantile(ms, 0.5),
      p90: quantile(ms, 0.9),
      max: quantile(ms, 1),
    },
    assessmentCounts,
    solverStatus,
    invalidOutputs: records.flatMap((r) =>
      r.attempts.flatMap((a, i) =>
        a.check.ok
          ? []
          : [
              `${r.caseId}#${r.repeat}#${i + 1}: ${a.check.stage}: ${a.check.reason}`,
            ],
      ),
    ),
    leaks: records.flatMap((r) =>
      r.leaks.map((l) => `${r.caseId}#${r.repeat}: ${l}`),
    ),
  };
}

/**
 * 合格ライン（暫定。docs/09 §6）。測定の前に決めて固定する（llm-quality-improvement 鉄則 2）。
 * Hindsight Leak と障害は 1 件でも不合格（鉄則 5）。それ以外は今の Prompt の目安で、Review の運用を見て見直す。
 */
export const REVIEW_EVAL_TARGETS = {
  hindsightLeaks: 0,
  outages: 0,
  minStructuredOutputValidRate: 0.9,
  maxFallbackRate: 0.05,
  minMathGroundingRate: 0.9,
  minKbGroundingRate: 0.5,
} as const;

/** 合格ラインに届かなかった指標の一覧（空なら合格）。 */
export function unmetReviewTargets(summary: ReviewEvalSummary): string[] {
  const t = REVIEW_EVAL_TARGETS;
  const unmet: string[] = [];
  if (summary.hindsightLeaks > t.hindsightLeaks) unmet.push("hindsightLeaks");
  if (summary.outages > t.outages) unmet.push("outages");
  if (summary.structuredOutputValidRate < t.minStructuredOutputValidRate)
    unmet.push("structuredOutputValidRate");
  if (summary.fallbackRate > t.maxFallbackRate) unmet.push("fallbackRate");
  if (summary.mathGroundingRate < t.minMathGroundingRate)
    unmet.push("mathGroundingRate");
  if (summary.kbGroundingRate < t.minKbGroundingRate)
    unmet.push("kbGroundingRate");
  return unmet;
}

function rate(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 1000;
}

/** 最近傍順位の分位点（0 件なら 0）。 */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[index] as number;
}
