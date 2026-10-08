// CPU の KnowledgeState に足す Memory の要約（D121・#139。docs/05 §1・§5・docs/04 §5・§12）。
// 決める側の CPU（Observer）自身の観察から作った Private Hypothesis（opponent-hypothesis.ts）だけを、今の卓の他の参加者
// （Hero・他 CPU）ごとに、上限付きの構造化データへ決定論で畳む（自然言語を正本にしない）。
// - 入力は 1 人の Observer の Hypothesis だけ。他 CPU の Hypothesis・Hidden の Persona・Hero の弱点（learning/）・
//   Learning-only Reveal・Tilt は入れない（不変条件 2。import の検査は memory-injection-isolation.test.ts）
// - context は cash だけを使う（tournament の Hypothesis は Phase 8）
// - 計算は Hand の開始時に、保存済みの（終わった）Hand だけから行う。Hand の途中の Event はその Hand の KnowledgeState が持つ
// - 順序は論理順序（ordinals.ord）と events.seq で決め、壁時計を使わない（D117）
import {
  DEFAULT_MEMORY_POLICY,
  type HypothesisItemId,
  type MemoryPolicy,
} from "./memory-policy.js";
import {
  ObservationCacheReader,
  type ObservationCacheLogger,
  type ObservationCacheStore,
} from "./observation-cache.js";
import {
  buildOpponentHypotheses,
  type OpponentHypothesis,
  type TendencyEstimate,
} from "./opponent-hypothesis.js";
import {
  extractObservedHandsFromStore,
  participantKey,
  type ObservationStore,
  type ObserverRef,
  type ParticipantRef,
} from "./observation.js";

/** 注入の上限（Prompt に渡す量）。Version 付きで、上限の値を変えるときは Version を上げる。 */
export interface MemoryInjectionPolicy {
  readonly version: string;
  /** Subject ごとの傾向の項目の上限（D121 で決めた 5）。 */
  readonly maxItemsPerSubject: number;
  /** 項目ごとに渡す Evidence ID の上限（新しい順）。全件の数は evidenceCount で渡す。 */
  readonly maxEvidencePerItem: number;
}

/**
 * phase7_memory_injection_v1。項目の上限 5 は D121 の採用済みの値。Evidence ID の上限 3 は OI-011 の暫定値で、確定ではない
 * （Prompt の Token を抑えつつ、どの Hand の Action から来た傾向かを辿れるようにする最小限）。
 */
export const PHASE7_MEMORY_INJECTION_V1: MemoryInjectionPolicy = {
  version: "phase7_memory_injection_v1",
  maxItemsPerSubject: 5,
  maxEvidencePerItem: 3,
};

/** Subject の傾向の項目 1 つの要約。 */
export interface MemoryItemSummary {
  readonly item: HypothesisItemId;
  /** recency の重みを掛けた割合（numerator / denominator。小数第 2 位で丸める）。 */
  readonly frequency: number;
  /** recency の重みを掛けた機会の数（小数第 1 位で丸める）。 */
  readonly weightedOpportunities: number;
  /** 重みを掛けない機会の数。 */
  readonly opportunities: number;
  /** 十分な Sample か（false は「保留」。Observer の Skill で基準が変わる。D119）。 */
  readonly sufficient: boolean;
  /** Evidence の全件の数。 */
  readonly evidenceCount: number;
  /** 新しい Evidence の ID（`<hand_id>#<events.seq>`。古い順に並べる）。 */
  readonly evidenceIds: readonly string[];
}

/** 今の卓の他の参加者 1 人についての要約。 */
export interface MemorySubjectSummary {
  /** その Hand での Subject の席（Hand の Event の playerId と同じ値。Hand ごとに変わりうる）。 */
  readonly playerId: string;
  /** 席・player id に依存しない Subject の参照。 */
  readonly subject: ParticipantRef;
  /** Observer がこの Subject を（cash で）見た Hand の数。0 なら初めて同じ卓に座った相手。 */
  readonly handsObserved: number;
  /** 傾向の項目（重み付きの機会の多い順。機会の無い項目は入れない）。 */
  readonly items: readonly MemoryItemSummary[];
}

/** その CPU の KnowledgeState に足す Memory の要約。 */
export interface OpponentMemorySummary {
  /** Hypothesis を作った Policy の Version（phase7_memory_v1 等）。 */
  readonly policyVersion: string;
  /** 注入の上限の Version。 */
  readonly injectionVersion: string;
  readonly context: "cash";
  /** 今の卓の席順。Observer 自身と、誰か引けない席は入れない。 */
  readonly subjects: readonly MemorySubjectSummary[];
}

