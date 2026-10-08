// Opponent Memory の Eval（#142・docs/09 §5）。RuleBot の決定論だけで回し、Claude も API キーも使わない（CI の pnpm test で回る）。
// 1. 代表 Spot（spots.ts の局面）に、Persona（固定）・Tilt・Table Tendency・Memory の層を足した入力で、Persona ごとに seed を変えて
//    判断を集め、Action の分布を出す（Memory が意図した向きに効くか・Persona の分布が潰れないか・合法か）
// 2. 本番の Hand Orchestrator（RuleBot・メモリ内の Event Store）で複数の Session を進め、CPU に渡った入力をそのまま記録する
//    （Fixed CPU の継続性・Guest の一時性・Leakage・時計が戻った記録・Memory / Tilt / Table Tendency の計算時間）
// 層の値は Orchestrator の private な組み立てを写した buildLayersAt で作り、実際に CPU へ渡った値と一致することを確かめてから
// 計算時間を測る（評価ハーネスと本番の引数の組み立ての一致。LC-050）。
import {
  applyAction,
  type ActionType,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { PHASE1_TABLE_SETUP } from "../../config.js";
import {
  InMemoryEventStore,
  type AppendContext,
  type EventStore,
  type InMemoryEventStoreOptions,
  type StoredHandEvent,
} from "../../event-store.js";
import { HandOrchestrator } from "../../hand-orchestrator.js";
import { createOrdinalCounter } from "../../logical-order.js";
import type { HypothesisItemId } from "../../memory/memory-policy.js";
import {
  buildOpponentMemoriesFromStore,
  type MemoryObserverSeat,
  type MemoryTableSeat,
  type OpponentMemorySummary,
} from "../../memory/memory-summary.js";
import { participantRefOf } from "../../memory/observation.js";
import {
  buildCpuTableTendenciesFromStore,
  type TableTendency,
} from "../../memory/table-tendency.js";
import { PHASE7_TABLE_TENDENCY_V1 } from "../../memory/table-tendency-policy.js";
import type { SessionParticipant } from "../../opponents/cpu-pool.js";
import type {
  OpponentAgent,
  OpponentFactory,
  OpponentInput,
} from "../../opponents/opponent-agent.js";
import {
  PERSONA_PRESETS,
  PERSONA_PRESET_IDS,
  type Persona,
  type PersonaPresetId,
} from "../../opponents/persona.js";
import { RuleBot, createRuleBot } from "../../opponents/rule-bot.js";
import { buildTiltsFromStore, type CpuTilt } from "../../opponents/tilt.js";
import { PHASE7_TILT_V1 } from "../../opponents/tilt-policy.js";
import { entropy, meanPairwiseDistance } from "./metrics.js";
import { OPPONENT_EVAL_SPOTS, buildSpot, type SpotFixture } from "./spots.js";

// ---------------------------------------------------------------------------
// 1. 代表 Spot × 層の条件 × Persona × seed
// ---------------------------------------------------------------------------

/** Subject の傾向の形。 */
export type SubjectProfileId = "loose" | "tight";

/**
 * Memory の Subject の傾向（Eval の固定値。どちらも十分な Sample とする。項目は D121 の上限 5 つ）。
 * - loose: よく参加して攻め、C-bet にあまり降りない
 * - tight: 参加が少なく攻めず、C-bet によく降りる
 */
export const SUBJECT_PROFILES: Readonly<
  Record<SubjectProfileId, Readonly<Partial<Record<HypothesisItemId, number>>>>
> = {
  loose: {
    vpip: 0.6,
    pfr: 0.4,
    cbet_flop: 0.8,
    fold_to_cbet_flop: 0.2,
    aggression_frequency: 0.7,
  },
  tight: {
    vpip: 0.12,
    pfr: 0.1,
    cbet_flop: 0.5,
    fold_to_cbet_flop: 0.75,
    aggression_frequency: 0.12,
  },
};

/** 判断する CPU の他の席を全員同じ傾向の Subject にした Memory の要約（本番の OpponentMemorySummary と同じ形）。 */
export function memoryFor(
  input: OpponentInput,
  profile: SubjectProfileId,
  sufficient = true,
): OpponentMemorySummary {
  const k = input.knowledge;
  return {
    policyVersion: "phase7_memory_v1",
    injectionVersion: "phase7_memory_injection_v1",
    context: "cash",
    subjects: k.seats
      .filter((s) => s.playerId !== k.viewerId)
      .map((s) => ({
        playerId: s.playerId,
        subject:
          s.playerId === "hero"
            ? { kind: "hero" as const }
            : {
                kind: "cpu_profile" as const,
                cpuProfileId: `eval_${s.playerId}`,
              },
        handsObserved: 120,
        items: Object.entries(SUBJECT_PROFILES[profile]).map(
          ([item, frequency]) => ({
            item: item as HypothesisItemId,
            frequency,
            weightedOpportunities: 60,
            opportunities: 80,
            sufficient,
            // Evidence は RuleBot が読まないので持たせない（Spot の Memory は Eval の固定値で、元の Hand が無い）。
            evidenceCount: 0,
            evidenceIds: [],
          }),
        ),
      })),
  };
}

/** 卓の傾向（vpip と aggression_frequency。十分な Sample）。 */
function tableTendencyOf(vpip: number, aggression: number): TableTendency {
  const p = PHASE7_TABLE_TENDENCY_V1;
  return {
    policyVersion: p.version,
    hands: 60,
    items: (
      [
        ["vpip", vpip],
        ["aggression_frequency", aggression],
      ] as const
    ).map(([item, rate]) => ({
      item,
      policyVersion: p.version,
      numerator: Math.round(rate * 200),
      denominator: 200,
      hands: 60,
      sufficient: true,
    })),
  };
}

/** 層の条件（どの層をどの値で足すか）。 */
export interface LayerCondition {
  readonly id: string;
  /** Tilt の段階（1 以上のときだけ足す。本番と同じ）。 */
  readonly tilt?: number;
  readonly table?: { readonly vpip: number; readonly aggression: number };
  readonly memory?: SubjectProfileId;
  /** Memory の項目を不十分（保留）にする。 */
  readonly memoryInsufficient?: boolean;
}

const WILD_TABLE = { vpip: 0.9, aggression: 0.9 } as const;
const TIGHT_TABLE = { vpip: 0.1, aggression: 0.1 } as const;

/** Eval の条件。none は Persona だけ（層なし）。all_* は 3 つの層を同じ向きに一番大きく効かせる。 */
export const LAYER_CONDITIONS: readonly LayerCondition[] = [
  { id: "none" },
  { id: "memory_loose", memory: "loose" },
  { id: "memory_tight", memory: "tight" },
  { id: "memory_insufficient", memory: "loose", memoryInsufficient: true },
  { id: "tilt_max", tilt: PHASE7_TILT_V1.maxLevel },
  { id: "table_wild", table: WILD_TABLE },
  { id: "table_tight", table: TIGHT_TABLE },
  {
    id: "all_loose",
    tilt: PHASE7_TILT_V1.maxLevel,
    table: WILD_TABLE,
    memory: "loose",
  },
  {
    id: "all_tight",
    tilt: PHASE7_TILT_V1.maxLevel,
    table: TIGHT_TABLE,
    memory: "tight",
  },
];

/** Spot の入力に層を足す（本番の Orchestrator と同じく、KnowledgeState の memory / tilt / tableTendency に入れる）。 */
export function withLayers(
  input: OpponentInput,
  c: LayerCondition,
): OpponentInput {
  const tilt: CpuTilt | undefined =
    c.tilt === undefined || c.tilt <= 0
      ? undefined
      : {
          level: c.tilt,
          maxLevel: PHASE7_TILT_V1.maxLevel,
          policyVersion: PHASE7_TILT_V1.version,
        };
  return {
    ...input,
    knowledge: {
      ...input.knowledge,
      ...(c.memory === undefined
        ? {}
        : {
            memory: memoryFor(input, c.memory, c.memoryInsufficient !== true),
          }),
      ...(tilt === undefined ? {} : { tilt }),
      ...(c.table === undefined
        ? {}
        : { tableTendency: tableTendencyOf(c.table.vpip, c.table.aggression) }),
    },
  };
}

/** 1 つの Spot × Persona × 条件で、seed を変えた判断の数え。 */
export interface SpotDistribution {
  readonly counts: Readonly<Partial<Record<ActionType, number>>>;
  /** Engine が拒否した判断（合法でない）。 */
  readonly illegal: number;
  /** Check できるのに Fold した判断（明らかな Strategic Incoherence）。 */
  readonly foldWhenCheck: number;
}

/** seed の数（Persona・Spot・条件ごと）。 */
export const LAYER_EVAL_SEEDS = 400;

/** Spot の局面を作り直さないように、1 回だけ作って使い回す。 */
const fixtures = new Map<string, SpotFixture>();
function fixtureOf(spotId: string): SpotFixture {
  let fixture = fixtures.get(spotId);
  if (fixture === undefined) {
    const spot = OPPONENT_EVAL_SPOTS.find((s) => s.id === spotId);
    if (spot === undefined) throw new RangeError(`Spot が無い: ${spotId}`);
    fixture = buildSpot(spot);
    fixtures.set(spotId, fixture);
  }
  return fixture;
}

/** RuleBot（本番の Factory）で seed を変えて判断を集め、Engine で合法かを確かめる。 */
export function spotDistribution(
  spotId: string,
  personaId: PersonaPresetId,
  condition: LayerCondition,
  seeds = LAYER_EVAL_SEEDS,
): SpotDistribution {
  const fixture = fixtureOf(spotId);
  const input = withLayers(fixture.input, condition);
  const canCheck = input.legal.actions.some((a) => a.type === "check");
  const counts: Partial<Record<ActionType, number>> = {};
  let illegal = 0;
  let foldWhenCheck = 0;
  for (let i = 0; i < seeds; i++) {
    const bot = new RuleBot(10_000 + i, PERSONA_PRESETS[personaId]);
    const action = bot.choose(input);
    counts[action.type] = (counts[action.type] ?? 0) + 1;
    if (!applyAction(fixture.state, fixture.actorId, action).ok) illegal++;
    if (canCheck && action.type === "fold") foldWhenCheck++;
  }
  return { counts, illegal, foldWhenCheck };
}

/**
 * 層を足したときの合格ライン（暫定。測定の前に決めて固定する。llm-quality-improvement 鉄則 2）。
 * - Illegal・Check できるのに Fold は 0（ここでは固定。ずれは 0 であるべき）
 * - Persona Differentiation と Persona ごとの Action Diversity は、層なし（none）の 0.75 倍以上（分布が潰れない）
 * - 攻撃性（Bet / Raise の割合）の Persona の順序は、どの条件でも左の Persona の方が大きい（明らかな Strategic Incoherence の代わり）
 */
export const MEMORY_EVAL_TARGETS = {
  minDifferentiationRatio: 0.75,
  minDiversityRatio: 0.75,
  aggressionOrder: [
    ["maniac", "nit"],
    ["lag", "nit"],
    ["maniac", "calling_station"],
  ],
} as const satisfies {
  readonly minDifferentiationRatio: number;
  readonly minDiversityRatio: number;
  readonly aggressionOrder: readonly (readonly [
    PersonaPresetId,
    PersonaPresetId,
  ])[];
};

/** 1 つの条件の集計。 */
export interface LayerConditionSummary {
  readonly condition: string;
  /** Spot × Persona の Action の数え。 */
  readonly counts: Record<
    string,
    Record<string, Partial<Record<ActionType, number>>>
  >;
  readonly illegal: number;
  readonly foldWhenCheck: number;
  /** Spot ごとの Persona の組の分布の差（TVD）の平均を、Spot で平均したもの（metrics.ts と同じ定義）。 */
  readonly personaDifferentiation: number;
  /** Persona ごとの、全 Spot の Action の種類の Shannon Entropy（bit）。 */
  readonly actionDiversity: Record<string, number>;
  /** Persona ごとの、全 Spot の判断のうち Bet / Raise の割合。 */
  readonly aggressionRate: Record<string, number>;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 全 Spot × 全 Persona で 1 つの条件を集計する。 */
export function summarizeLayerCondition(
  condition: LayerCondition,
  seeds = LAYER_EVAL_SEEDS,
): LayerConditionSummary {
  const counts: LayerConditionSummary["counts"] = {};
  let illegal = 0;
  let foldWhenCheck = 0;
  for (const spot of OPPONENT_EVAL_SPOTS) {
    const bySpot: Record<string, Partial<Record<ActionType, number>>> = {};
    for (const personaId of PERSONA_PRESET_IDS) {
      const d = spotDistribution(spot.id, personaId, condition, seeds);
      bySpot[personaId] = d.counts;
      illegal += d.illegal;
      foldWhenCheck += d.foldWhenCheck;
    }
    counts[spot.id] = bySpot;
  }
  const spotIds = OPPONENT_EVAL_SPOTS.map((s) => s.id);
  const differentiation =
    spotIds
      .map((spotId) =>
        meanPairwiseDistance(
          PERSONA_PRESET_IDS.map((p) => counts[spotId]?.[p] ?? {}),
        ),
      )
      .reduce((a, b) => a + b, 0) / spotIds.length;
  const actionDiversity: Record<string, number> = {};
  const aggressionRate: Record<string, number> = {};
  for (const personaId of PERSONA_PRESET_IDS) {
    const merged: Record<string, number> = {};
    for (const spotId of spotIds) {
      for (const [type, n] of Object.entries(
        counts[spotId]?.[personaId] ?? {},
      )) {
        merged[type] = (merged[type] ?? 0) + n;
      }
    }
    const total = Object.values(merged).reduce((a, b) => a + b, 0);
    actionDiversity[personaId] = round3(entropy(merged));
    aggressionRate[personaId] = round3(
      ((merged["bet"] ?? 0) + (merged["raise"] ?? 0)) / total,
    );
  }
  return {
    condition: condition.id,
    counts,
    illegal,
    foldWhenCheck,
    personaDifferentiation: round3(differentiation),
    actionDiversity,
    aggressionRate,
  };
}

/** Action の割合（数えの合計に対する types の割合）。 */
export function rateOf(
  counts: Readonly<Partial<Record<ActionType, number>>>,
  types: readonly ActionType[],
): number {
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const hit = types.reduce((a, t) => a + (counts[t] ?? 0), 0);
  return total === 0 ? 0 : hit / total;
}

// ---------------------------------------------------------------------------
// 2. 本番の Hand Orchestrator で複数の Session を進める
// ---------------------------------------------------------------------------

/** Hand の開始時の Session の文脈（Orchestrator が Hand の最初の追記に渡す値）。 */
interface HandContext {
  readonly sessionId: string;
  readonly personas: Readonly<Record<string, string>>;
  readonly participants: readonly SessionParticipant[];
}

/** Hand の最初の追記に渡った Session の文脈を覚えるメモリ内の Event Store（読み書きはそのまま）。 */
class ContextRecordingStore extends InMemoryEventStore {
  readonly contexts = new Map<string, HandContext>();

  override append(
    handId: string,
    events: Parameters<InMemoryEventStore["append"]>[1],
    context: AppendContext = {},
  ): readonly StoredHandEvent[] {
    if (!this.contexts.has(handId) && context.sessionId !== undefined) {
      this.contexts.set(handId, {
        sessionId: context.sessionId,
        personas: context.personas ?? {},
        participants: context.participants ?? [],
      });
    }
    return super.append(handId, events, context);
  }
}

/** 層の値（Hand の開始時に作る 3 つの Map。鍵は CPU の席）。 */
export interface LayerMaps {
  readonly memories: ReadonlyMap<string, OpponentMemorySummary>;
  readonly tilts: ReadonlyMap<string, CpuTilt>;
  readonly tableTendencies: ReadonlyMap<string, TableTendency>;
}

/** 層ごとの計算時間（ミリ秒）。 */
export interface LayerTimings {
  readonly memoryMs: number;
  readonly tiltMs: number;
  readonly tableTendencyMs: number;
}

/** Persona の無い CPU の Skill（Orchestrator の AVERAGE_SKILL と同じ）。 */
const AVERAGE_SKILL = 0.5;

/**
 * Hand Orchestrator の opponentMemories / opponentTilts / opponentTableTendencies と同じ入力で、今の Store から層の値を作る
 * （Hand の開始時に呼ぶ。進行中の Hand は保存済みでないので入力に入らない）。repeats 回計算し、計算時間は中央値を返す。
 */
export function buildLayersAt(
  store: EventStore,
  context: HandContext,
  seatIds: readonly string[],
  heroId: string,
  repeats = 1,
): { readonly layers: LayerMaps; readonly timings: LayerTimings } {
  const participantOf = new Map(
    context.participants.map((p) => [p.playerId, p] as const),
  );
  const presetOf = (playerId: string) =>
    context.personas[playerId] as PersonaPresetId | undefined;
  const seats: MemoryTableSeat[] = seatIds.map((playerId) => {
    const p = participantOf.get(playerId);
    return {
      playerId,
      participant:
        playerId === heroId
          ? { kind: "hero" }
          : p === undefined
            ? null
            : participantRefOf(p),
    };
  });
  const observers: MemoryObserverSeat[] = seatIds.flatMap((playerId) => {
    const p = participantOf.get(playerId);
    if (playerId === heroId || p === undefined) return [];
    const presetId = presetOf(playerId);
    return [
      {
        playerId,
        observer: participantRefOf(p),
        observerSkill:
          presetId === undefined
            ? AVERAGE_SKILL
            : PERSONA_PRESETS[presetId].traits.skill,
      },
    ];
  });
  const tiltSeats = seatIds.flatMap((playerId) => {
    const presetId = presetOf(playerId);
    return playerId === heroId || presetId === undefined
      ? []
      : [{ playerId, traits: PERSONA_PRESETS[presetId].traits }];
  });
  const cpuIds = seatIds.filter((playerId) => playerId !== heroId);

  const memoryTimes: number[] = [];
  const tiltTimes: number[] = [];
  const tableTimes: number[] = [];
  let layers: LayerMaps | undefined;
  for (let i = 0; i < Math.max(1, repeats); i++) {
    let t = performance.now();
    const memories =
      observers.length === 0
        ? new Map<string, OpponentMemorySummary>()
        : buildOpponentMemoriesFromStore(store, {
            heroPlayerId: heroId,
            currentSessionId: context.sessionId,
            seats,
            observers,
          });
    memoryTimes.push(performance.now() - t);
    t = performance.now();
    const tilts = buildTiltsFromStore(store, {
      sessionId: context.sessionId,
      seats: tiltSeats,
    });
    tiltTimes.push(performance.now() - t);
    t = performance.now();
    const tableTendencies = buildCpuTableTendenciesFromStore(store, {
      sessionId: context.sessionId,
      playerIds: cpuIds,
    });
    tableTimes.push(performance.now() - t);
    layers ??= { memories, tilts, tableTendencies };
  }
  return {
    layers: layers as LayerMaps,
    timings: {
      memoryMs: median(memoryTimes),
      tiltMs: median(tiltTimes),
      tableTendencyMs: median(tableTimes),
    },
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** CPU に渡った入力 1 つ。 */
export interface CpuDecisionRecord {
  readonly handId: string;
  readonly sessionId: string;
  readonly playerId: string;
  /** 判断の時点で Event Log にあった最後の seq。 */
  readonly uptoSeq: number;
  readonly input: OpponentInput;
  /** その CPU の Session の参加者（Fixed / Guest）。 */
  readonly participant: SessionParticipant | undefined;
  /** その CPU の Persona（RuleBot の中だけで使う Secret。入力には入れない）。 */
  readonly persona: Persona | undefined;
  /** RuleBot が返した Action。 */
  readonly output: unknown;
}

/** Hand の開始時の層の値と計算時間。 */
export interface HandLayerRecord {
  readonly handId: string;
  readonly sessionId: string;
  /** 計算の時点で保存済みの Hand の数（全 Session）。 */
  readonly savedHands: number;
  /** 計算の時点で保存済みの、今の Session の Hand の数。 */
  readonly sessionHands: number;
  readonly layers: LayerMaps;
  readonly timings: LayerTimings;
}

export interface SessionRunOptions {
  /** Session ごとに進める（終わった）Hand の数。Session の間は CPU の障害 → Session 終了で区切る（本番の D86 の経路）。 */
  readonly handsPerSession: readonly number[];
  /** n 番目（1 始まり）の Hand の seed。 */
  readonly seedOfHand: (handNo: number) => number;
  /** Event Store の時計（既定は進む時計）。 */
  readonly now?: InMemoryEventStoreOptions["now"];
  /** 層の計算時間を測る繰り返しの数（中央値。既定 1）。 */
  readonly timingRepeats?: number;
}

export interface SessionRunResult {
  readonly store: InMemoryEventStore;
  /** 進めた順の Session の ID。 */
  readonly sessions: readonly string[];
  readonly decisions: readonly CpuDecisionRecord[];
  readonly hands: readonly HandLayerRecord[];
}

/**
 * Hero の判断（Check できれば Check、できなければ Fold）。Hero が Bust して Session が勝手に終わらないよう、失うのは Blind だけにする
 * （Session の区切りを Eval の側で決めるため）。
 */
function checkOrFold(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  return types.includes("check") ? { type: "check" } : { type: "fold" };
}

/**
 * 本番の Hand Orchestrator（RuleBot・既定の 6 人卓）で Session を順に進め、CPU に渡った入力と、Hand の開始時の層の値・計算時間を記録する。
 * CPU は本番の createRuleBot をそのまま使い、入力を記録して渡すだけ（判断は変えない）。Session を区切る Hand だけ、最初の CPU の判断を
 * 障害にして「Session 終了」を選ぶ（その Hand は打ち切りになり、次の Hand から新しい Session）。
 */
export async function runRuleBotSessions(
  options: SessionRunOptions,
): Promise<SessionRunResult> {
  const setup = PHASE1_TABLE_SETUP;
  const heroId = setup.players.find((p) => p.kind === "hero")?.playerId ?? "";
  const store = new ContextRecordingStore({
    ordinals: createOrdinalCounter(),
    ...(options.now === undefined ? {} : { now: options.now }),
    newEventId: (() => {
      let n = 0;
      return () => `event-${++n}`;
    })(),
  });
  let handNo = 0;
  let sessionNo = 0;
  let failNext = false;
  const decisions: CpuDecisionRecord[] = [];
  const hands: HandLayerRecord[] = [];
  const handLayers = new Map<string, HandLayerRecord>();

  /** その Hand の最初の CPU の判断の時点で、層の値を作り計算時間を測る（進行中の Hand は保存済みでないので入らない）。 */
  const layersOf = (handId: string): HandLayerRecord => {
    const known = handLayers.get(handId);
    if (known !== undefined) return known;
    const context = store.contexts.get(handId);
    const started = store.read(handId)[0]?.event;
    if (context === undefined || started?.type !== "HAND_STARTED") {
      throw new Error(`Hand の開始が記録されていない: ${handId}`);
    }
    const finished = store.finishedHandIds();
    const { layers, timings } = buildLayersAt(
      store,
      context,
      started.seats.map((s) => s.playerId),
      heroId,
      options.timingRepeats,
    );
    const record: HandLayerRecord = {
      handId,
      sessionId: context.sessionId,
      savedHands: finished.length,
      sessionHands: finished.filter(
        (h) => store.sessionIdOfHand(h) === context.sessionId,
      ).length,
      layers,
      timings,
    };
    handLayers.set(handId, record);
    hands.push(record);
    return record;
  };

  const createOpponent: OpponentFactory = (seed, playerId, persona) => {
    const bot = createRuleBot(seed, playerId, persona);
    const handId = `hand-${handNo}`;
    const agent: OpponentAgent = {
      async decide(input, signal) {
        if (failNext) {
          failNext = false;
          throw new Error("Eval: Session を区切る障害");
        }
        layersOf(handId);
        const context = store.contexts.get(handId);
        const output = await bot.decide(input, signal);
        decisions.push({
          handId,
          sessionId: context?.sessionId ?? "",
          playerId,
          uptoSeq: store.read(handId).at(-1)?.event.seq ?? -1,
          input,
          participant: context?.participants.find(
            (p) => p.playerId === playerId,
          ),
          persona,
          output,
        });
        return output;
      },
    };
    return agent;
  };

  const orchestrator = new HandOrchestrator({
    store,
    setup,
    createOpponent,
    botDelayMs: 0,
    opponentTimeoutMs: 5_000,
    nextSeed: () => options.seedOfHand(handNo),
    nextHandId: () => `hand-${++handNo}`,
    nextSessionId: () => `session-${++sessionNo}`,
  });

  /** 1 Hand を終わりまで進める。CPU の障害で止まったら Session 終了を選ぶ。 */
  const play = async (afterHandId: string | null): Promise<string> => {
    const started = await orchestrator.startHand(afterHandId);
    if (!started.ok) throw new Error(started.error.message);
    const { handId } = started.value;
    let view = started.value.view;
    for (let guard = 0; guard < 200; guard++) {
      const outage = orchestrator.outageStatus(handId);
      if (outage?.current != null) {
        const resolved = await orchestrator.resolveOutage(
          handId,
          outage.revision,
          "end_session",
        );
        if (!resolved.ok) throw new Error(resolved.error.message);
        return handId;
      }
      if (view.status === "complete") return handId;
      const acted = await orchestrator.heroAction(
        handId,
        view.log.at(-1)?.seq ?? -1,
        checkOrFold(view),
      );
      if (!acted.ok) throw new Error(acted.error.message);
      view = acted.value;
    }
    throw new Error(`Hand が終わらない: ${handId}`);
  };

  const sessions: string[] = [];
  let last: string | null = null;
  try {
    for (const [i, count] of options.handsPerSession.entries()) {
      for (let played = 0; played < count; played++) {
        last = await play(last);
        const sessionId = store.sessionIdOfHand(last) ?? "";
        if (!sessions.includes(sessionId)) sessions.push(sessionId);
        // Hero が Bust して Session が先に終わったら、その Session はそこまで。
        if (orchestrator.sessionStatus(last)?.state === "ended") break;
      }
      const ended = orchestrator.sessionStatus(last ?? "")?.state === "ended";
      if (i < options.handsPerSession.length - 1 && !ended) {
        failNext = true;
        last = await play(last);
        failNext = false;
      }
    }
  } finally {
    orchestrator.close();
  }
  return { store, sessions, decisions, hands };
}
