// Session の mode（cash / tournament）の境界と、Tournament の設定の Snapshot（D108・D129・#183）。
// - mode を指定しない開始は既存の Cash の経路（Event・Stack・Blind を変えない）
// - Tournament は Preset の Starting Stack と 1 Level 目の Blind で始め、設定の Snapshot を SESSION_STARTED に残す
// - 同じ Session の Hand・Resume（再起動）は Snapshot の設定で続ける。続く Session に違う設定を求めたら拒否する
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOURNAMENT_PRESETS,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { PHASE1_TABLE_SETUP } from "./config.js";
import { InMemoryEventStore, type EventStore } from "./event-store.js";
import { HandOrchestrator, type SessionRequest } from "./hand-orchestrator.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

const HERO = "hero";
const STANDARD = TOURNAMENT_PRESETS.stt6_hand_count;
const TOURNAMENT: SessionRequest = {
  mode: "tournament",
  presetId: "stt6_hand_count",
};

function orchestratorOn(store: EventStore, prefix = "t") {
  let handNo = 0;
  let sessionNo = 0;
  return new HandOrchestrator({
    store,
    setup: PHASE1_TABLE_SETUP,
    createOpponent: createRuleBot,
    botDelayMs: 0,
    opponentTimeoutMs: 1000,
    nextSeed: () => 42 + handNo,
    nextHandId: () => `${prefix}-hand-${++handNo}`,
    nextSessionId: () => `${prefix}-session-${++sessionNo}`,
  });
}

/** Call できれば Call、できなければ Check（Showdown まで進みやすい）。 */
function passive(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

/** 1 Hand を始めて最後まで進め、Hand ID を返す。 */
async function playHand(
  orchestrator: HandOrchestrator,
  afterHandId: string | null,
  request?: SessionRequest,
): Promise<string> {
  const started = await orchestrator.startHand(afterHandId, request);
  if (!started.ok) throw new Error(started.error.message);
  let view = started.value.view;
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    expect(view.actorId).toBe(HERO);
    const result = await orchestrator.heroAction(
      started.value.handId,
      view.log.at(-1)?.seq ?? -1,
      passive(view),
    );
    if (!result.ok) throw new Error(result.error.message);
    view = result.value;
  }
  return started.value.handId;
}

function eventsOf(store: EventStore, handId: string): HandEvent[] {
  return store.read(handId).map((s) => s.event);
}

function startedOf(events: readonly HandEvent[]) {
  const started = events[0];
  if (started?.type !== "HAND_STARTED") throw new Error("HAND_STARTED が無い");
  return started;
}

function sessionStartedOf(events: readonly HandEvent[]) {
  return events.find((e) => e.type === "SESSION_STARTED");
}

