// Targeted Drill の API（#117・docs/07 §7・D105・D110・D116）の統合テスト。
// - Pass A の Review がある元の判断から、Engine の Validation を通った Drill の Hand を始め、Hero の手番（練習する判断）を返す
// - 同じ元の判断・同じ seed からは同じ Drill になる
// - Drill の Hand の Hero 向けの値に、元の Hand の他者の札・Deck・seed・元の CPU の Persona を入れない
// - Drill の Hand は通常の Hand の API で終局まで進み、Replay の一覧・Learning の集計・Resume から除かれる（D116）
// - Drill の結果は通常の Score と別の系列で数える（Script が再現した元の判断は数えない。D105）
import { cardToString, type HeroView } from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { DrillResults, DrillView } from "../drill/drill-service.js";
import { InMemoryDrillStore } from "../drill/drill-store.js";
import { InMemoryEventStore } from "../event-store.js";
import type { ProfileResponse } from "../learning/learning-service.js";
import type { ReplayHandSummary } from "../replay.js";
import { InMemoryReviewStore } from "../review/review-store.js";
import { collectCards, forbiddenKeys, leakedCards } from "../testing/leaks.js";
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

interface DrillStartBody {
  readonly drill: DrillView;
  readonly handId: string;
  readonly view: HeroView;
  readonly session: unknown;
}

/** btn の Hand（Session s1）を保存し、Flop の判断（d1: Bet に Call）に Pass A の Review を入れた App。 */
function setup(
  options: {
    store?: InMemoryEventStore;
    drillStore?: InMemoryDrillStore;
    reviews?: InMemoryReviewStore;
    btn?: PlayedHand;
    seed?: number;
  } = {},
) {
  const btn = options.btn ?? fixtures.play(LEARNING_HANDS.btn);
  const store = options.store ?? new InMemoryEventStore();
  if (store.read(btn.handId).length === 0) {
    store.append(btn.handId, btn.events, { sessionId: "s1" });
  }
  const reviews = options.reviews ?? new InMemoryReviewStore();
  if (reviews.list(btn.handId, 1, "decision").length === 0) {
    reviews.append(fixtures.review(btn, 1, "major_leak"));
  }
  const drillStore = options.drillStore ?? new InMemoryDrillStore();
  let n = 0;
  const app = buildApp({
    logger: false,
    store,
    botDelayMs: 0,
    review: { store: reviews },
    drillStore,
    nextSeed: () => options.seed ?? 42,
    nextHandId: () => `generated-${apps.length}-${n++}`,
  });
  apps.push(app);
  return { app, btn, store, reviews, drillStore };
}

async function startDrill(
  app: ReturnType<typeof buildApp>,
  handId: string,
  decisionIndex: number,
) {
  return app.inject({
    method: "POST",
    url: "/api/drills",
    payload: { handId, decisionIndex },
  });
}

