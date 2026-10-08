// Memory 付き Prompt の Claude CPU の Opponent Eval（#155・D123・docs/09 §5）。
// #139〜#142 で Prompt に入るようになった Memory（Hypothesis の要約）・Table Tendency・Tilt を、代表 Spot の入力に決定論で足し、
// 既存の Opponent Eval のハーネス（本番の Factory・検証・Retry）で Claude の判断を集める。条件は D123 の上限どおり 3 つ:
// - baseline: 層なし（既存の代表 Spot と同じ Prompt）
// - loose: 相手（Subject）が Loose と分かる Memory・緩い卓の Table Tendency・Tilt 最大（memory-eval の all_loose）
// - tight: 相手が Tight と分かる Memory・締まった卓の Table Tendency・Tilt 最大（memory-eval の all_tight）
// loose と tight は Tilt が同じなので、両者の差は相手と卓の傾向の向きだけになる。
// 呼び出しの上限（D123）はここで定数にし、ハーネスへ渡す query() を上限の番人で包んで超えて呼ばない。
import type { ActionType } from "@proj-poker/engine";
import type { ClaudeQuery } from "../../opponents/claude-opponent.js";
import {
  PERSONA_PRESET_IDS,
  type PersonaPresetId,
} from "../../opponents/persona.js";
import type { EvalCase } from "./harness.js";
import {
  LAYER_CONDITIONS,
  rateOf,
  spotDistribution,
  withLayers,
  type LayerCondition,
} from "./memory-eval.js";
import type { OpponentEvalSummary } from "./metrics.js";
import type { OpponentEvalRecording } from "./recording.js";
import { OPPONENT_EVAL_SPOTS, type EvalSpot } from "./spots.js";

/** 呼び出しの上限（D123）。判断は Spot 2 × Persona 6 × 条件 3 × repeat 1、呼び出しは Retry を含めて判断の 2 倍。 */
export const MEMORY_PROMPT_EVAL_LIMITS = {
  maxDecisions: 36,
  maxCalls: 72,
} as const;

/** 判断の繰り返し（D123 は repeat 1）。 */
export const MEMORY_PROMPT_EVAL_REPEATS = 1;

/**
 * Memory が戦略に効く代表 Spot と、向きを見る Action（memory-eval の (1) と同じ）。
 * - river_facing_big_bet: 攻める（Loose）相手なら Call が増え、攻めない（Tight）相手なら減るのが意図した向き
 * - flop_cbet: C-bet によく降りる（Tight）相手なら Bet（Bluff の C-bet）が増え、降りない（Loose）相手なら減るのが意図した向き
 */
export const MEMORY_PROMPT_SPOTS = [
  { spotId: "river_facing_big_bet", watch: ["call"], increasesWith: "loose" },
  { spotId: "flop_cbet", watch: ["bet"], increasesWith: "tight" },
] as const satisfies readonly {
  readonly spotId: string;
  readonly watch: readonly ActionType[];
  readonly increasesWith: "loose" | "tight";
}[];

export type MemoryPromptConditionId = "baseline" | "loose" | "tight";

/** 条件と、memory-eval の層の条件の対応（RuleBot の向きと並べて比べるため、同じ値を使う）。 */
export const MEMORY_PROMPT_CONDITIONS: readonly {
  readonly id: MemoryPromptConditionId;
  readonly layers: LayerCondition;
}[] = (
  [
    ["baseline", "none"],
    ["loose", "all_loose"],
    ["tight", "all_tight"],
  ] as const
).map(([id, layerId]) => {
  const layers = LAYER_CONDITIONS.find((c) => c.id === layerId);
  if (layers === undefined) throw new Error(`層の条件が無い: ${layerId}`);
  return { id, layers };
});

/** 層を足した Spot の id（録画・集計のキー）。 */
export function memoryPromptSpotId(
  spotId: string,
  condition: MemoryPromptConditionId,
): string {
  return `${spotId}@${condition}`;
}

