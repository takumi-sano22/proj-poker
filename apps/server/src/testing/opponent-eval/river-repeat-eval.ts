// Memory 付き Prompt の Claude CPU の Eval の River の追加測定（#171・D126・docs/09 §5）。
// #155（D123）の初回は 1 条件・1 Persona に 1 判断しかなく、River の Call の割合が loose < tight（意図と逆）になったのが
// 少数標本の揺れかを確かめるため、river_facing_big_bet の 3 条件（baseline・loose・tight）× Persona 6 に repeat 2・3 を足す。
// 条件の組み立ては #155 と同じ（MEMORY_PROMPT_EVAL_SPOTS の River の分をそのまま使う）。D123 の録画は書き換えず、
// 追加分は別の録画（opponent-memory-prompt-river-repeat.json）に持ち、集計は D123 の録画の River の分（repeat 1）と合わせて repeat 3 で出す。
// 呼び出しの上限（D126）はここで定数にし、memory-prompt-eval の番人（createCallBudget）で超えて呼ばない。
import type { ActionType } from "@proj-poker/engine";
import type { PersonaPresetId } from "../../opponents/persona.js";
import type { EvalCase } from "./harness.js";
import {
  MEMORY_PROMPT_CONDITIONS,
  MEMORY_PROMPT_EVAL_PERSONAS,
  MEMORY_PROMPT_EVAL_REPEATS,
  MEMORY_PROMPT_EVAL_SPOTS,
  directionReport,
  memoryPromptSpotId,
  type DirectionRow,
  type MemoryPromptConditionId,
  type MemoryPromptEvalRecording,
} from "./memory-prompt-eval.js";
import type { OpponentEvalSummary } from "./metrics.js";
import type { RecordedCase } from "./recording.js";
import type { EvalSpot } from "./spots.js";

/** 追加で測る代表 Spot（D126 は River の 1 Spot だけ）。 */
export const RIVER_REPEAT_BASE_SPOT_ID = "river_facing_big_bet";

/** 呼び出しの上限（D126）。判断は Spot 1 × 条件 3 × Persona 6 × 追加 repeat 2、呼び出しは Retry を含めて判断の 2 倍。 */
export const RIVER_REPEAT_EVAL_LIMITS = {
  maxDecisions: 36,
  maxCalls: 72,
} as const;

/** D123 の録画の repeat（1）に続けて足す repeat の番号。合計の repeat はその最大値（3）。 */
export const RIVER_REPEAT_ADDED_REPEATS = [2, 3] as const;
export const RIVER_REPEAT_TOTAL_REPEATS = Math.max(
  ...RIVER_REPEAT_ADDED_REPEATS,
);

/** River の 3 条件の Spot（#155 と同じ組み立て。baseline は層なし、loose / tight は memory-eval の all_loose / all_tight）。 */
export const RIVER_REPEAT_SPOTS: readonly EvalSpot[] =
  MEMORY_PROMPT_EVAL_SPOTS.filter(
    (s) => s.baseSpotId === RIVER_REPEAT_BASE_SPOT_ID,
  );

export const RIVER_REPEAT_PERSONAS: readonly PersonaPresetId[] =
  MEMORY_PROMPT_EVAL_PERSONAS;

/** 追加分の判断かどうか（D123 の録画にある repeat 1 は呼ばない）。 */
export function isAddedRepeat(c: EvalCase): boolean {
  return (RIVER_REPEAT_ADDED_REPEATS as readonly number[]).includes(c.repeat);
}

/** 追加分の判断の一覧（Spot・Persona・repeat の順）。 */
export function riverRepeatCases(): EvalCase[] {
  return RIVER_REPEAT_SPOTS.flatMap((spot) =>
    RIVER_REPEAT_PERSONAS.flatMap((personaId) =>
      RIVER_REPEAT_ADDED_REPEATS.map((repeat) => ({
        spotId: spot.id,
        personaId,
        repeat,
      })),
    ),
  );
}

/** 追加分の判断の数が上限に入っていなければ例外（呼ぶ前に止める）。 */
export function assertRiverDecisionLimit(cases: readonly EvalCase[]): number {
  if (cases.length > RIVER_REPEAT_EVAL_LIMITS.maxDecisions) {
    throw new RangeError(
      `判断 ${cases.length} 件は上限 ${RIVER_REPEAT_EVAL_LIMITS.maxDecisions} を超える（D126）`,
    );
  }
  return cases.length;
}

/** 追加分の録画の置き場所（D123 の opponent-memory-prompt-eval.json とは別。CI はこれも再生する）。 */
export const RIVER_REPEAT_RECORDING_URL = new URL(
  "./recordings/opponent-memory-prompt-river-repeat.json",
  import.meta.url,
);

/**
 * 追加分の録画。cases は追加分（repeat 2・3）だけを持つ。summary は D123 の録画の River の分（repeat 1）と合わせた
 * repeat 3 の集計、addedSummary は追加分だけの集計（どちらも全判断が揃うまで null）。
 */
