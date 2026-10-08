// CPU の Private Hypothesis（Observer × Subject × Context。D106・D119・#138。docs/05 §5・docs/04 §12）。
// Observer が観察した Hand（observation.ts の ObservedHand。public の Event だけ）から、Subject の観察可能な傾向の頻度を
// recency decay 付きで数える決定論の純粋関数。結果は保存しない（D111 と同じ。Observation から都度作り直せる Projection）。
// - 入力は 1 人の Observer の観察だけ。別の Observer の観察を混ぜた入力は拒否する（CPU A の B への仮説を C の観察から作らない）
// - context（cash / tournament）ごとに分ける。Raw Observation は共通で、Hypothesis だけを分ける（D106）
// - decay と順序は論理順序（ordinals.ord）と Hand の数で決め、壁時計を使わない（D117。#129・#130 の再発防止）
// - Hero の Weakness Hypothesis（apps/server/src/learning/）とは別物で、import も型の共有もしない（不変条件 2）
// 傾向の数え方は Engine の Stats の定義（STAT_DEFINITIONS。public の Event だけを読む）をそのまま使う。
import {
  STAT_DEFINITIONS,
  toStatsHand,
  type StatContribution,
  type StatDefinition,
  type StatsHand,
} from "@proj-poker/engine";
import type { EventStore } from "../event-store.js";
import {
  DEFAULT_MEMORY_POLICY,
  type HypothesisItemId,
  type MemoryPolicy,
} from "./memory-policy.js";
import {
  extractObservedHandsFromStore,
  participantKey,
  type ObservationContext,
  type ObservationQuery,
  type ObservedHand,
  type ObserverRef,
  type ParticipantRef,
} from "./observation.js";

/** 傾向の Evidence 1 件（Observation の provenance。hand_id・events.seq・ordinals.ord）。 */
export interface HypothesisEvidence {
  readonly handId: string;
  readonly seq: number;
  readonly ord: number;
}

/** 傾向の項目 1 つの推定。割合は numerator / denominator で、読む側が計算する。 */
export interface TendencyEstimate {
  readonly item: HypothesisItemId;
  readonly policyVersion: string;
  /** recency の重みを掛けた分子。 */
  readonly numerator: number;
  /** recency の重みを掛けた分母（重み付きの機会数。十分な Sample の判定に使う）。 */
  readonly denominator: number;
  /** 重みを掛けない機会の数。 */
  readonly opportunities: number;
  /** 重み付きの機会数が、Observer の Skill に応じた基準以上か（不十分なら「保留」として扱う）。 */
  readonly sufficient: boolean;
  /** この項目に入った Subject の Action の Event（論理順序・seq の順）。 */
  readonly evidence: readonly HypothesisEvidence[];
}

/** Observer が Subject について Context ごとに持つ Private Hypothesis。 */
export interface OpponentHypothesis {
  readonly observer: ObserverRef;
  readonly subject: ParticipantRef;
  readonly context: ObservationContext;
  readonly policyVersion: string;
  /** Observer がこの Subject をこの context で見た Hand の数。 */
  readonly handsObserved: number;
  /** 最後に見た Hand の論理順序の番号。 */
  readonly lastOrd: number;
  /** Policy の項目の順。 */
  readonly tendencies: readonly TendencyEstimate[];
}

export interface HypothesisOptions {
  /** Hypothesis を持つ Observer（入力の観察はすべてこの Observer のものでなければならない）。 */
  readonly observer: ObserverRef;
  /** Observer の Persona の Skill（0〜1）。Fixed CPU は Pool の Persona、Guest は席の Persona から呼び出し側が引く。 */
  readonly observerSkill: number;
  readonly policy?: MemoryPolicy;
}

/** Subject が座っていた 1 Hand（Stats の入力に畳んだもの）。 */
interface SubjectHand {
  readonly hand: ObservedHand;
  readonly stats: StatsHand;
  readonly playerId: string;
}

interface Group {
  readonly subject: ParticipantRef;
  readonly context: ObservationContext;
  readonly hands: SubjectHand[];
}

function definitionOf(item: HypothesisItemId): StatDefinition {
  const def = STAT_DEFINITIONS.find((d) => d.id === item);
  if (def === undefined)
    throw new RangeError(`傾向の項目 ${item} の定義が無い`);
  return def;
}