/** 代表 Spot × 条件の Spot。baseline は層を足さず、元の Spot と同じ Prompt になる。 */
export const MEMORY_PROMPT_EVAL_SPOTS: readonly EvalSpot[] =
  MEMORY_PROMPT_SPOTS.flatMap(({ spotId }) => {
    const base = OPPONENT_EVAL_SPOTS.find((s) => s.id === spotId);
    if (base === undefined) throw new Error(`代表 Spot が無い: ${spotId}`);
    return MEMORY_PROMPT_CONDITIONS.map(({ id, layers }) => ({
      ...base,
      id: memoryPromptSpotId(spotId, id),
      label: `${base.label}［${id}］`,
      baseSpotId: base.id,
      ...(id === "baseline"
        ? {}
        : { withLayers: (input) => withLayers(input, layers) }),
    }));
  });

export const MEMORY_PROMPT_EVAL_PERSONAS: readonly PersonaPresetId[] =
  PERSONA_PRESET_IDS;

/** 判断の数（Spot × 条件 × Persona × repeat）が上限に入っていなければ例外（呼ぶ前に止める）。 */
export function assertDecisionLimit(
  spots: readonly EvalSpot[],
  personas: readonly PersonaPresetId[],
  repeats: number,
): number {
  const decisions = spots.length * personas.length * repeats;
  if (decisions > MEMORY_PROMPT_EVAL_LIMITS.maxDecisions) {
    throw new RangeError(
      `判断 ${decisions} 件は上限 ${MEMORY_PROMPT_EVAL_LIMITS.maxDecisions} を超える（D123）`,
    );
  }
  return decisions;
}

/** モデルの呼び出しの数を数え、上限に達したら以降は呼ばずに例外にする番人。 */
export interface CallBudget {
  /** 実際に下の query() へ渡した呼び出しの数。 */
  readonly used: () => number;
  readonly remaining: () => number;
  /** 以降の呼び出しを止める（障害が出たときに残りを打ち切る）。 */
  readonly close: (reason: string) => void;
  readonly closedReason: () => string | undefined;
  /** query() を包む。上限に達しているか止めた後は、下の query() を呼ばずに例外を投げる（ハーネスでは障害になる）。 */
  readonly wrap: (inner: ClaudeQuery) => ClaudeQuery;
}

export function createCallBudget(max: number): CallBudget {
  let used = 0;
  let closed: string | undefined;
  return {
    used: () => used,
    remaining: () => Math.max(0, max - used),
    close: (reason) => {
      closed ??= reason;
    },
    closedReason: () => closed,
    wrap: (inner) => (params) => {
      if (closed !== undefined) {
        throw new Error(`打ち切り済みなので呼ばない: ${closed}`);
      }
      if (used >= max) {
        throw new Error(`呼び出しの上限 ${max} 回に達したので呼ばない（D123）`);
      }
      used++;
      return inner(params);
    },
  };
}

/**
 * dry-run 用の query()（モデルを呼ばない）。Schema の選べる Action から check か fold を返し、
 * ハーネスの全経路（Prompt の組み立て・漏れの走査）を 1 判断 1 回の呼び出しで通す。
 */
export const dryRunQuery: ClaudeQuery = (params) => {
  const schema = (
    params.options.outputFormat as
      { schema?: { properties?: { action?: { enum?: string[] } } } } | undefined
  )?.schema;
  const choices = schema?.properties?.action?.enum ?? [];
  const action = choices.includes("check") ? "check" : "fold";
  return (async function* () {
    await Promise.resolve();
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      structured_output: { action },
    } as never;
  })();
};

/** 録画の置き場所（既存の opponent-eval.json とは別。CI はこれも再生する）。 */
export const MEMORY_PROMPT_RECORDING_URL = new URL(
  "./recordings/opponent-memory-prompt-eval.json",
  import.meta.url,
);

/** 録画（既存の録画の形に、上限と実際の呼び出しの数を足したもの）。summary は全判断が揃うまで null。 */
export interface MemoryPromptEvalRecording extends Omit<
  OpponentEvalRecording,
  "summary"
> {
  readonly summary: OpponentEvalSummary | null;
  readonly limits: typeof MEMORY_PROMPT_EVAL_LIMITS;
  /** 録画のために実際にモデルを呼んだ回数（障害で終わった呼び出し・足りない分の追加の実行も含む合計）。 */
  readonly modelCalls: number;
  /** 録画を取った実行の回数（1 回目 + 足りない分の追加）。 */
  readonly runs: number;
}

