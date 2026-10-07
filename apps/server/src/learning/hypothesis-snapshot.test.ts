// Weakness Hypothesis の Snapshot（マイグレーション v6・D113）のテスト。reviews から作り直せる派生データで、
// 消して作り直しても同じ行になること・作り直しが全行を入れ替えることを確かめる。
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { InMemoryReviewStore } from "../review/review-store.js";
import type { Assessment } from "../review/types.js";
import {
  LEARNING_HANDS,
  LEARNING_HERO,
  loadLearningFixtures,
  type PlayedHand,
} from "../testing/learning-fixtures.js";
import { buildHypotheses } from "./hypothesis.js";
import {
  readHypothesisSnapshot,
  rebuildHypothesisSnapshot,
} from "./hypothesis-snapshot.js";

const fx = await loadLearningFixtures();
const fixedNow = () => new Date("2026-10-07T00:00:00.000Z");

/** BTN_VS_UTG の d1（postflop_facing_bet）と SB_VS_BTN の d2（postflop_unbet・bet_raise）に Review を付けた入力。 */
function source(facingBet: readonly Assessment[], sbBet: Assessment) {
  const hands: PlayedHand[] = facingBet.map((_, i) =>
    fx.play(LEARNING_HANDS.btn, i),
  );
  const sb = fx.play(LEARNING_HANDS.sb, 0);
  const reviews = new InMemoryReviewStore();
  facingBet.forEach((a, i) => {
    reviews.append(fx.review(hands[i] as PlayedHand, 1, a));
  });
  reviews.append(fx.review(sb, 2, sbBet));
  return {
    hands: [...hands.map((h) => h.events), sb.events],
    reviews,
    heroId: LEARNING_HERO,
  };
}

describe("Hypothesis の Snapshot（v6）", () => {
  it("作り直すと buildHypotheses と同じ Hypothesis を計算時刻つきで保存し、そのまま読める", () => {
    const db = openDatabase(":memory:");
    try {
      const input = source(
        ["major_leak", "major_leak", "reasonable"],
        "major_leak",
      );
      const written = rebuildHypothesisSnapshot(db, input, { now: fixedNow });
      const expected = buildHypotheses(input).map((h) => ({
        ...h,
        computedAt: "2026-10-07T00:00:00.000Z",
      }));
      expect(written).toEqual(expected);
      expect(readHypothesisSnapshot(db)).toEqual(expected);
      expect(expected.map((h) => h.type)).toEqual([
        "postflop_facing_bet",
        "postflop_unbet",
        "bet_raise",
      ]);
    } finally {
      db.close();
    }
  });

  it("Snapshot を消して作り直しても同じ行になる（派生データ。D113）", () => {
    const db = openDatabase(":memory:");
    try {
      const input = source(
        ["major_leak", "improvement_suggested", "strong", "major_leak"],
        "reasonable",
      );
      rebuildHypothesisSnapshot(db, input, { now: fixedNow });
      const before = readHypothesisSnapshot(db);
      db.exec("DELETE FROM hypothesis_snapshots");
      expect(readHypothesisSnapshot(db)).toEqual([]);
      rebuildHypothesisSnapshot(db, input, { now: fixedNow });
      expect(readHypothesisSnapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("作り直しは全行を入れ替える（Evidence が変われば消えた Hypothesis は残らない）", () => {
    const db = openDatabase(":memory:");
    try {
      rebuildHypothesisSnapshot(
        db,
        source(["major_leak", "major_leak", "major_leak"], "major_leak"),
        { now: fixedNow },
      );
      expect(readHypothesisSnapshot(db)).toHaveLength(3);
      // SB の Bet が良い判断になり、postflop_unbet・bet_raise の Supporting が無くなった。
      const later = () => new Date("2026-10-08T00:00:00.000Z");
      rebuildHypothesisSnapshot(
        db,
        source(["major_leak", "major_leak", "major_leak"], "strong"),
        { now: later },
      );
      expect(
        readHypothesisSnapshot(db).map((h) => [h.type, h.status, h.computedAt]),
      ).toEqual([
        ["postflop_facing_bet", "supported", "2026-10-08T00:00:00.000Z"],
      ]);
    } finally {
      db.close();
    }
  });

  it("status は D104 の状態だけ、Evidence の ID は JSON 配列だけを受け付ける", () => {
    const db = openDatabase(":memory:");
    try {
      const insert = db.prepare(
        "INSERT INTO hypothesis_snapshots VALUES (?, 'v', 't', ?, ?, '[]', '2026-10-07T00:00:00.000Z')",
      );
      expect(() => insert.run("h1", "unknown", "[]")).toThrow(/CHECK/);
      expect(() => insert.run("h2", "strong", '{"a":1}')).toThrow(/CHECK/);
      expect(() => insert.run("h3", "strong", "not json")).toThrow();
      insert.run("h4", "strong", '["x/d0/v1"]');
    } finally {
      db.close();
    }
  });
});