describe("Session の mode の境界（#183）", () => {
  it("mode を指定しない開始と cash の指定は、既存の Cash の経路（Starting Stack・Blind・SESSION_STARTED の形）のまま", async () => {
    for (const request of [undefined, { mode: "cash" } as const]) {
      const store = new InMemoryEventStore();
      const orchestrator = orchestratorOn(store);
      const handId = await playHand(orchestrator, null, request);
      const events = eventsOf(store, handId);
      const started = startedOf(events);
      expect(started.smallBlind).toBe(PHASE1_TABLE_SETUP.table.smallBlind);
      expect(started.bigBlind).toBe(PHASE1_TABLE_SETUP.table.bigBlind);
      expect(started.seats.map((s) => s.stack)).toEqual(
        PHASE1_TABLE_SETUP.players.map(() => PHASE1_TABLE_SETUP.startingStack),
      );
      // cash の SESSION_STARTED は Snapshot の項目ごと持たない（Event の形を変えない）。
      const session = sessionStartedOf(events);
      expect(session).toEqual({
        type: "SESSION_STARTED",
        sessionId: "t-session-1",
        seq: session?.seq,
        visibility: { type: "system" },
      });
      orchestrator.close();
    }
  });

  it("Tournament は Preset の Starting Stack と 1 Level 目の Blind で始め、設定の Snapshot を SESSION_STARTED に残す（D129）", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const handId = await playHand(orchestrator, null, TOURNAMENT);
    const events = eventsOf(store, handId);
    const started = startedOf(events);
    expect(started.smallBlind).toBe(10);
    expect(started.bigBlind).toBe(20);
    // Rule Profile は Cash と共有する（Hand の Rule の Invariant を共有。D108）。
    expect(started.ruleProfile).toBe(PHASE1_TABLE_SETUP.table.ruleProfile);
    expect(started.seats.map((s) => s.stack)).toEqual(
      PHASE1_TABLE_SETUP.players.map(() => 1_500),
    );
    const session = sessionStartedOf(events);
    expect(session).toEqual({
      type: "SESSION_STARTED",
      sessionId: "t-session-1",
      tournament: STANDARD,
      seq: session?.seq,
      visibility: { type: "system" },
    });
    // Chip は増減しない（INV-TEST-002）。
    const finished = events.find((e) => e.type === "HAND_FINISHED");
    if (finished?.type !== "HAND_FINISHED") throw new Error("終わっていない");
    expect(finished.stacks.reduce((sum, s) => sum + s.amount, 0)).toBe(
      1_500 * PHASE1_TABLE_SETUP.players.length,
    );
    orchestrator.close();
  });

  it("同じ Session の次の Hand は、mode を省いても Tournament の設定で続ける（SESSION_STARTED は置かない）", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const first = await playHand(orchestrator, null, TOURNAMENT);
    const second = await playHand(orchestrator, first);
    const third = await playHand(orchestrator, second, TOURNAMENT);
    for (const handId of [second, third]) {
      const events = eventsOf(store, handId);
      expect(startedOf(events).bigBlind).toBe(20);
      expect(sessionStartedOf(events)).toBeUndefined();
    }
    expect(store.sessionIdOfHand(third)).toBe(store.sessionIdOfHand(first));
    orchestrator.close();
  });

  it("続く Session に違う設定（mode・Preset）を求めたら、Hand を作らず session_mode_mismatch で拒否する", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const cashHand = await playHand(orchestrator, null);
    const rejected = await orchestrator.startHand(cashHand, TOURNAMENT);
    expect(rejected).toMatchObject({
      ok: false,
      error: { kind: "session_mode_mismatch" },
    });
    expect(store.listHands(10)).toHaveLength(1);
    orchestrator.close();

    const tStore = new InMemoryEventStore();
    const tournament = orchestratorOn(tStore);
    const tHand = await playHand(tournament, null, TOURNAMENT);
    for (const request of [
      { mode: "cash" },
      { mode: "tournament", presetId: "stt6_time_base" },
    ] as const) {
      expect(await tournament.startHand(tHand, request)).toMatchObject({
        ok: false,
        error: { kind: "session_mode_mismatch" },
      });
    }
    tournament.close();
  });

  it("開始の再送（まだ結果を見ていない Hand）は、設定が違っても新しく作らずその Hand を返す", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const handId = await playHand(orchestrator, null);
    const again = await orchestrator.startHand(null, TOURNAMENT);
    expect(again).toMatchObject({
      ok: true,
      value: { handId, created: false },
    });
    orchestrator.close();
  });
});

