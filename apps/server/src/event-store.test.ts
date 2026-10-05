import {
  PHASE1_CASH_PRESET,
  startHand,
  type HandEvent,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { EventSeqConflictError, InMemoryEventStore } from "./event-store.js";

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

describe("InMemoryEventStore", () => {
  it("追記した Event を seq 順に返し、event_id と記録時刻を付ける", () => {
    let id = 0;
    const store = new InMemoryEventStore({
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
    const store = new InMemoryEventStore();
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

  it("追記に渡した Event や read で得た Event を書き換えても、保存済みの Log は変わらない", () => {
    const store = new InMemoryEventStore();
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
    const store = new InMemoryEventStore();
    store.append("h1", sampleEvents());
    const copy = store.read("h1") as unknown[];
    const length = copy.length;
    copy.pop();
    expect(store.read("h1").length).toBe(length);
  });
});
