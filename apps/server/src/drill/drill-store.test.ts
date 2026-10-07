// Drill の記録（v7 の drills）と、Drill の Hand を除く Event Store の読み出し（#117・D116）。
// - SqliteDrillStore は追記した行を同じ形で読み戻す（provenance・変形・seed・Drill の Hand）
// - Event Store の Replay の一覧（listHands）と Resume（latestSessionProjection）は、除く Hand（Drill の Hand）を数えない
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { InMemoryEventStore, type EventStore } from "../event-store.js";
import { SqliteReviewStore } from "../review/review-store.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import {
  LEARNING_HANDS,
  loadLearningFixtures,
} from "../testing/learning-fixtures.js";
import { InMemoryDrillStore, SqliteDrillStore } from "./drill-store.js";

const fixtures = await loadLearningFixtures();

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.isOpen) db.close();
});

describe("SqliteDrillStore", () => {
  it("追記した Drill を足した順に読み戻し、Drill の Hand の id で引ける", () => {
    const events = new SqliteEventStore(db);
    const source = fixtures.play(LEARNING_HANDS.btn);
    events.append(source.handId, source.events, { sessionId: "s1" });
    const review = new SqliteReviewStore(db).append(
      fixtures.review(source, 1, "major_leak"),
    );
    const store = new SqliteDrillStore(db, {
      now: () => new Date("2026-10-07T00:00:00.000Z"),
      newDrillId: () => "drill-1",
    });
    const added = store.add({
      sourceHandId: source.handId,
      sourceDecisionIndex: 1,
      sourceReviewId: review.reviewId,
      variant: { kind: "bet_size", potFraction: 0.75 },
      policyVersion: "phase6_drill_v1",
      seed: 2 ** 32 - 1,
      drillHandId: "drill-hand-1",
    });
    expect(store.list()).toEqual([added]);
    expect(store.byDrillHandId("drill-hand-1")).toEqual(added);
    expect(store.byDrillHandId(source.handId)).toBeNull();
    expect([...store.drillHandIds()]).toEqual(["drill-hand-1"]);
    // 元の判断の Review でない行は Trigger が拒否する。
    expect(() =>
      store.add({
        sourceHandId: source.handId,
        sourceDecisionIndex: 0,
        sourceReviewId: review.reviewId,
        variant: { kind: "effective_stack", factor: 2 },
        policyVersion: "phase6_drill_v1",
        seed: 1,
        drillHandId: "drill-hand-2",
      }),
    ).toThrow();
  });

  it("メモリ内の実装も同じ Drill の Hand を 2 回登録しない", () => {
    const store = new InMemoryDrillStore();
    const record = {
      sourceHandId: "h",
      sourceDecisionIndex: 0,
      sourceReviewId: "r",
      variant: { kind: "effective_stack", factor: 2 } as const,
      policyVersion: "phase6_drill_v1",
      seed: 1,
      drillHandId: "d",
    };
    store.add(record);
    expect(() => store.add(record)).toThrow();
  });
});

describe.each<[string, () => EventStore]>([
  ["SqliteEventStore", () => new SqliteEventStore(db)],
  ["InMemoryEventStore", () => new InMemoryEventStore()],
])("%s: Drill の Hand を除く読み出し（D116）", (_name, create) => {
  it("Replay の一覧と Resume の Session は、除く Hand とその Session を数えない", () => {
    const store = create();
    const normal = fixtures.play(LEARNING_HANDS.btn, 1);
    const drill = fixtures.play(LEARNING_HANDS.sb, 2);
    store.append(normal.handId, normal.events, { sessionId: "normal" });
    store.append(drill.handId, drill.events, { sessionId: "drill-session" });
    const exclude = new Set([drill.handId]);

    expect(store.listHands(10).map((h) => h.handId)).toContain(drill.handId);
    expect(store.listHands(10, exclude).map((h) => h.handId)).toEqual([
      normal.handId,
    ]);
    // 除いた後で limit 件（除く Hand が limit を食わない）。
    expect(store.listHands(1, exclude).map((h) => h.handId)).toEqual([
      normal.handId,
    ]);
    expect(store.latestSessionProjection()?.sessionId).toBe("drill-session");
    expect(store.latestSessionProjection(exclude)?.sessionId).toBe("normal");
  });
});