describe("Tournament の Session の Resume（SQLite。#183・D129）", () => {
  let dir: string;
  const opened: SqliteEventStore[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proj-poker-tournament-"));
  });

  afterEach(() => {
    opened.splice(0).forEach((store) => store.close());
    rmSync(dir, { recursive: true, force: true });
  });

  function open(): SqliteEventStore {
    const store = SqliteEventStore.open(join(dir, "poker.sqlite"), {});
    opened.push(store);
    return store;
  }

  it("再起動後も、Session の最初の Hand の Snapshot から Tournament の設定を戻して続ける", async () => {
    const store = open();
    const before = orchestratorOn(store, "a");
    const first = await playHand(before, null, TOURNAMENT);
    const second = await playHand(before, first);
    before.close();
    opened.splice(0).forEach((s) => s.close());

    const reopened = open();
    const after = orchestratorOn(reopened, "b");
    // mode を省いた開始でも、続く Session の設定（Tournament）で続ける。
    const third = await playHand(after, second);
    const events = eventsOf(reopened, third);
    expect(reopened.sessionIdOfHand(third)).toBe(
      reopened.sessionIdOfHand(first),
    );
    expect(startedOf(events).bigBlind).toBe(20);
    expect(sessionStartedOf(events)).toBeUndefined();
    // 保存して読み直した Snapshot も同じ設定。
    expect(sessionStartedOf(eventsOf(reopened, first))).toMatchObject({
      tournament: STANDARD,
    });
    // 続く Tournament の Session に cash を求めたら拒否する。
    expect(await after.startHand(third, { mode: "cash" })).toMatchObject({
      ok: false,
      error: { kind: "session_mode_mismatch" },
    });
    after.close();
  });

  it("再起動後の Cash の Session は cash のまま続ける（Snapshot の無い SESSION_STARTED は cash）", async () => {
    const store = open();
    const before = orchestratorOn(store, "a");
    const first = await playHand(before, null);
    before.close();
    opened.splice(0).forEach((s) => s.close());

    const reopened = open();
    const after = orchestratorOn(reopened, "b");
    const second = await playHand(after, first, { mode: "cash" });
    expect(reopened.sessionIdOfHand(second)).toBe(
      reopened.sessionIdOfHand(first),
    );
    expect(startedOf(eventsOf(reopened, second)).bigBlind).toBe(
      PHASE1_TABLE_SETUP.table.bigBlind,
    );
    after.close();
  });
});

describe("POST /api/hands の session（#183）", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
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
    return { app, store };
  }

  it("Tournament の Preset を受け取り、その設定で新しい Session を始める", async () => {
    const { app, store } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hands",
      payload: { afterHandId: null, session: TOURNAMENT },
    });
    expect(res.statusCode).toBe(201);
    const { handId } = res.json<{ handId: string }>();
    expect(sessionStartedOf(eventsOf(store, handId))).toMatchObject({
      tournament: STANDARD,
    });
    // 応答には設定の Snapshot（Event）を載せない（system の Event は Hero の View に入らない）。
    expect(res.body).not.toContain("SESSION_STARTED");
  });

  it.each([
    ["知らない Preset", { mode: "tournament", presetId: "mtt" }],
    ["Preset の無い Tournament", { mode: "tournament" }],
    ["cash に Preset", { mode: "cash", presetId: "stt6_hand_count" }],
    ["知らない mode", { mode: "sit_and_go" }],
  ])("%s は 400", async (_name, session) => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hands",
      payload: { afterHandId: null, session },
    });
    expect(res.statusCode).toBe(400);
  });

  it("続く Session に違う mode を求めたら 409（session_mode_mismatch）", async () => {
    const { app } = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/hands",
      payload: { afterHandId: null },
    });
    const { handId, view } = first.json<{ handId: string; view: HeroView }>();
    // Hero が Fold して Hand を終える（Session は続く）。
    let current = view;
    while (current.status !== "complete") {
      const res = await app.inject({
        method: "POST",
        url: `/api/hands/${handId}/actions`,
        payload: {
          lastSeq: current.log.at(-1)?.seq ?? -1,
          action: { type: "fold" },
        },
      });
      expect(res.statusCode).toBe(200);
      current = res.json<{ view: HeroView }>().view;
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/hands",
      payload: { afterHandId: handId, session: TOURNAMENT },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { kind: "session_mode_mismatch" },
    });
  });
});
