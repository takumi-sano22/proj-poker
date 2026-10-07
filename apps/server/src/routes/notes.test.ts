// Hero の User Read（POST /reads）と Note / Tag（/players/:playerId/notes・tags）の API の統合テスト（#115・D112）。
// User Read が Hero の手番の間だけ記録でき、Hero だけの private の Event として残ること、Note / Tag が Session の参加者ごとに
// 追記で保存されること、どちらも CPU の入力（OpponentInput）に入らないこと（不変条件 2・D105）を確かめる。
import type { HandEvent, HeroView, PlayerAction } from "@proj-poker/engine";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import type { OpponentFactory } from "../opponents/opponent-agent.js";
import { RuleBot } from "../opponents/rule-bot.js";

const HERO = "hero";
const CPU = PHASE1_TABLE_SETUP.players.find((p) => p.kind === "cpu")
  ?.playerId as string;
const READ_TEXT = "読みのテキスト-7f3a";
const NOTE_TEXT = "ノートのテキスト-91c2";
const NOTE_ID = "0b7c2a5e-6f1d-4c3b-9a8e-2d4f6b8a0c1e";

let apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** CPU に渡した入力をすべて JSON で残す RuleBot。 */
function makeApp() {
  const store = new InMemoryEventStore();
  const inputs: string[] = [];
  const createOpponent: OpponentFactory = (seed, _playerId, persona) => {
    const bot = new RuleBot(seed, persona);
    return {
      decide: (input) => {
        inputs.push(JSON.stringify(input));
        return bot.decide(input);
      },
    };
  };
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
  const events = (handId: string): HandEvent[] =>
    store.read(handId).map((s) => s.event);
  return { app, events, inputs };
}

async function start(
  app: ReturnType<typeof buildApp>,
  afterHandId: string | null,
): Promise<{ handId: string; view: HeroView }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/hands",
    payload: { afterHandId },
  });
  expect([200, 201]).toContain(res.statusCode);
  return res.json<{ handId: string; view: HeroView }>();
}

function lastSeq(view: HeroView): number {
  return view.log.at(-1)?.seq ?? -1;
}

