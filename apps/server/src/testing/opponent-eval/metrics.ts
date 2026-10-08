// AI Opponent Eval の指標の集計（docs/09 §5）。数値はすべてここで機械的に出す（記憶で表を書かない。llm-quality-improvement 鉄則 8）。
// 決定論で数えられるものだけを扱う。Strategic Incoherence は Judge（人間か LLM）が要るので、ここでは測らない（docs/09 §5 に未測定と書く）。
import type { PlayerAction } from "@proj-poker/engine";
import type { PersonaPresetId } from "../../opponents/persona.js";
import type { EvalCase, EvalRecord } from "./harness.js";

type ActionType = PlayerAction["type"];
const ACTION_TYPES: readonly ActionType[] = [
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "all_in",
];

export interface OpponentEvalSummary {
  /** 判断の数（Spot × Persona × 繰り返し）。 */
  readonly decisions: number;
  /** 呼び出しの数（Retry を含む）。 */
  readonly calls: number;
  /** Structured Output Valid 率: 呼び出しのうち Schema の検証を通った割合。 */
  readonly structuredOutputValidRate: number;
  /** Illegal Action 率: 呼び出しのうち Schema は通ったが、今選べない Action・範囲外の額・Engine の拒否だった割合。 */
  readonly illegalActionRate: number;
  /** Retry 率: 判断のうち 1 回目が不正で再要求した割合。 */
  readonly retryRate: number;
  /** Fallback 率: 判断のうち 2 回続けて不正で、本番なら RuleBot の Fallback になる割合。 */
  readonly fallbackRate: number;
  /** 障害（例外）の数。録画には障害の判断を残さない（障害が出た実行は録画しない）。 */
  readonly outages: number;
  /** Hidden Information Leakage: CPU の入力か Prompt に、知ってはいけない情報が入っていた判断の数。1 件でも不合格。 */
  readonly hiddenInformationLeakage: number;
  /** 呼び出しごとの所要時間（ミリ秒。子プロセスの起動を含む）。 */
  readonly latencyMs: {
    readonly min: number;
    readonly median: number;
    readonly p90: number;
    readonly max: number;
  };
  /**
   * Persona Differentiation: Spot ごとに、Persona の組の最終 Action の分布の差（Total Variation Distance。0〜1）を平均し、
   * さらに Spot で平均したもの。0 なら全 Persona が同じ選び方、1 なら組ごとに全く違う選び方。
   */
  readonly personaDifferentiation: number;
  /** Spot ごとの Persona Differentiation。 */
  readonly personaDifferentiationBySpot: Readonly<Record<string, number>>;
  /**
   * Action Diversity: Persona ごとに、全 Spot の最終 Action の種類の Shannon Entropy（bit）。
   * 0 ならどの局面でも同じ種類しか選ばない。
   */
  readonly actionDiversity: Readonly<Record<string, number>>;
  /** Persona → Spot → 最終 Action の種類 → 回数（Claude の判断だけ。Fallback・障害は数えない）。 */
  readonly actionCounts: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>
  >;
  /** 不正だった呼び出しの一覧（"Spot/Persona/何回目#呼び出し: 段: 理由"）。 */
  readonly invalidOutputs: readonly string[];
  /** 漏れの一覧（"Spot/Persona/何回目: 箇所"）。 */
  readonly leaks: readonly string[];
}

export interface EvalPopulation {
  readonly spots: readonly string[];
  readonly personas: readonly PersonaPresetId[];
  readonly repeats: number;
}

/**
 * 集計の入口ガード（llm ガイダンス 7）: 判断の数が母集団とちょうど一致し、各判断がちょうど 1 回ずつあること。
 * 欠けた判断を黙って除外すると Persona 間の比較が静かに崩れるので、合わなければ例外にする。
 */