/** 今の Hand の席 → 参加者（席順）。 */
export interface MemoryTableSeat {
  readonly playerId: string;
  readonly participant: ParticipantRef | null;
}

export interface SummarizeOptions {
  readonly observer: ObserverRef;
  /** Hypothesis を作った Policy の Version。 */
  readonly policyVersion: string;
  /** 今の Hand の席（席順）。 */
  readonly seats: readonly MemoryTableSeat[];
  readonly injection?: MemoryInjectionPolicy;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function summarizeItem(
  t: TendencyEstimate,
  maxEvidence: number,
): MemoryItemSummary {
  return {
    item: t.item,
    frequency: round(t.denominator > 0 ? t.numerator / t.denominator : 0, 2),
    weightedOpportunities: round(t.denominator, 1),
    opportunities: t.opportunities,
    sufficient: t.sufficient,
    evidenceCount: t.evidence.length,
    // Evidence は論理順序・seq の順なので、末尾が新しい。
    evidenceIds: t.evidence
      .slice(Math.max(0, t.evidence.length - maxEvidence))
      .map((e) => `${e.handId}#${e.seq}`),
  };
}

/**
 * 1 人の Observer の Hypothesis を、今の卓の他の参加者ごとの要約にする（純粋関数。同じ入力なら同じ結果）。
 * - 別の Observer の Hypothesis が混ざっていたら拒否する（他 CPU の Private Memory を混ぜない）
 * - cash の Hypothesis だけを使う
 * - 項目は機会のあるものを重み付きの機会の多い順（同じなら Policy の項目の順）に上限まで
 */
export function summarizeOpponentMemory(
  hypotheses: readonly OpponentHypothesis[],
  options: SummarizeOptions,
): OpponentMemorySummary {
  const injection = options.injection ?? PHASE7_MEMORY_INJECTION_V1;
  const self = participantKey(options.observer);
  const bySubject = new Map<string, OpponentHypothesis>();
  for (const h of hypotheses) {
    if (participantKey(h.observer) !== self) {
      throw new RangeError(
        "別の Observer の Hypothesis（Private Memory を混ぜない）",
      );
    }
    if (h.policyVersion !== options.policyVersion) {
      throw new RangeError(
        `Hypothesis の Policy の Version ${h.policyVersion} が ${options.policyVersion} と違う`,
      );
    }
    if (h.context !== "cash") continue;
    bySubject.set(participantKey(h.subject), h);
  }

  const subjects: MemorySubjectSummary[] = [];
  for (const seat of options.seats) {
    if (seat.participant === null) continue;
    const key = participantKey(seat.participant);
    if (key === self) continue;
    const h = bySubject.get(key);
    const items =
      h === undefined
        ? []
        : h.tendencies
            .map((t, order) => ({ t, order }))
            .filter(({ t }) => t.opportunities > 0)
            .sort(
              (a, b) => b.t.denominator - a.t.denominator || a.order - b.order,
            )
            .slice(0, injection.maxItemsPerSubject)
            .map(({ t }) => summarizeItem(t, injection.maxEvidencePerItem));
    subjects.push({
      playerId: seat.playerId,
      subject: seat.participant,
      handsObserved: h?.handsObserved ?? 0,
      items,
    });
  }
  return {
    policyVersion: options.policyVersion,
    injectionVersion: injection.version,
    context: "cash",
    subjects,
  };
}

/** Event Store から Memory を作るときの、CPU の席 1 つ分の入力。 */
export interface MemoryObserverSeat {
  /** その Hand での Observer の席。 */
  readonly playerId: string;
  readonly observer: ObserverRef;
  /** Observer の Persona の Skill（0〜1）。 */
  readonly observerSkill: number;
  /**
   * Observer に効く Opponent Memory Reset の区切りの ord（D120・memory-reset.ts）。これより大きい ord の Hand だけから Memory を作る。
   * 省略・null は区切り無し（全期間）。
   */
  readonly afterOrd?: number | null;
}

/** Event Store から Memory を作るときの入力。 */
export interface MemoryFromStoreInput {
  readonly heroPlayerId: string;
  /** 今の Session（Guest は Observer・Subject のどちらでもこの Session のものだけを読む。D118）。 */
  readonly currentSessionId: string;
  /** 今の Hand の席（席順）。 */
  readonly seats: readonly MemoryTableSeat[];
  /** Memory を作る CPU の席（参加者の引ける CPU だけ）。 */
  readonly observers: readonly MemoryObserverSeat[];
  readonly policy?: MemoryPolicy;
  /**
   * Observation の Cache（D124・#165。observation-cache.ts）。省略時は Cache を使わず、Event Log から都度抽出する（メモリ内の Event Store）。
   * Cache の有無で結果は変わらない。logger は Cache の読み書きの失敗を残す先。
   */
  readonly observationCache?: {
    readonly store: ObservationCacheStore;
    readonly logger: ObservationCacheLogger;
  };
}

/**
 * 1 回の計算の間だけ、Hand の Event と Session の参加者の読み出しを使い回す（CPU の数だけ同じ Hand を読み直さない）。
 * 書き込みの API は持たないので、計算の途中で Store を変えることはない。
 */
function cachedObservationStore(store: ObservationStore): ObservationStore {
  const reads = new Map<string, ReturnType<ObservationStore["read"]>>();
  const participants = new Map<
    string,
    ReturnType<ObservationStore["sessionParticipants"]>
  >();
  // 保存済みの Hand の一覧・Hand の Session・論理順序も、CPU ごとに引き直さない（#165。Hand ごとの引きが CPU の数だけ重なっていた）。
  let finished: ReturnType<ObservationStore["finishedHandIds"]> | undefined;
  const sessionOf = new Map<string, string | null>();
  const ordOf = new Map<string, number | null>();
  return {
    finishedHandIds: () => (finished ??= store.finishedHandIds()),
    sessionIdOfHand: (handId) => {
      let sessionId = sessionOf.get(handId);
      if (sessionId === undefined) {
        sessionId = store.sessionIdOfHand(handId);
        sessionOf.set(handId, sessionId);
      }
      return sessionId;
    },
    savedOrder: (handId) => {
      let ord = ordOf.get(handId);
      if (ord === undefined) {
        ord = store.savedOrder(handId);
        ordOf.set(handId, ord);
      }
      return ord;
    },
    read: (handId) => {
      let events = reads.get(handId);
      if (events === undefined) {
        events = store.read(handId);
        reads.set(handId, events);
      }
      return events;
    },
    sessionParticipants: (sessionId) => {
      let rows = participants.get(sessionId);
      if (rows === undefined) {
        rows = store.sessionParticipants(sessionId);
        participants.set(sessionId, rows);
      }
      return rows;
    },
  };
}

/**
 * 保存済みの Hand から、CPU ごとにその CPU 自身の Memory の要約を作る（Hypothesis・要約は都度計算で保存しない。observationCache を
 * 渡したときだけ、Hand ごとの観察の抽出結果を Cache に足して使い回す〔D124〕）。返す Map の鍵は Observer の席。
 * 呼ぶのは Hand の開始時で、その Hand を Event Store へ書く前（＝保存済みの Hand だけが入力になる）。
 * CPU ごとに、その CPU を Observer とする観察だけから作る（別の CPU の観察を混ぜない）。
 */
export function buildOpponentMemoriesFromStore(
  store: ObservationStore,
  input: MemoryFromStoreInput,
): Map<string, OpponentMemorySummary> {
  const policy = input.policy ?? DEFAULT_MEMORY_POLICY;
  const cached = cachedObservationStore(store);
  // Cache の読み手は 1 回の計算の間だけ（同じ Hand の public の Event の復元を CPU 間で使い回す）。
  const reader =
    input.observationCache === undefined
      ? null
      : new ObservationCacheReader(
          input.observationCache.store,
          input.observationCache.logger,
        );
  const memories = new Map<string, OpponentMemorySummary>();
  for (const seat of input.observers) {
    const query = {
      observer: seat.observer,
      heroPlayerId: input.heroPlayerId,
      currentSessionId: input.currentSessionId,
      afterOrd: seat.afterOrd ?? null,
    };
    const hands =
      reader === null
        ? extractObservedHandsFromStore(cached, query)
        : reader.extract(cached, query);
    const hypotheses = buildOpponentHypotheses(hands, {
      observer: seat.observer,
      observerSkill: seat.observerSkill,
      policy,
    });
    memories.set(
      seat.playerId,
      summarizeOpponentMemory(hypotheses, {
        observer: seat.observer,
        policyVersion: policy.version,
        seats: input.seats,
      }),
    );
  }
  return memories;
}