function passive(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

async function act(
  app: ReturnType<typeof buildApp>,
  handId: string,
  view: HeroView,
  action: PlayerAction,
): Promise<HeroView> {
  const res = await app.inject({
    method: "POST",
    url: `/api/hands/${handId}/actions`,
    payload: { lastSeq: lastSeq(view), action },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ view: HeroView }>().view;
}

function read(
  app: ReturnType<typeof buildApp>,
  handId: string,
  payload: { lastSeq: number; targetPlayerId: string | null; text: string },
) {
  return app.inject({
    method: "POST",
    url: `/api/hands/${handId}/reads`,
    payload,
  });
}

describe("POST /api/hands/:handId/reads（User Read。D112）", () => {
  it("Hero の手番の間に記録した読みは、Hero だけの private の USER_READ_RECORDED として残り、CPU の入力には入らない", async () => {
    const { app, events, inputs } = makeApp();
    const { handId, view } = await start(app, null);
    expect(view.actorId).toBe(HERO);

    const res = await read(app, handId, {
      lastSeq: lastSeq(view),
      targetPlayerId: CPU,
      text: READ_TEXT,
    });
    expect(res.statusCode).toBe(200);
    const after = res.json<{ view: HeroView }>().view;
    // 卓の状態は変わらず、Hero の log の末尾に読みが入る（次の Action はこの seq を lastSeq にする）。
    expect(after.log.at(-1)).toMatchObject({
      type: "USER_READ_RECORDED",
      playerId: HERO,
      targetPlayerId: CPU,
      text: READ_TEXT,
      visibility: { type: "private", playerId: HERO },
    });
    expect(after.actorId).toBe(HERO);
    expect(after.pot).toBe(view.pot);

    // 応答だけが失われた記録の再送（古い lastSeq）は stale_view で弾き、同じ読みを 2 回追記しない。
    const resent = await read(app, handId, {
      lastSeq: lastSeq(view),
      targetPlayerId: CPU,
      text: READ_TEXT,
    });
    expect(resent.statusCode).toBe(409);
    expect(resent.json<{ error: { kind: string } }>().error.kind).toBe(
      "stale_view",
    );

    // 相手を特定しない読み（意図）も残せる。
    const intent = await read(app, handId, {
      lastSeq: lastSeq(after),
      targetPlayerId: null,
      text: "Pot Odds で Call する",
    });
    expect(intent.statusCode).toBe(200);

    let current = intent.json<{ view: HeroView }>().view;
    for (let guard = 0; current.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
      current = await act(app, handId, current, passive(current));
    }
    const log = events(handId);
    expect(log.filter((e) => e.type === "USER_READ_RECORDED")).toHaveLength(2);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.some((i) => i.includes(READ_TEXT))).toBe(false);
    expect(inputs.some((i) => i.includes("USER_READ_RECORDED"))).toBe(false);
  });

  it("Hero の手番でない・終わった Hand・卓にいない席・Hero 自身への読み・空白だけの本文は拒否し、Event を足さない", async () => {
    const { app, events } = makeApp();
    const { handId, view } = await start(app, null);
    const before = events(handId).length;
    const seq = lastSeq(view);

    const invalidTarget = await read(app, handId, {
      lastSeq: seq,
      targetPlayerId: "nobody",
      text: "x",
    });
    expect(invalidTarget.statusCode).toBe(422);
    const self = await read(app, handId, {
      lastSeq: seq,
      targetPlayerId: HERO,
      text: "x",
    });
    expect(self.statusCode).toBe(422);
    const blank = await read(app, handId, {
      lastSeq: seq,
      targetPlayerId: null,
      text: "  ",
    });
    expect(blank.statusCode).toBe(422);
    const tooLong = await read(app, handId, {
      lastSeq: seq,
      targetPlayerId: null,
      text: "あ".repeat(201),
    });
    expect(tooLong.statusCode).toBe(400);
    const unknown = await read(app, "nope", {
      lastSeq: seq,
      targetPlayerId: null,
      text: "x",
    });
    expect(unknown.statusCode).toBe(404);
    expect(events(handId)).toHaveLength(before);

    // Hero が Fold した後（Hand から外れた）は手番が来ないので記録できない。Hand が終われば hand_complete。
    const folded = await act(app, handId, view, { type: "fold" });
    const res = await read(app, handId, {
      lastSeq: lastSeq(folded),
      targetPlayerId: null,
      text: "x",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { kind: string } }>().error.kind).toBe(
      folded.status === "complete" ? "hand_complete" : "not_actor",
    );
  });
});

describe("Note / Tag の API（D31・D112）", () => {
  const base = (handId: string, playerId = CPU) =>
    `/api/hands/${handId}/players/${playerId}`;

  it("Note / Tag を足し・消し、その席の今の Note / Tag を返す。同じ Session の次の Hand でも同じ対象として読める", async () => {
    const { app, inputs } = makeApp();
    const first = await start(app, null);
    const empty = await app.inject({
      method: "GET",
      url: `${base(first.handId)}/notes`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ notes: [], tags: [] });

    const added = await app.inject({
      method: "POST",
      url: `${base(first.handId)}/notes`,
      payload: { noteId: NOTE_ID, body: NOTE_TEXT },
    });
    expect(added.statusCode).toBe(201);
    const [note] = added.json<{ notes: { noteId: string; body: string }[] }>()
      .notes;
    expect(note?.body).toBe(NOTE_TEXT);
    // 応答だけが失われた追加の再送（同じ noteId）は、Note を増やさない。
    const resent = await app.inject({
      method: "POST",
      url: `${base(first.handId)}/notes`,
      payload: { noteId: NOTE_ID, body: NOTE_TEXT },
    });
    expect(resent.statusCode).toBe(201);
    expect(resent.json<{ notes: unknown[] }>().notes).toHaveLength(1);
    // 別の席の noteId は使えない。
    const conflict = await app.inject({
      method: "POST",
      url: `${base(first.handId, "cpu2")}/notes`,
      payload: { noteId: NOTE_ID, body: "別の席" },
    });
    expect(conflict.statusCode).toBe(409);
    await app.inject({
      method: "POST",
      url: `${base(first.handId)}/notes`,
      payload: { noteId: randomUUID(), body: "2 つ目" },
    });
    const tagged = await app.inject({
      method: "POST",
      url: `${base(first.handId)}/tags`,
      payload: { tag: "Loose" },
    });
    expect(tagged.json<{ tags: string[] }>().tags).toEqual(["Loose"]);

    // 次の Hand まで進める（同じ Session）。
    let view = first.view;
    for (let guard = 0; view.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
      view = await act(app, first.handId, view, passive(view));
    }
    const second = await start(app, first.handId);
    const carried = await app.inject({
      method: "GET",
      url: `${base(second.handId)}/notes`,
    });
    expect(
      carried.json<{ notes: { body: string }[]; tags: string[] }>(),
    ).toMatchObject({
      notes: [{ body: NOTE_TEXT }, { body: "2 つ目" }],
      tags: ["Loose"],
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `${base(second.handId)}/notes/${note?.noteId ?? ""}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      deleted.json<{ notes: { body: string }[] }>().notes.map((n) => n.body),
    ).toEqual(["2 つ目"]);
    const again = await app.inject({
      method: "DELETE",
      url: `${base(second.handId)}/notes/${note?.noteId ?? ""}`,
    });
    expect(again.statusCode).toBe(404);
    const untagged = await app.inject({
      method: "DELETE",
      url: `${base(second.handId)}/tags/Loose`,
    });
    expect(untagged.json<{ tags: string[] }>().tags).toEqual([]);

    // Note / Tag は CPU の入力に入らない。
    expect(inputs.some((i) => i.includes(NOTE_TEXT))).toBe(false);
    expect(inputs.some((i) => i.includes("Loose"))).toBe(false);
  });

  it("Hero・卓にいない席・知らない Hand は対象にできない。空白だけの本文・改行を含む Tag は拒否する", async () => {
    const { app } = makeApp();
    const { handId } = await start(app, null);
    const hero = await app.inject({
      method: "GET",
      url: `${base(handId, HERO)}/notes`,
    });
    expect(hero.statusCode).toBe(422);
    const nobody = await app.inject({
      method: "GET",
      url: `${base(handId, "nobody")}/notes`,
    });
    expect(nobody.statusCode).toBe(422);
    const unknown = await app.inject({
      method: "GET",
      url: `${base("nope")}/notes`,
    });
    expect(unknown.statusCode).toBe(404);
    const blank = await app.inject({
      method: "POST",
      url: `${base(handId)}/notes`,
      payload: { noteId: randomUUID(), body: "   " },
    });
    expect(blank.statusCode).toBe(422);
    const newline = await app.inject({
      method: "POST",
      url: `${base(handId)}/tags`,
      payload: { tag: "a\nb" },
    });
    expect(newline.statusCode).toBe(422);
    const state = await app.inject({
      method: "GET",
      url: `${base(handId)}/notes`,
    });
    expect(state.json()).toEqual({ notes: [], tags: [] });
  });
});
