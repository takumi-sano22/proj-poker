import {
  applyAction,
  foldHandEvents,
  getLegalActions,
  PHASE1_CASH_PRESET,
  startHand,
  type HandEvent,
} from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventSeqConflictError,
  InMemoryEventStore,
  type EventStore,
  type InMemoryEventStoreOptions,
} from "./event-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

function sampleEvents(): readonly HandEvent[] {
  const result = startHand({
    handId: "h1",
    seats: [
      { playerId: "a", stack: 200 },
      { playerId: "b", stack: 200 },
    ],
    buttonPlayerId: "a",
    config: PHASE1_CASH_PRESET,
    deal: { seed: 1 },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.events;
}

/** sampleEvents の続き: 手番の Player が Fold して HAND_FINISHED まで進めた Event。 */
function finishingEvents(started: readonly HandEvent[]): readonly HandEvent[] {
  const state = foldHandEvents(started);
  const actor = getLegalActions(state)?.playerId;
  if (actor === undefined) throw new Error("手番が無い");
  const result = applyAction(state, actor, { type: "fold" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.events;
}

// 開いた SQLite の Store はテストごとに閉じる。
const opened: SqliteEventStore[] = [];
afterEach(() => {
  opened.splice(0).forEach((store) => store.close());
});

// Interface（EventStore）の契約は、どの実装でも同じテストで確かめる。
// SQLite 実装の Hand 途中の Event はメモリ側にあり、ここでの検査はその経路を通る（保存の経路は sqlite-event-store.test.ts）。
const implementations: [
  string,
  (options?: InMemoryEventStoreOptions) => EventStore,
][] = [
  ["InMemoryEventStore", (options) => new InMemoryEventStore(options)],
  [
    "SqliteEventStore",
    (options) => {
      const store = SqliteEventStore.open(":memory:", options);
      opened.push(store);
      return store;
    },
  ],
];

describe.each(implementations)("%s", (_name, createStore) => {
  it("追記した Event を seq 順に返し、event_id と記録時刻を付ける", () => {
    let id = 0;
    const store = createStore({
      now: () => new Date("2026-10-05T00:00:00Z"),
      newEventId: () => `e${++id}`,
    });
    const events = sampleEvents();
    store.append("h1", events.slice(0, 2));
    store.append("h1", events.slice(2));

    const stored = store.read("h1");
    expect(stored.map((s) => s.event)).toEqual(events);
    expect(stored[0]).toMatchObject({
      eventId: "e1",
      handId: "h1",
      recordedAt: "2026-10-05T00:00:00.000Z",
    });
    expect(store.read("unknown")).toEqual([]);
  });

  it("seq が連続しない追記（二重追記・抜け）は何も書かずに拒否する", () => {
    const store = createStore();
    const events = sampleEvents();
    store.append("h1", events.slice(0, 3));

    // 同じ Event をもう一度（二重追記）。
    expect(() => store.append("h1", events.slice(0, 3))).toThrow(
      EventSeqConflictError,
    );
    // 途中が抜けている。
    expect(() => store.append("h1", events.slice(4, 6))).toThrow(
      EventSeqConflictError,
    );
    // 先頭は正しいが途中で連番が崩れる（一部だけ書かれてはいけない）。
    expect(() =>
      store.append("h1", [events[3] as HandEvent, events[5] as HandEvent]),
    ).toThrow(EventSeqConflictError);
    expect(store.read("h1").length).toBe(3);
  });

  it("HAND_FINISHED の後ろへの追記と、HAND_FINISHED の後ろに Event が続く追記は何も書かずに拒否する", () => {
    const started = sampleEvents();
    const rest = finishingEvents(started);
    const finished = rest.at(-1) as HandEvent;
    expect(finished.type).toBe("HAND_FINISHED");

    // 同じ追記の中で HAND_FINISHED の後ろに Event が続く。
    const store = createStore();
    store.append("h1", started);
    expect(() =>
      store.append("h1", [...rest, { ...finished, seq: finished.seq + 1 }]),
    ).toThrow(EventSeqConflictError);
    expect(store.read("h1").length).toBe(started.length);

    // 終わった Hand の後ろへ、次の seq で足す。
    store.append("h1", rest);
    expect(() =>
      store.append("h1", [{ ...finished, seq: finished.seq + 1 }]),
    ).toThrow(EventSeqConflictError);
    expect(store.read("h1").map((s) => s.event)).toEqual([...started, ...rest]);
  });

  it("追記に渡した Event や read で得た Event を書き換えても、保存済みの Log は変わらない", () => {
    const store = createStore();
    const events = structuredClone(sampleEvents()) as HandEvent[];
    store.append("h1", events);
    const snapshot = structuredClone(store.read("h1").map((s) => s.event));

    // 呼び出し側が持ち続けている元の Event を書き換える。
    const original = events[0] as { handId?: string };
    original.handId = "tampered";
    expect(store.read("h1").map((s) => s.event)).toEqual(snapshot);

    // read で得た Event とその配下（Card など）は凍結されていて書き換えられない。
    const stored = store.read("h1")[1]?.event;
    expect(stored?.type).toBe("DECK_SHUFFLED");
    if (stored?.type === "DECK_SHUFFLED") {
      expect(() => {
        (stored.deck as unknown[]).pop();
      }).toThrow(TypeError);
      expect(() => {
        (stored.deck[0] as { rank: number }).rank = 2;
      }).toThrow(TypeError);
    }
    expect(store.read("h1").map((s) => s.event)).toEqual(snapshot);
  });

  it("read の戻り値を書き換えても Log は変わらない", () => {
    const store = createStore();
    store.append("h1", sampleEvents());
    const copy = store.read("h1") as unknown[];
    const length = copy.length;
    copy.pop();
    expect(store.read("h1").length).toBe(length);
  });

  it("listHands は開始の新しい順に返し、HAND_FINISHED の無い Hand は finishedAt が null（limit で件数を絞る）", () => {
    let minute = 0;
    const store = createStore({
      now: () => new Date(Date.UTC(2026, 9, 5, 0, minute++)),
    });
    expect(store.listHands(10)).toEqual([]);
    const started = sampleEvents();
    // h1: 終わった Hand（00:00 に開始・00:01 に終了）。h2: 途中の Hand（00:02 に開始）。
    store.append("h1", started);
    store.append("h1", finishingEvents(started));
    store.append("h2", started);

    expect(store.listHands(10)).toEqual([
      { handId: "h2", startedAt: "2026-10-05T00:02:00.000Z", finishedAt: null },
      {
        handId: "h1",
        startedAt: "2026-10-05T00:00:00.000Z",
        finishedAt: "2026-10-05T00:01:00.000Z",
      },
    ]);
    expect(store.listHands(1).map((h) => h.handId)).toEqual(["h2"]);
  });
});