export function assertPopulation(
  records: readonly EvalCase[],
  population: EvalPopulation,
): void {
  const expected = new Set<string>();
  for (const spot of population.spots) {
    for (const persona of population.personas) {
      for (let r = 1; r <= population.repeats; r++) {
        expected.add(caseKey({ spotId: spot, personaId: persona, repeat: r }));
      }
    }
  }
  const actual = records.map(caseKey);
  const duplicated = actual.filter((k, i) => actual.indexOf(k) !== i);
  const missing = [...expected].filter((k) => !actual.includes(k));
  const unknown = actual.filter((k) => !expected.has(k));
  if (duplicated.length + missing.length + unknown.length > 0) {
    throw new Error(
      `母集団と一致しない: 重複 ${duplicated.join(", ") || "なし"} / 欠け ${missing.join(", ") || "なし"} / 余分 ${unknown.join(", ") || "なし"}`,
    );
  }
}

export function caseKey(c: EvalCase): string {
  return `${c.spotId}/${c.personaId}/${c.repeat}`;
}

/** 判断の記録から指標を出す。母集団と一致しなければ例外。 */
export function summarizeOpponentEval(
  records: readonly EvalRecord[],
  population: EvalPopulation,
): OpponentEvalSummary {
  assertPopulation(records, population);
  const attempts = records.flatMap((r) => r.attempts);
  const calls = attempts.length;
  const schemaInvalid = attempts.filter(
    (a) => !a.check.ok && a.check.stage === "schema",
  ).length;
  const illegal = attempts.filter(
    (a) => !a.check.ok && a.check.stage !== "schema",
  ).length;
  const decisions = records.length;

  const actionCounts: Record<
    string,
    Record<string, Record<string, number>>
  > = {};
  for (const persona of population.personas) {
    const bySpot: Record<string, Record<string, number>> = {};
    for (const spot of population.spots) bySpot[spot] = {};
    actionCounts[persona] = bySpot;
  }
  for (const r of records) {
    if (r.final.kind !== "claude") continue;
    const bySpot = actionCounts[r.personaId]?.[r.spotId];
    if (bySpot === undefined) continue;
    bySpot[r.final.action.type] = (bySpot[r.final.action.type] ?? 0) + 1;
  }

  const personaDifferentiationBySpot: Record<string, number> = {};
  for (const spot of population.spots) {
    const distributions = population.personas
      .map((p) => actionCounts[p]?.[spot] ?? {})
      .filter((counts) => total(counts) > 0);
    personaDifferentiationBySpot[spot] = round(
      meanPairwiseDistance(distributions),
    );
  }
  const actionDiversity: Record<string, number> = {};
  for (const persona of population.personas) {
    const merged: Record<string, number> = {};
    for (const counts of Object.values(actionCounts[persona] ?? {})) {
      for (const [type, n] of Object.entries(counts)) {
        merged[type] = (merged[type] ?? 0) + n;
      }
    }
    actionDiversity[persona] = round(entropy(merged));
  }

  const ms = attempts.map((a) => a.ms);
  return {
    decisions,
    calls,
    structuredOutputValidRate: rate(calls - schemaInvalid, calls),
    illegalActionRate: rate(illegal, calls),
    retryRate: rate(
      records.filter((r) => r.attempts.length >= 2).length,
      decisions,
    ),
    fallbackRate: rate(
      records.filter((r) => r.final.kind === "fallback").length,
      decisions,
    ),
    outages: records.filter((r) => r.final.kind === "outage").length,
    hiddenInformationLeakage: records.filter((r) => r.leaks.length > 0).length,
    latencyMs: {
      min: quantile(ms, 0),
      median: quantile(ms, 0.5),
      p90: quantile(ms, 0.9),
      max: quantile(ms, 1),
    },
    personaDifferentiation: round(
      mean(Object.values(personaDifferentiationBySpot)),
    ),
    personaDifferentiationBySpot,
    actionDiversity,
    actionCounts,
    invalidOutputs: records.flatMap((r) =>
      r.attempts.flatMap((a, i) =>
        a.check.ok
          ? []
          : [`${caseKey(r)}#${i + 1}: ${a.check.stage}: ${a.check.reason}`],
      ),
    ),
    leaks: records.flatMap((r) => r.leaks.map((l) => `${caseKey(r)}: ${l}`)),
  };
}

