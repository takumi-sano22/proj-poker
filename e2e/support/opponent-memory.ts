// E2E のテストプロセスから、server の一時 DB を読み取り専用で開き、CPU の Memory・Tilt を apps/server の Projection の関数で作り直す
// （Phase 7 の Critical E2E。#144・docs/09 §8）。Hidden の Memory・Persona・Tilt は Hero の画面・API に出さない（D105・D107）ので、
// 確認用の API を本番に足さず、server が Hand の開始時に使うのと同じ関数（buildOpponentMemoriesFromStore・buildTiltsFromStore）に、
// 正本（Event Log・session_participants・opponent_memory_resets）を渡して確かめる。
// - 「Hand H の開始時」の値は、H より前に保存された Hand（論理順序 ord が H より小さい Hand）だけを入力にして作る。1 卓を順に進める E2E では、
//   H の途中で別の Hand が保存されることは無いので、server が H の開始時に読んだ入力と同じになる
// - DB は readOnly で開くので、ここから書き込むことは無い（Store の書き込み用の文は準備だけされ、実行しない）
import { DatabaseSync } from "node:sqlite";
import type { SessionParticipant } from "../../apps/server/src/opponents/cpu-pool.js";
import {
  buildOpponentMemoriesFromStore,
  type MemoryObserverSeat,
  type MemoryTableSeat,
  type OpponentMemorySummary,
} from "../../apps/server/src/memory/memory-summary.js";
import { SqliteOpponentMemoryResetStore } from "../../apps/server/src/memory/memory-reset.js";
import {
  participantKey,
  participantRefOf,
  type ObservationStore,
  type ObserverRef,
} from "../../apps/server/src/memory/observation.js";
import {
  PERSONA_PRESETS,
  type PersonaPresetId,
} from "../../apps/server/src/opponents/persona.js";
import {
  buildTiltsFromStore,
  type CpuTilt,
} from "../../apps/server/src/opponents/tilt.js";
import { SqliteEventStore } from "../../apps/server/src/sqlite-event-store.js";

/** Hero の playerId（apps/server/src/config.ts の卓の設定と同じ）。 */
const HERO_ID = "hero";
/** Persona の無い CPU の Skill（hand-orchestrator.ts の AVERAGE_SKILL と同じ）。 */
const AVERAGE_SKILL = 0.5;

/** 保存済みの Hand 1 つ（論理順序・Session・席）。 */
export interface SavedHand {
  readonly handId: string;
  readonly sessionId: string;
  readonly ord: number;
  /** HAND_STARTED の席順の playerId（Hero を含む）。 */
  readonly seatIds: readonly string[];
}

/** その Hand の CPU の席 1 つ（席の playerId と、その Session の参加者）。 */
export interface CpuSeatOfHand {
  readonly playerId: string;
  readonly participant: SessionParticipant;
  /** 参加者の鍵（Fixed CPU は cpu_profile、Guest は guest。participantKey の値）。 */
  readonly key: string;
}

export interface OpponentMemoryProbe {
  /** 保存済みの Hand（論理順序の小さい順）。 */
  savedHands(): SavedHand[];
  /** Session の CPU の参加者（席順。session_participants）。 */
  participants(sessionId: string): readonly SessionParticipant[];
  /** Hand の CPU の席と、その Session の参加者。 */
  cpuSeatsOf(handId: string): CpuSeatOfHand[];
  /**
   * Hand H の開始時に、server がその Hand の CPU ごとに作った Memory の要約（鍵は Observer の席）。
   * withResets が true なら、Observer に効く Opponent Memory Reset の区切り（今の DB にある行）を server と同じく当てる。
   */
  memoriesAt(
    handId: string,
    options: { readonly withResets: boolean },
  ): Map<string, OpponentMemorySummary>;
  /** Hand H の開始時の CPU ごとの Tilt（1 以上の席だけ。鍵は席）。 */
  tiltsAt(handId: string): ReadonlyMap<string, CpuTilt>;
  /** Hand H を終えた時点（H まで保存した時点）の CPU ごとの Tilt。Session の最後の Hand に使えば、その Session の終わりの Tilt。 */
  tiltsAfter(handId: string): ReadonlyMap<string, CpuTilt>;
  /** Observer に効く Opponent Memory Reset の区切りの ord（無ければ null）。 */
  resetBoundary(observer: ObserverRef): number | null;
  close(): void;
}

/** 論理順序 ord より前（upToOrd を含むかは inclusive で決める）に保存された Hand だけを見せる Store。 */
function storeUpTo(
  store: SqliteEventStore,
  upToOrd: number,
  inclusive: boolean,
): ObservationStore {
  return {
    finishedHandIds: () =>
      store.finishedHandIds().filter((handId) => {
        const ord = store.savedOrder(handId);
        return ord !== null && (inclusive ? ord <= upToOrd : ord < upToOrd);
      }),
    sessionIdOfHand: (handId) => store.sessionIdOfHand(handId),
    savedOrder: (handId) => store.savedOrder(handId),
    read: (handId) => store.read(handId),
    sessionParticipants: (sessionId) => store.sessionParticipants(sessionId),
  };
}

