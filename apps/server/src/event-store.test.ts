import {
  applyAction,
  foldHandEvents,
  getLegalActions,
  PHASE1_CASH_PRESET,
  recordSessionEvent,
  startHand,
  type HandEvent,
  type SessionEventBody,
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

/** Event の後ろに Session・Hand の運用の Event を続ける（seq は Engine が付ける）。 */
function withSessionEvents(
  events: readonly HandEvent[],
  ...bodies: SessionEventBody[]
): HandEvent[] {
  const out = [...events];
  let state = foldHandEvents(events);
  for (const body of bodies) {
    const recorded = recordSessionEvent(state, body);
    out.push(...recorded.events);
    state = recorded.state;
  }
  return out;
}

/** sampleEvents の続き: 手番の Player の障害で Hand を打ち切り、Session を終えた Event（D95）。 */
function abortingEvents(started: readonly HandEvent[]): HandEvent[] {
  return withSessionEvents(
    started,
    { type: "HAND_ABORTED", reason: "ai_outage" },
    { type: "SESSION_ENDED", sessionId: "s1", reason: "ai_outage" },
  ).slice(started.length);
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
      {
        handId: "h2",
        startedAt: "2026-10-05T00:02:00.000Z",
        finishedAt: null,
        aborted: false,
      },
      {
        handId: "h1",
        startedAt: "2026-10-05T00:00:00.000Z",
        finishedAt: "2026-10-05T00:01:00.000Z",
        aborted: false,
      },
    ]);
    expect(store.listHands(1).map((h) => h.handId)).toEqual(["h2"]);
  });

  it("sessionHandIds は同じ Session の終わった Hand を、finishedHandIds は終わった Hand すべてを開始の古い順に返す（#116）", () => {
    let minute = 0;
    const store = createStore({
      now: () => new Date(Date.UTC(2026, 9, 5, 0, minute++)),
    });
    const started = sampleEvents();
    // s1: h1・h3（終わった）と h4（途中）。s2: h2（終わった）。
    for (const [handId, sessionId] of [
      ["h1", "s1"],
      ["h2", "s2"],
      ["h3", "s1"],
    ] as const) {
      store.append(handId, started, { sessionId });
      store.append(handId, finishingEvents(started));
    }
    store.append("h4", started, { sessionId: "s1" });

    expect(store.sessionHandIds("h3")).toEqual(["h1", "h3"]);
    expect(store.sessionHandIds("h2")).toEqual(["h2"]);
    // 途中の Hand からも、その Session の終わった Hand を引ける。
    expect(store.sessionHandIds("h4")).toEqual(["h1", "h3"]);
    expect(store.sessionHandIds("unknown")).toEqual([]);
    expect(store.finishedHandIds()).toEqual(["h1", "h2", "h3"]);
  });

  it("Hand の終わりの後ろには、同じ追記の SESSION_ENDED 1 つだけを置ける（D95）", () => {
    const started = sampleEvents();
    const rest = finishingEvents(started);
    const all = withSessionEvents([...started, ...rest], {
      type: "SESSION_ENDED",
      sessionId: "s1",
      reason: "hero_busted",
    });
    const ended = all.at(-1) as HandEvent;
    const store = createStore();
    store.append("h1", started);
    // SESSION_ENDED が 2 つ続く・SESSION_ENDED 以外が続く追記は、何も書かずに拒否する。
    expect(() =>
      store.append("h1", [...rest, ended, { ...ended, seq: ended.seq + 1 }]),
    ).toThrow(EventSeqConflictError);
    expect(() =>
      store.append("h1", [
        ...rest,
        { ...(rest.at(-1) as HandEvent), seq: ended.seq },
      ]),
    ).toThrow(EventSeqConflictError);
    expect(store.read("h1").length).toBe(started.length);

    store.append("h1", [...rest, ended]);
    expect(store.read("h1").map((s) => s.event)).toEqual(all);
    // 終わった Hand へは、SESSION_ENDED の後ろにも足せない。
    expect(() =>
      store.append("h1", [{ ...ended, seq: ended.seq + 1 }]),
    ).toThrow(EventSeqConflictError);
  });

  it("HAND_ABORTED で Hand が終わる。一覧では aborted で finishedAt は null、後ろへは追記できない（D95）", () => {
    let minute = 0;
    const store = createStore({
      now: () => new Date(Date.UTC(2026, 9, 5, 0, minute++)),
    });
    const started = sampleEvents();
    const aborted = abortingEvents(started);
    store.append("h1", started);
    store.append("h1", aborted, { sessionId: "s1" });
    expect(store.read("h1").map((s) => s.event)).toEqual([
      ...started,
      ...aborted,
    ]);
    expect(store.listHands(10)).toEqual([
      {
        handId: "h1",
        startedAt: "2026-10-05T00:00:00.000Z",
        finishedAt: null,
        aborted: true,
      },
    ]);
    expect(() =>
      store.append("h1", [
        { ...(aborted.at(-1) as HandEvent), seq: started.length + 2 },
      ]),
    ).toThrow(EventSeqConflictError);
  });

  it("Session Projection: Hand が終わるたびに Session ごとに作り替え、latestSessionProjection は最後に Hand が終わった Session（D95）", () => {
    let minute = 0;
    const store = createStore({
      now: () => new Date(Date.UTC(2026, 9, 5, 0, minute++)),
    });
    expect(store.latestSessionProjection()).toBeNull();
    const started = sampleEvents();
    const actor = getLegalActions(foldHandEvents(started))?.playerId ?? "";
    // s1 の最初の Hand: SESSION_STARTED と Emergency Bot への切り替えを持ち、Fold で終わる。
    const opening = withSessionEvents(
      started,
      { type: "SESSION_STARTED", sessionId: "s1" },
      { type: "EMERGENCY_BOT_ENGAGED", playerId: actor, cause: "timeout" },
    );
    store.append("h1", opening, { sessionId: "s1", personas: { b: "lag" } });
    // Persona は Hand の最初の追記の値を使い、以降の追記では見ない。
    const finishing = finishingEvents(opening);
    store.append("h1", finishing, {
      sessionId: "s1",
      personas: { b: "nit" },
    });
    const finished = finishing.at(-1);
    if (finished?.type !== "HAND_FINISHED") throw new Error("終わっていない");
    expect(store.latestSessionProjection()).toEqual({
      sessionId: "s1",
      lastHandId: "h1",
      state: "ready_for_next_hand",
      endReason: null,
      stacks: finished.stacks,
      personas: { b: "lag" },
      emergencyBots: [{ playerId: actor, cause: "timeout" }],
      updatedAt: "2026-10-05T00:01:00.000Z",
    });

    // s1 の 2 Hand 目: 打ち切りで Session が終わる。Persona・Emergency Bot は前の Projection から引き継ぐ。
    store.append("h2", started, { sessionId: "s1", personas: {} });
    store.append("h2", abortingEvents(started));
    expect(store.latestSessionProjection()).toEqual({
      sessionId: "s1",
      lastHandId: "h2",
      state: "ended",
      endReason: "ai_outage",
      stacks: [
        { playerId: "a", amount: 200 },
        { playerId: "b", amount: 200 },
      ],
      personas: { b: "lag" },
      emergencyBots: [{ playerId: actor, cause: "timeout" }],
      updatedAt: "2026-10-05T00:03:00.000Z",
    });

    // 終わった Session には Hand を足せない（Hand の終わりの追記を、何も書かずに拒否する）。
    store.append("h3", started, { sessionId: "s1" });
    expect(() => store.append("h3", finishingEvents(started))).toThrow(
      EventSeqConflictError,
    );
    expect(store.read("h3").length).toBe(started.length);
    expect(store.latestSessionProjection()?.lastHandId).toBe("h2");

    // 別の Session の Hand が終われば、そちらが最後の Session になる。
    store.append(
      "h4",
      withSessionEvents(started, { type: "SESSION_STARTED", sessionId: "s2" }),
      { sessionId: "s2" },
    );
    store.append(
      "h4",
      finishingEvents(
        withSessionEvents(started, {
          type: "SESSION_STARTED",
          sessionId: "s2",
        }),
      ),
    );
    expect(store.latestSessionProjection()).toMatchObject({
      sessionId: "s2",
      lastHandId: "h4",
      state: "ready_for_next_hand",
      personas: {},
      emergencyBots: [],
    });
  });
});
