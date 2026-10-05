// API の統合テスト（Fastify の inject と、SSE は実際に listen して fetch で読む）。
// 1 Hand が API 経由で最後まで終わること、レスポンスと SSE に他者の Hole Cards・Deck が含まれないことを確かめる。
import type { HandEvent, HeroView, PlayerAction } from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { forbiddenKeys, leakedCards } from "../testing/leaks.js";

const HERO = "hero";
const TOTAL_CHIPS =
  PHASE1_TABLE_SETUP.startingStack * PHASE1_TABLE_SETUP.players.length;

let apps: ReturnType<typeof buildApp>[] = [];

function makeApp(seed = 42) {
  const store = new InMemoryEventStore();
  let handNo = 0;
  const app = buildApp({
    logger: false,
    botDelayMs: 0,
    store,
    nextSeed: () => seed,
    nextHandId: () => `hand-${++handNo}`,
  });
  apps.push(app);
  const events = (handId: string): HandEvent[] =>
    store.read(handId).map((s) => s.event);
  return { app, events };
}

/** Hand の開始。afterHandId は結果まで見た最後の Hand（まだ無ければ null）。 */
function startRequest(
  app: ReturnType<typeof buildApp>,
  afterHandId: string | null,
) {
  return app.inject({
    method: "POST",
    url: "/api/hands",
    payload: { afterHandId },
  });
}

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

