// Learning の API（#116）の統合テスト。保存済みの Hand と Pass A の reviews から Session Review と Player Profile を返すこと、
// Review を作らない（D115）こと、Session の Hand だけを数えること、Hypothesis の Snapshot を作り直すこと、
// 応答に Persona・他 Player の Stats・Pass B を入れないことを確かめる。
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { InMemoryEventStore } from "../event-store.js";
import { InMemoryHypothesisSnapshotStore } from "../learning/hypothesis-snapshot.js";
import type { ProfileResponse } from "../learning/learning-service.js";
import type { SessionReview } from "../learning/session-review.js";
import { InMemoryRevealReviewStore } from "../review/reveal-store.js";
import { InMemoryReviewStore } from "../review/review-store.js";
import { forbiddenKeys } from "../testing/leaks.js";
import {
  LEARNING_HANDS,
  loadLearningFixtures,
  type PlayedHand,
} from "../testing/learning-fixtures.js";

const fixtures = await loadLearningFixtures();

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** Session s1 に btn・sb、Session s2 に multi を保存し、Pass A の Review を 3 つ入れた App。 */
function setup() {
  const store = new InMemoryEventStore();
  const btn = fixtures.play(LEARNING_HANDS.btn);
  const sb = fixtures.play(LEARNING_HANDS.sb);
  const multi = fixtures.play(LEARNING_HANDS.multi);
  const save = (hand: PlayedHand, sessionId: string) =>
    store.append(hand.handId, hand.events, { sessionId });
  save(btn, "s1");
  save(sb, "s1");
  save(multi, "s2");

  const reviews = new InMemoryReviewStore();
  reviews.append(fixtures.review(btn, 0, "strong"));
  reviews.append(fixtures.review(sb, 2, "major_leak"));
  reviews.append(fixtures.review(multi, 0, "improvement_suggested"));
  const revealStore = new InMemoryRevealReviewStore();
  const hypothesisSnapshot = new InMemoryHypothesisSnapshotStore();
  const app = buildApp({
    logger: false,
    store,
    review: { store: reviews, revealStore },
    hypothesisSnapshot,
  });
  apps.push(app);
  return { app, btn, sb, multi, reviews };
}

describe("GET /api/learning/session-review/:handId", () => {
  it("その Hand の Session の Hand だけで Session Review を返し、Review を作らない（D115）", async () => {
    const { app, btn, sb, reviews } = setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/learning/session-review/${sb.handId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionReview>();
    // s1 の 2 Hand（判断 4 + 5 = 9）。s2 の Hand は入れない。
    expect(body.hands).toBe(2);
    expect(body.decisionQuality).toMatchObject({ total: 9, reviewed: 2 });
    expect(body.leaks.map((l) => l.handId)).toEqual([sb.handId]);
    expect(body.strengths.map((l) => l.handId)).toEqual([btn.handId]);
    expect(body.recommendedDrill.available).toBe(true);
    // 読み出しで Review の Version は増えない。
    expect(reviews.list(btn.handId, 0, "decision")).toHaveLength(1);
    expect(reviews.list(btn.handId, 1, "decision")).toHaveLength(0);
    expect(forbiddenKeys(body)).toEqual([]);
  });

  it("知らない Hand は 404", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/learning/session-review/unknown",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { kind: "hand_not_found", message: "Hand が無い: unknown" },
    });
  });
});

describe("GET /api/learning/profile", () => {
  it("全期間の Hand から Recent / Long-term・Hypothesis の Snapshot・Hero の Stats を返す", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/learning/profile",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProfileResponse>();
    expect(body.profile.decisions).toEqual({ total: 13, reviewed: 3 });
    expect(body.profile.recent.reviewed).toBe(3);
    expect(body.profile.longTerm.reviewed).toBe(3);
    // Hypothesis は Snapshot の行（作り直した時刻つき）。
    expect(body.profile.hypotheses.length).toBeGreaterThan(0);
    for (const h of body.profile.hypotheses) {
      expect(typeof h.computedAt).toBe("string");
    }
    expect(body.text).toContain("Review 済みの判断 3 件");
    // Stats は Hero の行だけ。
    expect(body.heroStats.hands).toBe(3);
    expect(JSON.stringify(body)).not.toContain('"cpu');
    expect(forbiddenKeys(body)).toEqual([]);
  });

  it("Review の無い判断は数えるだけで、Score は null（M 件中 0 件）", async () => {
    const store = new InMemoryEventStore();
    const hand = fixtures.play(LEARNING_HANDS.btn);
    store.append(hand.handId, hand.events, { sessionId: "s1" });
    const app = buildApp({ logger: false, store });
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/learning/profile",
    });
    const body = res.json<ProfileResponse>();
    expect(body.profile.decisions).toEqual({ total: 4, reviewed: 0 });
    expect(body.profile.longTerm.overall.score).toBeNull();
    expect(body.profile.hypotheses).toEqual([]);
  });
});