/** DB を読み取り専用で開く。server が動いている間に開いてよい（SQLite の読み取り）。使い終えたら close する。 */
export function openOpponentMemoryProbe(dbPath: string): OpponentMemoryProbe {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const store = new SqliteEventStore(db);
  const resets = new SqliteOpponentMemoryResetStore(db);
  // その Session の Persona の割り当て（Fixed CPU は Pool の Persona、Guest は席の Persona）。Observer の Skill に使う（server と同じ）。
  const selectPersonas = db.prepare(
    "SELECT personas FROM session_projections WHERE session_id = ?",
  );

  const savedHand = (handId: string): SavedHand => {
    const sessionId = store.sessionIdOfHand(handId);
    const ord = store.savedOrder(handId);
    if (sessionId === null || ord === null) {
      throw new Error(`保存済みの Hand ではない: ${handId}`);
    }
    const started = store
      .read(handId)
      .map((s) => s.event)
      .find((e) => e.type === "HAND_STARTED");
    if (started?.type !== "HAND_STARTED") {
      throw new Error(`HAND_STARTED が無い: ${handId}`);
    }
    return {
      handId,
      sessionId,
      ord,
      seatIds: started.seats.map((s) => s.playerId),
    };
  };

  const personasOf = (
    sessionId: string,
  ): Record<string, PersonaPresetId | undefined> => {
    const row = selectPersonas.get(sessionId) as
      { personas: string } | undefined;
    return row === undefined
      ? {}
      : (JSON.parse(row.personas) as Record<string, PersonaPresetId>);
  };

  const cpuSeatsOf = (handId: string): CpuSeatOfHand[] => {
    const hand = savedHand(handId);
    const participants = store.sessionParticipants(hand.sessionId);
    return hand.seatIds.flatMap((playerId) => {
      const participant = participants.find((p) => p.playerId === playerId);
      return participant === undefined
        ? []
        : [
            {
              playerId,
              participant,
              key: participantKey(participantRefOf(participant)),
            },
          ];
    });
  };

  const tiltsOf = (handId: string, inclusive: boolean) => {
    const hand = savedHand(handId);
    const personas = personasOf(hand.sessionId);
    const seats = hand.seatIds.flatMap((playerId) => {
      const presetId = personas[playerId];
      if (playerId === HERO_ID || presetId === undefined) return [];
      return [{ playerId, traits: PERSONA_PRESETS[presetId].traits }];
    });
    return buildTiltsFromStore(storeUpTo(store, hand.ord, inclusive), {
      sessionId: hand.sessionId,
      seats,
    });
  };

  return {
    savedHands: () =>
      store
        .finishedHandIds()
        .map(savedHand)
        .sort((a, b) => a.ord - b.ord),
    participants: (sessionId) => store.sessionParticipants(sessionId),
    cpuSeatsOf,
    memoriesAt: (handId, { withResets }) => {
      // server の HandOrchestrator.opponentMemories と同じ入力の組み立て（席・Observer・Skill・Reset の区切り）。
      const hand = savedHand(handId);
      const personas = personasOf(hand.sessionId);
      const participants = store.sessionParticipants(hand.sessionId);
      const seats: MemoryTableSeat[] = hand.seatIds.map((playerId) => {
        const p = participants.find((q) => q.playerId === playerId);
        return {
          playerId,
          participant:
            playerId === HERO_ID
              ? { kind: "hero" }
              : p === undefined
                ? null
                : participantRefOf(p),
        };
      });
      const observers: MemoryObserverSeat[] = cpuSeatsOf(handId).map(
        ({ playerId, participant }) => {
          const presetId = personas[playerId];
          const observer = participantRefOf(participant);
          return {
            playerId,
            observer,
            observerSkill:
              presetId === undefined
                ? AVERAGE_SKILL
                : PERSONA_PRESETS[presetId].traits.skill,
            afterOrd: withResets
              ? (resets.boundaryFor(observer)?.ord ?? null)
              : null,
          };
        },
      );
      return buildOpponentMemoriesFromStore(storeUpTo(store, hand.ord, false), {
        heroPlayerId: HERO_ID,
        currentSessionId: hand.sessionId,
        seats,
        observers,
      });
    },
    tiltsAt: (handId) => tiltsOf(handId, false),
    tiltsAfter: (handId) => tiltsOf(handId, true),
    resetBoundary: (observer) => resets.boundaryFor(observer)?.ord ?? null,
    close: () => db.close(),
  };
}

/** Memory の要約の Evidence ID（`<handId>#<seq>`）が指す Hand。 */
export function evidenceHandIds(summary: OpponentMemorySummary): Set<string> {
  const ids = new Set<string>();
  for (const subject of summary.subjects) {
    for (const item of subject.items) {
      for (const id of item.evidenceIds) ids.add(id.split("#")[0] ?? "");
    }
  }
  return ids;
}