export interface RiverRepeatEvalRecording {
  /** 録画の形の版。 */
  readonly version: 1;
  readonly recordedAt: string;
  readonly model: string;
  readonly sdkVersion: string;
  /** 合わせる D123 の録画（repeat 1 の出どころ）。 */
  readonly baseRecording: "opponent-memory-prompt-eval.json";
  readonly spots: readonly string[];
  readonly personas: readonly PersonaPresetId[];
  /** 追加した repeat の番号。 */
  readonly addedRepeats: readonly number[];
  /** D123 の録画と合わせた repeat。 */
  readonly totalRepeats: number;
  readonly concurrency: number;
  readonly limits: typeof RIVER_REPEAT_EVAL_LIMITS;
  /** 録画のために実際にモデルを呼んだ回数（障害で終わった呼び出し・足りない分の追加の実行も含む合計）。 */
  readonly modelCalls: number;
  /** 録画を取った実行の回数。 */
  readonly runs: number;
  readonly cases: readonly RecordedCase[];
  readonly summary: OpponentEvalSummary | null;
  readonly addedSummary: OpponentEvalSummary | null;
}

/** D123 の録画から River の判断（repeat 1）だけを取り出す。 */
export function baseRiverCases(
  base: Pick<MemoryPromptEvalRecording, "cases" | "repeats">,
): RecordedCase[] {
  if (base.repeats !== MEMORY_PROMPT_EVAL_REPEATS) {
    throw new Error(
      `D123 の録画の repeat が ${base.repeats}（${MEMORY_PROMPT_EVAL_REPEATS} を前提に repeat 2 から足している）`,
    );
  }
  const ids = new Set(RIVER_REPEAT_SPOTS.map((s) => s.id));
  return base.cases.filter((c) => ids.has(c.spotId));
}

/** 追加分だけの集計に使う母集団（repeat 2・3 を 1・2 と数え直し、集計の入口ガード〔repeat は 1 から〕を通す）。 */
export function renumberAddedRepeats<T extends EvalCase>(
  cases: readonly T[],
): T[] {
  const first = Math.min(...RIVER_REPEAT_ADDED_REPEATS);
  return cases.map((c) => ({ ...c, repeat: c.repeat - first + 1 }));
}

/** 見る Action（Call / Fold / Raise。all_in は Raise とは分けて数える）。 */
const RIVER_ACTIONS = ["call", "fold", "raise", "all_in"] as const;
type RiverAction = (typeof RIVER_ACTIONS)[number];

export interface RiverRateCell {
  /** Claude の判断で終わった数（Fallback・障害は数えない）。 */
  readonly n: number;
  /** Action ごとの割合（n が 0 なら null）。 */
  readonly rates: Readonly<Record<RiverAction, number | null>>;
}

export interface RiverRateReport {
  /** Persona → 条件 → 割合。 */
  readonly byPersona: Readonly<
    Record<string, Readonly<Record<MemoryPromptConditionId, RiverRateCell>>>
  >;
  /** 全 Persona を合わせた条件ごとの割合。 */
  readonly total: Readonly<Record<MemoryPromptConditionId, RiverRateCell>>;
  /** Call の割合の向き（memory-prompt-eval の directionReport の River の行。RuleBot の参照値を含む）。 */
  readonly direction: DirectionRow;
}

/** 集計の actionCounts から、River の Persona ごと・条件ごとの Call / Fold / Raise の割合を出す。 */
export function riverRateReport(summary: OpponentEvalSummary): RiverRateReport {
  const byPersona: Record<
    string,
    Record<MemoryPromptConditionId, RiverRateCell>
  > = {};
  const merged: Record<
    MemoryPromptConditionId,
    Partial<Record<ActionType, number>>
  > = { baseline: {}, loose: {}, tight: {} };
  for (const persona of RIVER_REPEAT_PERSONAS) {
    const row = {} as Record<MemoryPromptConditionId, RiverRateCell>;
    for (const { id } of MEMORY_PROMPT_CONDITIONS) {
      const counts =
        summary.actionCounts[persona]?.[
          memoryPromptSpotId(RIVER_REPEAT_BASE_SPOT_ID, id)
        ] ?? {};
      row[id] = cell(counts);
      for (const [type, n] of Object.entries(counts)) {
        const t = type as ActionType;
        merged[id][t] = (merged[id][t] ?? 0) + n;
      }
    }
    byPersona[persona] = row;
  }
  const direction = directionReport(summary).find(
    (r) => r.spotId === RIVER_REPEAT_BASE_SPOT_ID,
  );
  if (direction === undefined) throw new Error("River の向きの行が無い");
  return {
    byPersona,
    total: {
      baseline: cell(merged.baseline),
      loose: cell(merged.loose),
      tight: cell(merged.tight),
    },
    direction,
  };
}

function cell(
  counts: Readonly<Partial<Record<ActionType, number>>>,
): RiverRateCell {
  const n = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const rates = {} as Record<RiverAction, number | null>;
  for (const action of RIVER_ACTIONS) {
    rates[action] =
      n === 0 ? null : Math.round(((counts[action] ?? 0) / n) * 1000) / 1000;
  }
  return { n, rates };
}
