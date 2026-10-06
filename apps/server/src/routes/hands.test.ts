// API の統合テスト（Fastify の inject と、SSE は実際に listen して fetch で読む）。
// 1 Hand が API 経由で最後まで終わること、レスポンスと SSE に他者の Hole Cards・Deck が含まれないことを確かめる。
import type { HandEvent, HeroView, PlayerAction } from "@proj-poker/engine";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import type { OpponentFactory } from "../opponents/opponent-agent.js";
import { RuleBot } from "../opponents/rule-bot.js";
import { forbiddenKeys, leakedCards, personaTerms } from "../testing/leaks.js";

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

describe("Hand API（Hero の物理的な操作。#64・D90）", () => {
  it("POST /api/hands/:handId/physical-actions で Chip を出して Hand が最後まで終わり、裁定が view.log に入り、どの応答にも漏れが無い", async () => {
    const { app, events } = makeApp(7);
    const created = await startRequest(app, null);
    const body = created.json<{ handId: string; view: HeroView }>();
    let view = body.view;
    const payloads: { payload: unknown; view: HeroView }[] = [];
    for (let guard = 0; view.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
      // Call 額を 1 の Chip で出す（宣言なし → Call）か、Call が無ければ Check を宣言する。
      const call = view.legalActions?.actions.find((a) => a.type === "call");
      const actions =
        call?.type === "call" && call.amount <= 100
          ? [
              {
                type: "chip_push",
                chips: Array.from({ length: call.amount }, () => 1),
              },
            ]
          : call?.type === "call"
            ? [{ type: "declare", declaration: { kind: "call" } }]
            : [{ type: "declare", declaration: { kind: "check" } }];
      const res = await app.inject({
        method: "POST",
        url: `/api/hands/${body.handId}/physical-actions`,
        payload: { lastSeq: lastSeq(view), actions },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json<{ view: HeroView; session: { state: string } }>();
      expectSessionMatches(json.view, json.session);
      expect(json.view.log.some((e) => e.type === "DEALER_RULING")).toBe(true);
      payloads.push({ payload: json, view: json.view });
      view = json.view;
    }
    const log = events(body.handId);
    expect(log.some((e) => e.type === "PHYSICAL_CHIP_ACTION")).toBe(true);
    for (const { payload, view: v } of payloads) {
      expectNoLeak(payload, v, log);
      expect(personaTerms(payload)).toEqual([]);
    }
  });

  it("入力の形が不正なら 400（schema）、額面に無い Chip なら 422（Engine）、古い画面なら 409、未知の Hand なら 404", async () => {
    const { app, events } = makeApp();
    const created = await startRequest(app, null);
    const { handId, view } = created.json<{ handId: string; view: HeroView }>();
    const post = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/hands/${handId}/physical-actions`,
        payload: payload as object,
      });
    const seq = lastSeq(view);
    for (const bad of [
      { lastSeq: seq, actions: [] },
      { lastSeq: seq, actions: [{ type: "chip_push", chips: [] }] },
      { lastSeq: seq, actions: [{ type: "chip_push", chips: ["5"] }] },
      { lastSeq: seq, actions: [{ type: "chip_push", chips: [0] }] },
      { lastSeq: seq, actions: [{ type: "chip_push" }] },
      { lastSeq: seq, actions: [{ type: "shove", chips: [5] }] },
      {
        lastSeq: seq,
        actions: [
          { type: "declare", declaration: { kind: "fold", amount: 5 } },
        ],
      },
      {
        lastSeq: seq,
        actions: [
          { type: "declare", declaration: { kind: "raise", amount: "9" } },
        ],
      },
      {
        lastSeq: seq,
        actions: [{ type: "declare", declaration: { kind: "fold" } }],
        extra: true,
      },
      { lastSeq: seq, action: { type: "fold" } },
      {
        lastSeq: seq,
        actions: Array.from({ length: 21 }, () => ({
          type: "declare",
          declaration: { kind: "fold" },
        })),
      },
    ]) {
      expect((await post(bad)).statusCode).toBe(400);
    }
    const before = events(handId).length;
    const invalid = await post({
      lastSeq: seq,
      actions: [{ type: "chip_push", chips: [7] }],
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ error: { kind: "invalid_input" } });
    expect(events(handId)).toHaveLength(before);

    const stale = await post({
      lastSeq: seq - 1,
      actions: [{ type: "declare", declaration: { kind: "fold" } }],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { kind: "stale_view" } });

    const missing = await app.inject({
      method: "POST",
      url: "/api/hands/unknown/physical-actions",
      payload: {
        lastSeq: 0,
        actions: [{ type: "declare", declaration: { kind: "fold" } }],
      },
    });
    expect(missing.statusCode).toBe(404);
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
    // 接続時は障害の状態（無ければ current: null）を先に 1 回送る。
    expect(parseSseEvents(res.body).map((e) => e.name)).toEqual([
      "outage",
      "session",
      "view",
    ]);
    expect(parseSseEvents(res.body)[0]?.data).toEqual({
      revision: 0,
      current: null,
    });
    expect(parseSseEvents(res.body)[1]?.data).toEqual({
      state: "ready_for_next_hand",
    });
  });
});

describe("Hand API（CPU の障害。#52・D86）", () => {
  /** 内部のエラー本文（資格情報やパスを含みうる）。Hero への応答・SSE に入ってはいけない。 */
  const SECRET = "/home/u/.claude/.credentials.json sk-ant-secret";

  /** 最初に判断を求められた CPU だけが、down の間は例外を投げる。ほかは RuleBot と同じ判断。 */
  function brokenApp() {
    const broken = { playerId: null as string | null, down: true };
    const createOpponent: OpponentFactory = (seed, _playerId, persona) => {
      const bot = new RuleBot(seed, persona);
      return {
        decide: (input) => {
          broken.playerId ??= input.knowledge.viewerId;
          if (broken.down && input.knowledge.viewerId === broken.playerId) {
            return Promise.reject(new Error(SECRET));
          }
          const action = bot.choose(input);
          return Promise.resolve(
            "amount" in action
              ? { action: action.type, amount: action.amount }
              : { action: action.type },
          );
        },
      };
    };
    const store = new InMemoryEventStore();
    let handNo = 0;
    const app = buildApp({
      logger: false,
      botDelayMs: 0,
      store,
      createOpponent,
      nextSeed: () => 42,
      nextHandId: () => `hand-${++handNo}`,
    });
    apps.push(app);
    return { app, broken };
  }

  /** 応答・Push に、エラー本文・Persona・system の記録が入っていない。 */
  function expectNoInternals(payload: unknown) {
    const json = JSON.stringify(payload);
    expect(json).not.toContain("sk-ant");
    expect(json).not.toContain(".credentials");
    expect(personaTerms(payload)).toEqual([]);
    expect(forbiddenKeys(payload)).toEqual([]);
  }

  function choose(
    app: ReturnType<typeof buildApp>,
    handId: string,
    revision: number,
    choice: string,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/hands/${handId}/outage`,
      payload: { revision, choice },
    });
  }

  it("障害の状態（どの CPU の手番か・種類）を開始の応答で返し、エラー本文・Persona は返さない", async () => {
    const { app, broken } = brokenApp();
    const created = await startRequest(app, null);
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      view: HeroView;
      outage: unknown;
      session: unknown;
    }>();
    expect(body.outage).toEqual({
      revision: 1,
      current: { playerId: broken.playerId, kind: "error" },
    });
    expect(body.session).toEqual({ state: "in_hand" });
    expect(body.view.actorId).toBe(broken.playerId);
    expectNoInternals(created.json());

    // 開始の再送でも、止まった Hand と障害の状態をそのまま返す（Pause: 選ぶまで止めたまま）。
    const again = await startRequest(app, null);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ outage: unknown }>().outage).toEqual(body.outage);
  });

  it("Retry・Emergency Bot・Session 終了を受け付け、古い revision は 409 stale_outage", async () => {
    const { app, broken } = brokenApp();
    const created = await startRequest(app, null);
    const { handId } = created.json<{ handId: string }>();

    const stale = await choose(app, handId, 0, "retry");
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { kind: "stale_outage" } });

    // Retry してもまた障害なら、同じ手番でまた止まる。
    const retried = await choose(app, handId, 1, "retry");
    expect(retried.statusCode).toBe(200);
    expect(retried.json<{ outage: unknown }>().outage).toEqual({
      revision: 3,
      current: { playerId: broken.playerId, kind: "error" },
    });
    expectNoInternals(retried.json());

    // Emergency Bot: その CPU は RuleBot で続け、Hero の手番まで進む。
    const emergency = await choose(app, handId, 3, "emergency_bot");
    expect(emergency.statusCode).toBe(200);
    const after = emergency.json<{
      view: HeroView;
      outage: unknown;
      session: unknown;
    }>();
    expect(after.outage).toEqual({ revision: 4, current: null });
    expect(
      after.view.status === "complete" || after.view.actorId === HERO,
    ).toBe(true);
    expectNoInternals(emergency.json());

    // 二重送信は拒否する。
    const twice = await choose(app, handId, 3, "emergency_bot");
    expect(twice.statusCode).toBe(409);
  });

  it("Session 終了を選ぶと Session が ai_outage で終わり、次の開始は新しい Session になる", async () => {
    const { app } = brokenApp();
    const created = await startRequest(app, null);
    const { handId } = created.json<{ handId: string }>();
    const ended = await choose(app, handId, 1, "end_session");
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({
      session: { state: "ended", reason: "ai_outage" },
      outage: { revision: 2, current: null },
      view: { status: "in_progress" },
    });

    const next = await startRequest(app, null);
    expect(next.statusCode).toBe(201);
    const nextBody = next.json<{
      handId: string;
      session: unknown;
      outage: unknown;
    }>();
    // 新しい Hand（均等 Stack の新しい Session。Stack の確認は Orchestrator のテスト）。障害の状態も Hand ごとに初めから。
    expect(nextBody.handId).not.toBe(handId);
    expect(nextBody.session).toEqual({ state: "in_hand" });
    expect(nextBody.outage).toMatchObject({ revision: 1 });
  });

  it("選択の形の不正は 400、無い Hand は 404", async () => {
    const { app } = brokenApp();
    const created = await startRequest(app, null);
    const { handId } = created.json<{ handId: string }>();
    for (const bad of [
      { revision: 1 },
      { choice: "retry" },
      { revision: 1, choice: "pause" },
      { revision: -1, choice: "retry" },
      { revision: "1", choice: "retry" },
      { revision: 1, choice: "retry", extra: true },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/hands/${handId}/outage`,
        payload: bad,
      });
      expect(res.statusCode).toBe(400);
    }
    const missing = await choose(app, "unknown", 1, "retry");
    expect(missing.statusCode).toBe(404);
  });

  it("SSE: 接続時と障害が起きる・解けるたびに outage を送り、Session 終了では session を続けて送る", async () => {
    const { app, broken } = brokenApp();
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
    const { handId } = (await created.json()) as { handId: string };

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/hands/${handId}/stream`, {
      signal: controller.signal,
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
      stream.body?.getReader();
    if (reader === undefined) throw new Error("SSE の本文が無い");
    const decoder = new TextDecoder();
    let text = "";
    /** 条件を満たすまで SSE を読み進める。 */
    const readUntil = async (done: (t: string) => boolean) => {
      while (!done(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readUntil((t) => t.includes("event: view"));

    // Retry でまた障害 → 解けた（revision 2）と、また起きた（revision 3）が届く。
    await fetch(`${base}/api/hands/${handId}/outage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, choice: "retry" }),
    });
    await readUntil((t) => t.includes('"revision":3'));
    // Session 終了 → outage の直後に session（ai_outage）が届く。
    await fetch(`${base}/api/hands/${handId}/outage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 3, choice: "end_session" }),
    });
    await readUntil((t) => t.includes("ai_outage"));
    controller.abort();

    const events = parseSseEvents(text);
    const outages = events
      .filter((e) => e.name === "outage")
      .map((e) => e.data);
    expect(outages).toEqual([
      { revision: 1, current: { playerId: broken.playerId, kind: "error" } },
      { revision: 2, current: null },
      { revision: 3, current: { playerId: broken.playerId, kind: "error" } },
      { revision: 4, current: null },
    ]);
    expect(events.slice(-2)).toEqual([
      { name: "outage", data: { revision: 4, current: null } },
      { name: "session", data: { state: "ended", reason: "ai_outage" } },
    ]);
    for (const e of events) expectNoInternals(e.data);
  });
});