/** 条件ごとの、見る Action の割合（Claude の判断で終わったものだけが分母。Fallback は数えない）。 */
export interface DirectionRow {
  readonly spotId: string;
  readonly watch: readonly ActionType[];
  readonly increasesWith: "loose" | "tight";
  /** Persona → 条件 → 割合（判断が無ければ null）。 */
  readonly byPersona: Readonly<
    Record<string, Readonly<Record<MemoryPromptConditionId, number | null>>>
  >;
  /** 全 Persona を合わせた条件ごとの割合。 */
  readonly total: Readonly<Record<MemoryPromptConditionId, number | null>>;
  /** 意図した向き（increasesWith の条件の割合 > 反対の条件の割合）に動いたか。 */
  readonly intendedDirection: boolean | null;
  /** 同じ条件の RuleBot（400 seed）の割合（参照。memory-eval と同じ）。 */
  readonly ruleBot: Readonly<Record<MemoryPromptConditionId, number>>;
}

/** 集計の actionCounts から、Spot ごとに条件で見る Action の割合を並べる。 */
export function directionReport(summary: OpponentEvalSummary): DirectionRow[] {
  return MEMORY_PROMPT_SPOTS.map(({ spotId, watch, increasesWith }) => {
    const byPersona: Record<
      string,
      Record<MemoryPromptConditionId, number | null>
    > = {};
    const merged: Record<
      MemoryPromptConditionId,
      Partial<Record<ActionType, number>>
    > = { baseline: {}, loose: {}, tight: {} };
    for (const persona of MEMORY_PROMPT_EVAL_PERSONAS) {
      const row = {} as Record<MemoryPromptConditionId, number | null>;
      for (const { id } of MEMORY_PROMPT_CONDITIONS) {
        const counts =
          summary.actionCounts[persona]?.[memoryPromptSpotId(spotId, id)] ?? {};
        row[id] = rateOrNull(counts, watch);
        for (const [type, n] of Object.entries(counts)) {
          const t = type as ActionType;
          merged[id][t] = (merged[id][t] ?? 0) + n;
        }
      }
      byPersona[persona] = row;
    }
    const total = {
      baseline: rateOrNull(merged.baseline, watch),
      loose: rateOrNull(merged.loose, watch),
      tight: rateOrNull(merged.tight, watch),
    };
    const opposite = increasesWith === "loose" ? "tight" : "loose";
    const up = total[increasesWith];
    const down = total[opposite];
    const ruleBot = {} as Record<MemoryPromptConditionId, number>;
    for (const { id, layers } of MEMORY_PROMPT_CONDITIONS) {
      const counts: Partial<Record<ActionType, number>> = {};
      for (const persona of MEMORY_PROMPT_EVAL_PERSONAS) {
        const d = spotDistribution(spotId, persona, layers).counts;
        for (const [type, n] of Object.entries(d)) {
          const t = type as ActionType;
          counts[t] = (counts[t] ?? 0) + n;
        }
      }
      ruleBot[id] = round3(rateOf(counts, watch));
    }
    return {
      spotId,
      watch,
      increasesWith,
      byPersona,
      total,
      intendedDirection: up === null || down === null ? null : up > down,
      ruleBot,
    };
  });
}

function rateOrNull(
  counts: Readonly<Partial<Record<ActionType, number>>>,
  watch: readonly ActionType[],
): number | null {
  const all = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  return all === 0 ? null : round3(rateOf(counts, watch));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 録画に無い判断（足りない分の追加の実行で使う）。 */
export function missingCases(
  recorded: readonly EvalCase[],
  spots: readonly EvalSpot[],
  personas: readonly PersonaPresetId[],
  repeats: number,
): EvalCase[] {
  const have = new Set(
    recorded.map((c) => `${c.spotId}/${c.personaId}/${c.repeat}`),
  );
  const missing: EvalCase[] = [];
  for (const spot of spots) {
    for (const personaId of personas) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        if (!have.has(`${spot.id}/${personaId}/${repeat}`)) {
          missing.push({ spotId: spot.id, personaId, repeat });
        }
      }
    }
  }
  return missing;
}
