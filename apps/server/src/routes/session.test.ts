// Home の読み取り専用の Session 状態の照会 GET /api/session/current（UX-02 #217・D136・D144）の API テスト。
// - 返すのは state と Session の種類だけ（Session ID・Hand ID・Stack・札・Persona を返さない）
// - 二重タブ（同時の照会）・照会の連打でも Hand・Event・CPU が進まず、開始（POST /api/hands）の冪等性と stale_view は変わらない
// 状況ごとの判定（再起動・Drill・内部エラー・Tournament）は session-current.test.ts で見る。
import type { HeroView } from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { InMemoryEventStore } from "../event-store.js";
import { forbiddenKeys } from "../testing/leaks.js";

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

function makeApp() {
  const store = new InMemoryEventStore();
  let handNo = 0;
  const app = buildApp({
    logger: false,
    botDelayMs: 0,
    store,
    nextSeed: () => 42,
    nextHandId: () => `hand-${++handNo}`,
  });
  apps.push(app);
  /** Event Store の中身の指紋（Hand ごとの Event の件数）。照会で追記・Hand の作成が起きたら変わる。 */
  const fingerprint = () =>
    JSON.stringify(
      store
        .listHands(10_000)
        .map((h) => [h.handId, store.read(h.handId).length]),
    );
  return { app, fingerprint };
}

function current(app: ReturnType<typeof buildApp>) {
  return app.inject({ method: "GET", url: "/api/session/current" });
}

function start(app: ReturnType<typeof buildApp>, afterHandId: string | null) {
  return app.inject({
    method: "POST",
    url: "/api/hands",
    payload: { afterHandId },
  });
}

describe("GET /api/session/current", () => {
  it("Session が無ければ { session: null } を返し、Hand を始めない", async () => {
    const { app, fingerprint } = makeApp();
    const before = fingerprint();
    const res = await current(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session: null });
    expect(fingerprint()).toBe(before);
  });

  it("Hand の途中は in_hand と Session の種類だけを返す（Session ID・Hand ID・Stack・札を返さない）", async () => {
    const { app } = makeApp();
    const started = await start(app, null);
    expect(started.statusCode).toBe(201);
    const { handId } = started.json<{ handId: string }>();
    const res = await current(app);
    expect(res.statusCode).toBe(200);
    const body = res.json<unknown>();
    expect(body).toEqual({
      session: { state: "in_hand", kind: { mode: "cash" } },
    });
    expect(JSON.stringify(body)).not.toContain(handId);
    expect(forbiddenKeys(body)).toEqual([]);
  });

  it("二重タブ（同時の照会）と連打でも Hand・Event は進まず、開始の再送は同じ Hand を返し、古い lastSeq は stale_view のまま", async () => {
    const { app, fingerprint } = makeApp();
    const started = await start(app, null);
    const { handId, view } = started.json<{ handId: string; view: HeroView }>();
    const before = fingerprint();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => current(app)),
    );
    for (const res of results) {
      expect(res.json()).toEqual({
        session: { state: "in_hand", kind: { mode: "cash" } },
      });
    }
    expect(fingerprint()).toBe(before);

    // 開始の冪等性: 照会の後も、開始の再送は新しい Hand を作らずに同じ Hand を返す。
    const again = await start(app, null);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ handId });
    expect(fingerprint()).toBe(before);

    // stale_view: 見ていた View より古い lastSeq の操作は、照会の後も今までどおり 409 で弾かれ Log は変わらない。
    const lastSeq = view.log.at(-1)?.seq ?? -1;
    const stale = await app.inject({
      method: "POST",
      url: `/api/hands/${handId}/actions`,
      payload: { lastSeq: lastSeq - 1, action: { type: "fold" } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { kind: "stale_view" } });
    expect(fingerprint()).toBe(before);
  });
});
