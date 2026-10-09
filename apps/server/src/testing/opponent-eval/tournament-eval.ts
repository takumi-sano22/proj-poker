// Tournament の Claude CPU の Opponent Eval（#202・D132・docs/09 §5）。
// #188 で Prompt に入るようになった Public Tournament Context（Stack BB・Stage・ICM Equity・Bubble Factor）を、Tournament の Hand の
// 代表 Spot で Claude が戦略にどう使うかを、既存の Opponent Eval のハーネス（本番の Factory・検証・Retry）で集める。
// Spot は D132 の 7 つ（S0 対照 / S1〜S4 Stage ごとの 10BB の Open Shove の判断 / S5 Bubble の大 Stack の Shove への Call / S6 S5 + 層）。
// 呼び出しの上限（D132: 28 判断・56 呼び出し）はここで定数にし、ハーネスへ渡す query() を上限の番人（createCallBudget）で包む。
import { TOURNAMENT_PRESETS, type ActionType } from "@proj-poker/engine";
import type { PersonaPresetId } from "../../opponents/persona.js";
import { LAYER_CONDITIONS, withLayers } from "./memory-eval.js";
import type { MemoryPromptEvalRecording } from "./memory-prompt-eval.js";
import { distance, type OpponentEvalSummary } from "./metrics.js";
import type { EvalSpot, EvalTournament } from "./spots.js";

/** 呼び出しの上限（D132）。判断は Spot 7 × Persona 2 × repeat 2、呼び出しは Retry を含めて判断の 2 倍。 */
export const TOURNAMENT_EVAL_LIMITS = {
  maxDecisions: 28,
  maxCalls: 56,
} as const;

export const TOURNAMENT_EVAL_REPEATS = 2;

/**
 * 対照的な 2 Persona（D132）。Tournament Context の読み方の指示は「リスク許容度」と「規律」を指す（claude-opponent.ts）ので、
 * その 2 軸が両端に近い組にする: Nit（リスク許容 0.2・規律 0.8）と Maniac（リスク許容 0.9・規律 0.15）。
 */
export const TOURNAMENT_EVAL_PERSONAS: readonly PersonaPresetId[] = [
  "nit",
  "maniac",
];

/**
 * 標準 6-max STT（D127。6 人参加・3 位まで入賞・Level 5 は 75 / 150・Big Blind Ante 150）。Chip の合計は 9,000。
 * Open Shove の判断（S1〜S4・S0）は、判断する cpu3 が 1,500（10BB）・Qh 6c で、自分より前は全員 Fold している局面にそろえる
 * （Stage だけを変える。残人数が変わるので席の位置は Button → SB → Heads-Up の SB と変わる）。
 */
const STT6 = TOURNAMENT_PRESETS.stt6_hand_count;
const SHOVE_HOLE = { cpu3: "Qh 6c" };
const SHOVE_BOARD = "Kd 9s 4c 2h Jc";

const tournament = (
  t: Omit<EvalTournament, "config" | "entrants" | "level" | "context"> & {
    readonly context?: boolean;
  },
): EvalTournament => ({
  config: STT6,
  entrants: 6,
  level: 5,
  context: true,
  ...t,
});

const fold = { type: "fold" } as const;
const allIn = { type: "all_in" } as const;

/** S2（Bubble の Open Shove）。S0 はこれと同じ Hand から Context だけを外す。 */
const BUBBLE_SHOVE: EvalSpot = {
  id: "t2_bubble_shove",
  label:
    "S2 Bubble（残り 4 人）: BTN の 10BB で前が全員 Fold、Open Shove するか（Q6o）",
  actorId: "cpu3",
  holes: SHOVE_HOLE,
  board: SHOVE_BOARD,
  // 席順: hero（SB 3,000）→ cpu1（BB 2,500）→ cpu2（UTG 2,000）→ cpu3（BTN 1,500）。
  script: [["cpu2", fold]],
  tournament: tournament({
    handNumber: 43,
    button: "cpu3",
    seats: [
      { playerId: "hero", stack: 3_000 },
      { playerId: "cpu1", stack: 2_500 },
      { playerId: "cpu2", stack: 2_000 },
      { playerId: "cpu3", stack: 1_500 },
    ],
  }),
};

/** S5（Bubble で、Bubble Factor の高い大 Stack の Shove への Call）。S6 はこれに層を足す。 */
const BUBBLE_CALL: EvalSpot = {
  id: "t5_bubble_call_vs_big",
  label:
    "S5 Bubble（残り 4 人）: BB の 2,500 が、Chip Leader（BTN 4,000）の Shove に Call するか（A9o。短い Stack 1,000 がいる）",
  actorId: "cpu3",
  holes: { cpu3: "Ah 9c" },
  board: "Qs 8d 5c 3h 2s",
  // 席順: hero（UTG 1,000）→ cpu1（BTN 4,000）→ cpu2（SB 1,500）→ cpu3（BB 2,500）。
  script: [
    ["hero", fold],
    ["cpu1", allIn],
    ["cpu2", fold],
  ],
  tournament: tournament({
    handNumber: 44,
    button: "cpu1",
    seats: [
      { playerId: "hero", stack: 1_000 },
      { playerId: "cpu1", stack: 4_000 },
      { playerId: "cpu2", stack: 1_500 },
      { playerId: "cpu3", stack: 2_500 },
    ],
  }),
};