describe("POST /api/drills", () => {
  it("元の判断から Drill の Hand を始め、練習する判断（Hero の手番）を返す。Hero の札と判断時点の Board は元のまま", async () => {
    const { app, btn, store, drillStore, reviews } = setup();
    const res = await startDrill(app, btn.handId, 1);
    expect(res.statusCode).toBe(201);
    const body = res.json<DrillStartBody>();
    expect(body.drill.source).toMatchObject({
      handId: btn.handId,
      decisionIndex: 1,
    });
    expect(body.drill.decisionIndex).toBe(1);
    expect(body.view.actorId).toBe("hero");
    expect(body.view.street).toBe("flop");
    expect(body.view.board.map(cardToString)).toEqual(["Jc", "8s", "3d"]);
    expect(
      body.view.seats
        .find((s) => s.playerId === "hero")
        ?.holeCards?.map(cardToString),
    ).toEqual(["Ah", "Jd"]);
    // provenance・変形・seed は drills に残す（応答には seed を出さない）。
    const [record] = drillStore.list();
    expect(record).toMatchObject({
      sourceHandId: btn.handId,
      sourceDecisionIndex: 1,
      seed: 42,
      drillHandId: body.handId,
    });
    expect(record?.sourceReviewId).toBe(
      reviews.list(btn.handId, 1, "decision")[0]?.reviewId,
    );
    // Hero 向けの値に、Drill の Hand で Hero が知ってよい札以外を入れない（元の Hand の相手の札・この後の Board・Deck・seed）。
    const drillEvents = store.read(body.handId).map((s) => s.event);
    const lastSeq = drillEvents.at(-1)?.seq ?? 0;
    expect(leakedCards(body, drillEvents, "hero", lastSeq)).toEqual([]);
    expect(forbiddenKeys(body.view)).toEqual([]);
    // 応答に出る札は Hero の札と判断時点の Flop だけ（元の Hand の UTG の Ks Qs・この後の Board は出ない）。
    expect([...new Set(collectCards(body).map(cardToString))].sort()).toEqual(
      ["3d", "8s", "Ah", "Jc", "Jd"].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('"seed"');
  });

  it("同じ元の判断・同じ seed からは同じ Drill になる", async () => {
    const btn = fixtures.play(LEARNING_HANDS.btn);
    const a = setup({ btn });
    const b = setup({ btn });
    const ra = (await startDrill(a.app, btn.handId, 1)).json<DrillStartBody>();
    const rb = (await startDrill(b.app, btn.handId, 1)).json<DrillStartBody>();
    expect(rb.drill.variant).toEqual(ra.drill.variant);
    expect(rb.drill.change).toEqual(ra.drill.change);
    const strip = (view: HeroView) => ({
      ...view,
      handId: null,
      log: view.log.map((e) => ({ ...e, handId: null })),
    });
    expect(strip(rb.view)).toEqual(strip(ra.view));
  });

  it("同じ元の判断の Drill の Hand が終わっていなければ、開始の再送は新しく作らずその Drill を返す", async () => {
    const { app, btn, drillStore } = setup();
    const first = await startDrill(app, btn.handId, 1);
    expect(first.statusCode).toBe(201);
    const again = await startDrill(app, btn.handId, 1);
    expect(again.statusCode).toBe(200);
    const a = first.json<DrillStartBody>();
    const b = again.json<DrillStartBody>();
    expect(b.handId).toBe(a.handId);
    expect(b.drill.drillId).toBe(a.drill.drillId);
    expect(drillStore.list()).toHaveLength(1);
    // Drill の Hand が終わった後は、新しい Drill を作る。
    const lastSeq = a.view.log.at(-1)?.seq ?? 0;
    await app.inject({
      method: "POST",
      url: `/api/hands/${a.handId}/actions`,
      payload: { lastSeq, action: { type: "fold" } },
    });
    const next = await startDrill(app, btn.handId, 1);
    expect(next.statusCode).toBe(201);
    expect(next.json<DrillStartBody>().handId).not.toBe(a.handId);
    expect(drillStore.list()).toHaveLength(2);
  });

  it("Pass A の Review が無い判断・無い Hand・無い判断・Drill の Hand からは始めない", async () => {
    const { app, btn } = setup();
    const noReview = await startDrill(app, btn.handId, 0);
    expect(noReview.statusCode).toBe(409);
    expect(noReview.json<{ error: { kind: string } }>().error.kind).toBe(
      "review_required",
    );
    expect((await startDrill(app, "unknown", 0)).statusCode).toBe(404);
    expect((await startDrill(app, btn.handId, 99)).statusCode).toBe(404);
    const drill = (await startDrill(app, btn.handId, 1)).json<DrillStartBody>();
    const again = await startDrill(app, drill.handId, 1);
    expect(again.statusCode).toBe(422);
  });

  it("Drill の Hand は通常の Hand の API で終局まで進み、Replay の一覧・Learning の集計・Resume から除かれる（D116）", async () => {
    const { app, btn, store, drillStore, reviews } = setup();
    const before = (
      await app.inject({ method: "GET", url: "/api/learning/profile" })
    ).json<ProfileResponse>();
    const drill = (await startDrill(app, btn.handId, 1)).json<DrillStartBody>();
    const lastSeq = drill.view.log.at(-1)?.seq ?? 0;
    const folded = await app.inject({
      method: "POST",
      url: `/api/hands/${drill.handId}/actions`,
      payload: { lastSeq, action: { type: "fold" } },
    });
    expect(folded.statusCode).toBe(200);
    expect(folded.json<{ view: HeroView }>().view.status).toBe("complete");

    // Replay の一覧に入れない（1 Hand の再生は Drill の Review から開けるよう返す）。
    const list = (
      await app.inject({ method: "GET", url: "/api/replay/hands" })
    ).json<{ hands: ReplayHandSummary[] }>();
    expect(list.hands.map((h) => h.handId)).toEqual([btn.handId]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/replay/hands/${drill.handId}`,
        })
      ).statusCode,
    ).toBe(200);

    // Drill の判断の Review は既存の Pass A の経路（Hand は保存済み）で扱える。
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/reviews/hands/${drill.handId}/decisions/1`,
        })
      ).statusCode,
    ).toBe(200);
    reviews.append({
      ...fixtures.review(btn, 1, "strong"),
      handId: drill.handId,
    });

    // Learning（Profile・Stats）は Drill の Hand を数えない。
    const after = (
      await app.inject({ method: "GET", url: "/api/learning/profile" })
    ).json<ProfileResponse>();
    expect(after.profile.decisions).toEqual(before.profile.decisions);
    expect(after.heroStats.hands).toBe(before.heroStats.hands);

    // Resume: Drill の専用の Session ではなく、通常の Session（s1）から続ける。
    const restarted = setup({ store, drillStore, reviews, btn });
    const next = await restarted.app.inject({
      method: "POST",
      url: "/api/hands",
      payload: { afterHandId: null },
    });
    expect(next.statusCode).toBe(201);
    const nextHand = next.json<{ handId: string }>().handId;
    expect(store.sessionHandIds(nextHand)).toEqual([btn.handId]);
  });
});