/**
 * 合格ライン（暫定。docs/09 §5）。測定の前に決めて固定する（llm-quality-improvement 鉄則 2）。
 * Hidden Information Leakage と障害は 1 件でも不合格（鉄則 5）。それ以外は今の Persona・Prompt の目安で、Playtest で見直す。
 */
export const OPPONENT_EVAL_TARGETS = {
  hiddenInformationLeakage: 0,
  outages: 0,
  minStructuredOutputValidRate: 0.95,
  maxIllegalActionRate: 0.05,
  maxRetryRate: 0.1,
  maxFallbackRate: 0.02,
  minPersonaDifferentiation: 0.2,
} as const;

/** 合格ラインに届かなかった指標（空なら全部届いた）。 */
export function unmetTargets(summary: OpponentEvalSummary): string[] {
  const t = OPPONENT_EVAL_TARGETS;
  const unmet: string[] = [];
  if (summary.hiddenInformationLeakage > t.hiddenInformationLeakage) {
    unmet.push(
      `Hidden Information Leakage ${summary.hiddenInformationLeakage} 件`,
    );
  }
  if (summary.outages > t.outages) unmet.push(`障害 ${summary.outages} 件`);
  if (summary.structuredOutputValidRate < t.minStructuredOutputValidRate) {
    unmet.push(
      `Structured Output Valid 率 ${summary.structuredOutputValidRate} < ${t.minStructuredOutputValidRate}`,
    );
  }
  if (summary.illegalActionRate > t.maxIllegalActionRate) {
    unmet.push(
      `Illegal Action 率 ${summary.illegalActionRate} > ${t.maxIllegalActionRate}`,
    );
  }
  if (summary.retryRate > t.maxRetryRate) {
    unmet.push(`Retry 率 ${summary.retryRate} > ${t.maxRetryRate}`);
  }
  if (summary.fallbackRate > t.maxFallbackRate) {
    unmet.push(`Fallback 率 ${summary.fallbackRate} > ${t.maxFallbackRate}`);
  }
  if (summary.personaDifferentiation < t.minPersonaDifferentiation) {
    unmet.push(
      `Persona Differentiation ${summary.personaDifferentiation} < ${t.minPersonaDifferentiation}`,
    );
  }
  return unmet;
}

function total(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/** 2 つの分布の Total Variation Distance（0〜1）。 */
export function distance(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): number {
  const ta = total(a);
  const tb = total(b);
  return (
    ACTION_TYPES.reduce(
      (sum, type) => sum + Math.abs((a[type] ?? 0) / ta - (b[type] ?? 0) / tb),
      0,
    ) / 2
  );
}

export function meanPairwiseDistance(
  distributions: readonly Readonly<Record<string, number>>[],
): number {
  const values: number[] = [];
  for (let i = 0; i < distributions.length; i++) {
    for (let j = i + 1; j < distributions.length; j++) {
      values.push(
        distance(
          distributions[i] as Record<string, number>,
          distributions[j] as Record<string, number>,
        ),
      );
    }
  }
  return mean(values);
}

/** Shannon Entropy（bit）。Σ p·log2(1/p) の形で足し、-0 を出さない。 */
export function entropy(counts: Readonly<Record<string, number>>): number {
  const t = total(counts);
  if (t === 0) return 0;
  return Object.values(counts)
    .filter((n) => n > 0)
    .reduce((sum, n) => sum + (n / t) * Math.log2(t / n), 0);
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((a, b) => a + b, 0) / values.length;
}

function rate(n: number, d: number): number {
  return d === 0 ? 0 : round(n / d);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 昇順に並べた値の分位点（claude-smoke と同じ定義）。値が無ければ 0。 */
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0,
  );
}