/** S6 の層（memory-eval の all_loose: 相手が Loose と分かる Memory・緩い卓・Tilt 最大）。Memory は Tournament の Hypothesis にする。 */
const ALL_LOOSE = LAYER_CONDITIONS.find((c) => c.id === "all_loose");
if (ALL_LOOSE === undefined) throw new Error("層の条件 all_loose が無い");
const LOOSE_LAYERS = ALL_LOOSE;

/**
 * 代表 Spot（D132 の S0〜S6）。id は録画・集計のキー（変えると録画が使えなくなる）。
 * S0 と S2、S5 と S6 は Hand の ID を同じにする（baseSpotId。Hand の ID は KnowledgeState に入り Prompt の引数になる）ので、
 * 違いは Context の有無・層の有無だけになる。
 */
export const TOURNAMENT_EVAL_SPOTS: readonly EvalSpot[] = [
  {
    ...BUBBLE_SHOVE,
    id: "t0_no_context",
    label: `S0 対照: S2 と同じ札・Stack・Blind で、Tournament Context を渡さない（Cash と同じ Prompt の組み立て）`,
    baseSpotId: BUBBLE_SHOVE.id,
    tournament: {
      ...(BUBBLE_SHOVE.tournament as EvalTournament),
      context: false,
    },
  },
  {
    id: "t1_before_bubble_shove",
    label:
      "S1 Bubble の前（残り 5 人）: BTN の 10BB で前が全員 Fold、Open Shove するか（Q6o）",
    actorId: "cpu3",
    holes: SHOVE_HOLE,
    board: SHOVE_BOARD,
    // 席順: hero（SB 3,000）→ cpu1（BB 2,500）→ cpu2（UTG 1,000）→ cpu4（CO 1,000）→ cpu3（BTN 1,500）。
    script: [
      ["cpu2", fold],
      ["cpu4", fold],
    ],
    tournament: tournament({
      handNumber: 41,
      button: "cpu3",
      seats: [
        { playerId: "hero", stack: 3_000 },
        { playerId: "cpu1", stack: 2_500 },
        { playerId: "cpu2", stack: 1_000 },
        { playerId: "cpu4", stack: 1_000 },
        { playerId: "cpu3", stack: 1_500 },
      ],
    }),
  },
  BUBBLE_SHOVE,
  {
    id: "t3_itm_shove",
    label:
      "S3 In the Money（残り 3 人）: BTN の 10BB で最初に動く、Open Shove するか（Q6o）",
    actorId: "cpu3",
    holes: SHOVE_HOLE,
    board: SHOVE_BOARD,
    // 席順: hero（SB 4,000）→ cpu1（BB 3,500）→ cpu3（BTN 1,500）。3 人では BTN が Preflop の最初。
    script: [],
    tournament: tournament({
      handNumber: 46,
      button: "cpu3",
      seats: [
        { playerId: "hero", stack: 4_000 },
        { playerId: "cpu1", stack: 3_500 },
        { playerId: "cpu3", stack: 1_500 },
      ],
    }),
  },
  {
    id: "t4_heads_up_shove",
    label:
      "S4 Heads-Up（残り 2 人）: SB（Button）の 10BB で最初に動く、Open Shove するか（Q6o）",
    actorId: "cpu3",
    holes: SHOVE_HOLE,
    board: SHOVE_BOARD,
    // 席順: hero（BB 7,500）→ cpu3（SB・Button 1,500）。Heads-Up では Button が SB で Preflop の最初。
    script: [],
    tournament: tournament({
      handNumber: 48,
      button: "cpu3",
      seats: [
        { playerId: "hero", stack: 7_500 },
        { playerId: "cpu3", stack: 1_500 },
      ],
    }),
  },
  BUBBLE_CALL,
  {
    ...BUBBLE_CALL,
    id: "t6_bubble_call_layers",
    label: `${BUBBLE_CALL.label}［Memory・Table Tendency・Tilt の層（all_loose）を足す］`,
    baseSpotId: BUBBLE_CALL.id,
    withLayers: (input) => {
      const layered = withLayers(input, LOOSE_LAYERS);
      const memory = layered.knowledge.memory;
      // 本番の Tournament の Hand は tournament の Hypothesis だけを要約する（D106・#188）。
      return memory === undefined
        ? layered
        : {
            ...layered,
            knowledge: {
              ...layered.knowledge,
              memory: { ...memory, context: "tournament" },
            },
          };
    },
  },
];