describe("GET /api/drills", () => {
  it("Drill の一覧と、通常の Score と別の系列（練習した判断から数える）を返す（D105）", async () => {
    const { app, btn, reviews } = setup();
    const drill = (await startDrill(app, btn.handId, 1)).json<DrillStartBody>();
    const lastSeq = drill.view.log.at(-1)?.seq ?? 0;
    await app.inject({
      method: "POST",
      url: `/api/hands/${drill.handId}/actions`,
      payload: { lastSeq, action: { type: "fold" } },
    });
    let results = (
      await app.inject({ method: "GET", url: "/api/drills" })
    ).json<DrillResults>();
    expect(results.drills).toHaveLength(1);
    expect(results.drills[0]).toMatchObject({
      drillHandId: drill.handId,
      finished: true,
      assessment: null,
    });
    // Drill の Hand の Hero の判断は 2 つ（Script が再現した Preflop の Call と、練習した Flop の判断）。数えるのは練習した判断だけ。
    expect(results.score.decisions).toMatchObject({ total: 1, reviewed: 0 });

    reviews.append({
      ...fixtures.review(btn, 1, "strong"),
      handId: drill.handId,
    });
    // Script が再現した判断の Review は Drill の系列に入れない。
    reviews.append({
      ...fixtures.review(btn, 0, "major_leak"),
      handId: drill.handId,
    });
    results = (
      await app.inject({ method: "GET", url: "/api/drills" })
    ).json<DrillResults>();
    expect(results.drills[0]?.assessment).toBe("strong");
    expect(results.score.decisions).toMatchObject({ total: 1, reviewed: 1 });
    expect(results.score.overall.score).toBe(100);
    // 通常の Profile の Score には混ざらない（元の判断の major_leak だけ）。
    const profile = (
      await app.inject({ method: "GET", url: "/api/learning/profile" })
    ).json<ProfileResponse>();
    expect(profile.profile.longTerm.overall.score).toBe(0);
  });
});