function passiveHero(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

function lastSeq(view: HeroView): number {
  return view.log.at(-1)?.seq ?? -1;
}

/** Session の状態は View と食い違わない: Hand の途中なら in_hand、終わっていれば次 Hand があるか Session 終了。 */
function expectSessionMatches(view: HeroView, session: { state: string }) {
  if (view.status === "complete") {
    expect(["ready_for_next_hand", "ended"]).toContain(session.state);
  } else {
    expect(session).toEqual({ state: "in_hand" });
  }
}

/** 受け取った Payload（View を含む）に、その時点の Hero が知り得ない札や Deck が無いことを確かめる。 */
function expectNoLeak(payload: unknown, view: HeroView, log: HandEvent[]) {
  expect(leakedCards(payload, log, HERO, lastSeq(view))).toEqual([]);
  expect(forbiddenKeys(payload)).toEqual([]);
}

describe("Hand API（REST）", () => {
  it("POST /api/hands → Hero の Action を繰り返して 1 Hand が最後まで終わり、どの応答にも漏れが無い", async () => {
    for (const seed of [1, 2, 3, 42, 777]) {
      const { app, events } = makeApp(seed);
      const created = await startRequest(app, null);
      expect(created.statusCode).toBe(201);
      const body = created.json<{
        handId: string;
        players: { playerId: string; kind: string }[];
        view: HeroView;
        session: { state: string };
      }>();
      expect(body.players.filter((p) => p.kind === "hero")).toHaveLength(1);
      expectSessionMatches(body.view, body.session);
      const payloads: { payload: unknown; view: HeroView }[] = [
        { payload: body, view: body.view },
      ];

      let view = body.view;
      for (let guard = 0; view.status !== "complete"; guard++) {
        expect(guard).toBeLessThan(100);
        expect(view.actorId).toBe(HERO);
        const res = await app.inject({
          method: "POST",
          url: `/api/hands/${body.handId}/actions`,
          payload: { lastSeq: lastSeq(view), action: passiveHero(view) },
        });
        expect(res.statusCode).toBe(200);
        const json = res.json<{ view: HeroView; session: { state: string } }>();
        expectSessionMatches(json.view, json.session);
        payloads.push({ payload: json, view: json.view });
        view = json.view;
      }

      const log = events(body.handId);
      const finished = log.find((e) => e.type === "HAND_FINISHED");
      expect(finished?.type).toBe("HAND_FINISHED");
      if (finished?.type === "HAND_FINISHED") {
        expect(finished.stacks.reduce((s, x) => s + x.amount, 0)).toBe(
          TOTAL_CHIPS,
        );
      }
      for (const { payload, view: v } of payloads) {
        expectNoLeak(payload, v, log);
      }
    }
  });

  it("進行中の Hand があるときの POST /api/hands は、新しく作らずその Hand を 200 で返す（開始の再送）", async () => {
    const { app } = makeApp();
    const created = await startRequest(app, null);
    expect(created.statusCode).toBe(201);
    const first = created.json<{ handId: string; view: HeroView }>();
    expect(first.view.status).toBe("in_progress");

    const again = await startRequest(app, null);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      handId: first.handId,
      view: first.view,
      session: { state: "in_hand" },
    });
  });

  it("入力の形が不正なら 400（schema）、非合法な額なら 422（Engine）、未知の Hand なら 404", async () => {
    const { app } = makeApp();
    const created = await startRequest(app, null);
    const { handId, view } = created.json<{ handId: string; view: HeroView }>();
    const post = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/hands/${handId}/actions`,
        payload: payload as object,
      });

    const seq = lastSeq(view);
    for (const bad of [
      { lastSeq: seq, action: { type: "raise" } },
      { lastSeq: seq, action: { type: "raise", amount: "10" } },
      { lastSeq: seq, action: { type: "fold", amount: 10 } },
      { lastSeq: seq, action: { type: "shove" } },
      { lastSeq: seq, action: { type: "fold" }, extra: true },
      { lastSeq: String(seq), action: { type: "fold" } },
      { action: { type: "fold" } },
    ]) {
      expect((await post(bad)).statusCode).toBe(400);
    }

    const illegal = await post({
      lastSeq: seq,
      action: { type: "raise", amount: 1 },
    });
    expect(illegal.statusCode).toBe(422);
    expect(illegal.json()).toMatchObject({ error: { kind: "illegal_action" } });

    const stale = await post({ lastSeq: seq - 1, action: { type: "fold" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { kind: "stale_view" } });

    // 開始の入力も形を検証する（afterHandId は必須・文字列か null）。
    for (const bad of [
      undefined,
      {},
      { afterHandId: 1 },
      { afterHandId: "" },
      { afterHandId: null, extra: true },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/hands",
        ...(bad === undefined ? {} : { payload: bad }),
      });
      expect(res.statusCode).toBe(400);
    }

    const missing = await app.inject({
      method: "POST",
      url: "/api/hands/unknown/actions",
      payload: { lastSeq: 0, action: { type: "fold" } },
    });
    expect(missing.statusCode).toBe(404);
    const missingStream = await app.inject({
      method: "GET",
      url: "/api/hands/unknown/stream",
    });
    expect(missingStream.statusCode).toBe(404);
  });
});

/** SSE の本文を、イベント名と data の組の列にする。 */
function parseSseEvents(text: string): { name: string; data: unknown }[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const field = (key: string) =>
        lines
          .find((line) => line.startsWith(`${key}: `))
          ?.slice(key.length + 2);
      return {
        name: field("event") ?? "",
        data: JSON.parse(field("data") ?? "null") as unknown,
      };
    });
}

/** SSE の本文から view イベントの data を取り出す。 */
function parseSse(text: string): HeroView[] {
  return parseSseEvents(text)
    .filter((e) => e.name === "view")
    .map((e) => e.data as HeroView);
}

describe("Hand API（SSE）", () => {
  it("SSE は Hero の View だけを Push し、Hand の終了でサーバーが閉じる。どの View にも漏れが無い", async () => {
    const { app, events } = makeApp(9);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("listen したアドレスが取れない");
    }
    const base = `http://127.0.0.1:${address.port}`;

    const created = await fetch(`${base}/api/hands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterHandId: null }),
    });
    const { handId, view: initial } = (await created.json()) as {
      handId: string;
      view: HeroView;
    };

    const stream = await fetch(`${base}/api/hands/${handId}/stream`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    // 本文は Hand が終わってサーバーが閉じるまで読み切る（Hero の Action と並行して進む）。
    const bodyPromise = stream.text();

    let view = initial;
    while (view.status !== "complete") {
      const res = await fetch(`${base}/api/hands/${handId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lastSeq: lastSeq(view),
          action: passiveHero(view),
        }),
      });
      expect(res.status).toBe(200);
      view = ((await res.json()) as { view: HeroView }).view;
    }

    const body = await bodyPromise;
    const pushed = parseSse(body);
    const log = events(handId);
    expect(pushed.length).toBeGreaterThan(1);
    expect(pushed.at(-1)?.status).toBe("complete");
    // Session の状態は complete の View の直前に 1 回だけ届き、Hero に見えない札・Deck を含まない。
    const names = parseSseEvents(body).map((e) => e.name);
    expect(names.filter((n) => n === "session")).toHaveLength(1);
    expect(names.slice(-2)).toEqual(["session", "view"]);
    const session = parseSseEvents(body).find((e) => e.name === "session");
    expectSessionMatches(
      pushed.at(-1) as HeroView,
      session?.data as { state: string },
    );
    expectNoLeak(session?.data, pushed.at(-1) as HeroView, log);
    // Push された View は Log の進行どおりに並ぶ（同じ時点を重複して送らない）。
    const seqs = pushed.map(lastSeq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    for (const v of pushed) {
      expect(v.viewerId).toBe(HERO);
      // Bot 用 Projection の項目（actionHistory）を Hero へ送っていない。
      expect(v).not.toHaveProperty("actionHistory");
      expectNoLeak(v, v, log);
    }
  });

  it("終わった Hand の SSE は、最後の View を 1 回送って閉じる", async () => {
    const { app } = makeApp();
    const created = await startRequest(app, null);
    const { handId, view } = created.json<{ handId: string; view: HeroView }>();
    await app.inject({
      method: "POST",
      url: `/api/hands/${handId}/actions`,
      payload: { lastSeq: lastSeq(view), action: { type: "fold" } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/hands/${handId}/stream`,
    });
    expect(res.statusCode).toBe(200);
    const pushed = parseSse(res.body);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.status).toBe("complete");
    // complete の View の直前に Session の状態を送る（6 人卓で Hero が Fold しただけなので Session は続く）。
    expect(parseSseEvents(res.body).map((e) => e.name)).toEqual([
      "session",
      "view",
    ]);
    expect(parseSseEvents(res.body)[0]?.data).toEqual({
      state: "ready_for_next_hand",
    });
  });
});