/** 判断の数（Spot × Persona × repeat）が上限に入っていなければ例外（呼ぶ前に止める）。 */
export function assertTournamentDecisionLimit(
  spots: readonly EvalSpot[],
  personas: readonly PersonaPresetId[],
  repeats: number,
): number {
  const decisions = spots.length * personas.length * repeats;
  if (decisions > TOURNAMENT_EVAL_LIMITS.maxDecisions) {
    throw new RangeError(
      `判断 ${decisions} 件は上限 ${TOURNAMENT_EVAL_LIMITS.maxDecisions} を超える（D132）`,
    );
  }
  return decisions;
}

/** 録画の置き場所（既存の録画とは別。CI はこれも再生する）。 */
export const TOURNAMENT_RECORDING_URL = new URL(
  "./recordings/opponent-tournament-eval.json",
  import.meta.url,
);

/** 録画（Memory 付き Prompt の録画と同じ形で、上限だけ D132 の値）。summary は全判断が揃うまで null。 */
export interface TournamentEvalRecording extends Omit<
  MemoryPromptEvalRecording,
  "limits"
> {
  readonly limits: typeof TOURNAMENT_EVAL_LIMITS;
}

/** Spot ごとの最終 Action の分布（Persona ごとと合計）。Claude の判断で終わったものだけ（Fallback・障害は数えない）。 */
export interface StageRow {
  readonly spotId: string;
  /** 割合を見る Action（Open Shove の Spot は all_in、Shove への Call の Spot は Pot に残る call と all_in。どちらも同じ額を出す）。 */
  readonly watch: readonly ActionType[];
  readonly byPersona: Readonly<
    Record<string, Readonly<Partial<Record<ActionType, number>>>>
  >;
  readonly total: Readonly<Partial<Record<ActionType, number>>>;
  /** watch の Action の割合（合計。判断が無ければ null）。 */
  readonly watchRate: number | null;
}

/** Shove への Call の Spot（それ以外は Open Shove の Spot）。 */
const CALL_SPOTS = new Set(["t5_bubble_call_vs_big", "t6_bubble_call_layers"]);

export interface TournamentReport {
  readonly stages: readonly StageRow[];
  /**
   * Context の有無の差: S0（Context なし）と S2（あり）の最終 Action の分布の差（Total Variation Distance。0〜1）。
   * Persona ごとと合計。0 なら Context を渡しても選び方が変わらなかった。
   */
  readonly contextEffect: {
    readonly byPersona: Readonly<Record<string, number | null>>;
    readonly total: number | null;
  };
  /** 層の有無の差: S5（層なし）と S6（層あり）の分布の差（同上）。 */
  readonly layerEffect: {
    readonly byPersona: Readonly<Record<string, number | null>>;
    readonly total: number | null;
  };
}

/** 集計の actionCounts から、Stage ごとの分布と Context・層の有無の差を出す（数値はここで機械的に出す）。 */
export function tournamentReport(
  summary: OpponentEvalSummary,
  personas: readonly PersonaPresetId[] = TOURNAMENT_EVAL_PERSONAS,
): TournamentReport {
  const countsOf = (persona: string, spotId: string) =>
    summary.actionCounts[persona]?.[spotId] ?? {};
  const merged = (spotId: string) => {
    const out: Partial<Record<ActionType, number>> = {};
    for (const persona of personas) {
      for (const [type, n] of Object.entries(countsOf(persona, spotId))) {
        const t = type as ActionType;
        out[t] = (out[t] ?? 0) + n;
      }
    }
    return out;
  };
  const stages = TOURNAMENT_EVAL_SPOTS.map(({ id }): StageRow => {
    const total = merged(id);
    const all = sum(total);
    const watch: readonly ActionType[] = CALL_SPOTS.has(id)
      ? ["call", "all_in"]
      : ["all_in"];
    return {
      spotId: id,
      watch,
      byPersona: Object.fromEntries(personas.map((p) => [p, countsOf(p, id)])),
      total,
      watchRate:
        all === 0
          ? null
          : round3(watch.reduce((n, t) => n + (total[t] ?? 0), 0) / all),
    };
  });
  const effect = (a: string, b: string) => ({
    byPersona: Object.fromEntries(
      personas.map((p) => [p, tvd(countsOf(p, a), countsOf(p, b))]),
    ),
    total: tvd(merged(a), merged(b)),
  });
  return {
    stages,
    contextEffect: effect("t0_no_context", "t2_bubble_shove"),
    layerEffect: effect("t5_bubble_call_vs_big", "t6_bubble_call_layers"),
  };
}

function tvd(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): number | null {
  return sum(a) === 0 || sum(b) === 0 ? null : round3(distance(a, b));
}

function sum(counts: Readonly<Record<string, number | undefined>>): number {
  return Object.values(counts).reduce<number>((n, v) => n + (v ?? 0), 0);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