/** その Hand の、Subject の Action のうち、寄与した Street のもの（Evidence）。 */
function evidenceOf(
  entry: SubjectHand,
  contributions: readonly StatContribution[],
): HypothesisEvidence[] {
  const streets = new Set(contributions.map((c) => c.street));
  return entry.hand.events.flatMap((e): HypothesisEvidence[] =>
    e.event.type === "ACTION_TAKEN" &&
    e.event.playerId === entry.playerId &&
    streets.has(e.event.street)
      ? [{ handId: entry.hand.handId, seq: e.seq, ord: entry.hand.ord }]
      : [],
  );
}

function estimate(
  group: Group,
  item: HypothesisItemId,
  policy: MemoryPolicy,
  sufficientAt: number,
): TendencyEstimate {
  const def = definitionOf(item);
  const n = group.hands.length;
  let numerator = 0;
  let denominator = 0;
  let opportunities = 0;
  const evidence: HypothesisEvidence[] = [];
  // 古い Hand から順に足す（足す順を固定して、浮動小数の結果も入力の並びに依らないようにする）。
  group.hands.forEach((entry, i) => {
    const contributions = def.contribute(entry.stats, entry.playerId);
    if (contributions.length === 0) return;
    // 最新の Hand が age 0。Observer がこの Subject を見た Hand の数で減衰する（D119）。
    const weight = policy.recencyWeight(n - 1 - i);
    for (const c of contributions) {
      numerator += weight * c.numerator;
      denominator += weight * c.denominator;
      opportunities += c.opportunities;
    }
    evidence.push(...evidenceOf(entry, contributions));
  });
  return {
    item,
    policyVersion: policy.version,
    numerator,
    denominator,
    opportunities,
    sufficient: denominator >= sufficientAt,
    evidence,
  };
}

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 1 人の Observer の観察から、Subject × Context ごとの Private Hypothesis を作る（純粋関数。同じ入力なら同じ結果）。
 * - Observer 自身と、誰か引けない席（前の Session の Guest・参加者の無い席）は Subject にしない
 * - HAND_FINISHED まで済んでいない Hand（打ち切った Hand）は Stats と同じく数えない（見た Hand の数にも入れない）
 * - 並びは context、Subject の鍵の順（locale・入力の並びに依らない）
 */
export function buildOpponentHypotheses(
  hands: readonly ObservedHand[],
  options: HypothesisOptions,
): OpponentHypothesis[] {
  const policy = options.policy ?? DEFAULT_MEMORY_POLICY;
  const sufficientAt = policy.sufficientOpportunities(options.observerSkill);
  const self = participantKey(options.observer);
  const ords = new Set<number>();
  for (const hand of hands) {
    if (participantKey(hand.observer) !== self) {
      throw new RangeError(
        `Hand ${hand.handId} は別の Observer の観察（Private Memory を混ぜない）`,
      );
    }
    if (!Number.isSafeInteger(hand.ord) || ords.has(hand.ord)) {
      throw new RangeError(
        `Hand ${hand.handId} の論理順序の番号 ${hand.ord} が不正か重複している`,
      );
    }
    ords.add(hand.ord);
  }

  const groups = new Map<string, Group>();
  for (const hand of [...hands].sort((a, b) => a.ord - b.ord)) {
    const stats = toStatsHand(hand.events.map((e) => e.event));
    if (stats === null) continue;
    for (const seat of hand.seats) {
      if (seat.participant === null) continue;
      const subjectKey = participantKey(seat.participant);
      if (subjectKey === self) continue;
      const key = JSON.stringify([hand.context, subjectKey]);
      let group = groups.get(key);
      if (group === undefined) {
        group = { subject: seat.participant, context: hand.context, hands: [] };
        groups.set(key, group);
      }
      group.hands.push({ hand, stats, playerId: seat.playerId });
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => compareKey(a, b))
    .map(([, group]) => ({
      observer: options.observer,
      subject: group.subject,
      context: group.context,
      policyVersion: policy.version,
      handsObserved: group.hands.length,
      lastOrd: group.hands[group.hands.length - 1]?.hand.ord ?? 0,
      tendencies: policy.items.map((item) =>
        estimate(group, item, policy, sufficientAt),
      ),
    }));
}

/** Event Store から Observer の観察を抽出し、Private Hypothesis を作る（都度計算。保存しない）。 */
export function buildOpponentHypothesesFromStore(
  store: EventStore,
  query: ObservationQuery,
  options: Omit<HypothesisOptions, "observer">,
): OpponentHypothesis[] {
  return buildOpponentHypotheses(extractObservedHandsFromStore(store, query), {
    ...options,
    observer: query.observer,
  });
}
