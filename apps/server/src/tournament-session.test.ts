// Session の mode（cash / tournament）の境界と、Tournament の設定の Snapshot（D108・D129・#183）。
// - mode を指定しない開始は既存の Cash の経路（Event・Stack・Blind を変えない）
// - Tournament は Preset の Starting Stack と 1 Level 目の Blind で始め、設定の Snapshot を SESSION_STARTED に残す
// - 同じ Session の Hand・Resume（再起動）は Snapshot の設定で続ける。続く Session に違う設定を求めたら拒否する
// - Hand の開始時の Level（hand_count / time_base）と Ante（D128・#184）。Level と経過は HAND_STARTED に固定し、Resume でも作り直す
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOURNAMENT_PRESETS,
  levelAt,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { PHASE1_TABLE_SETUP, buildTableSetup } from "./config.js";
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

function orchestratorOn(
  store: EventStore,
  prefix = "t",
  playClock?: () => number,
) {
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
    ...(playClock === undefined ? {} : { playClock }),
  });
}

/** Call できれば Call、できなければ Check（Showdown まで進みやすい）。 */
function passive(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

/** Check できれば Check、できなければ Fold（Hero の Stack を減らしにくく、多数の Hand を続けやすい）。 */
function foldOrCheck(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  return types.includes("check") ? { type: "check" } : { type: "fold" };
}

/**
 * 1 Hand を始めて最後まで進め、Hand ID を返す。onStarted は開始の直後（Hero の最初の Action の前）に呼ぶ
 * （時計を進めて、Hand の途中で経過した時間を作る）。
 */
async function playHand(
  orchestrator: HandOrchestrator,
  afterHandId: string | null,
  request?: SessionRequest,
  policy: (view: HeroView) => PlayerAction = passive,
  onStarted?: () => void,
): Promise<string> {
  const started = await orchestrator.startHand(afterHandId, request);
  if (!started.ok) throw new Error(started.error.message);
  onStarted?.();
  let view = started.value.view;
  for (let guard = 0; view.status !== "complete"; guard++) {
    expect(guard).toBeLessThan(100);
    expect(view.actorId).toBe(HERO);
    const result = await orchestrator.heroAction(
      started.value.handId,
      view.log.at(-1)?.seq ?? -1,
      policy(view),
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

  it("Preset の参加人数と卓の人数が違う卓では Tournament を始めず、tournament_unavailable で拒否する（cash は始められる）", async () => {
    const store = new InMemoryEventStore();
    let handNo = 0;
    const orchestrator = new HandOrchestrator({
      store,
      setup: buildTableSetup(2),
      createOpponent: createRuleBot,
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42,
      nextHandId: () => `hu-hand-${++handNo}`,
    });
    expect(await orchestrator.startHand(null, TOURNAMENT)).toMatchObject({
      ok: false,
      error: { kind: "tournament_unavailable" },
    });
    expect(store.listHands(10)).toHaveLength(0);
    // 拒否では Hand ID を採番しない（次の開始が最初の ID を使う）。
    const cash = await orchestrator.startHand(null, { mode: "cash" });
    expect(cash).toMatchObject({ ok: true, value: { handId: "hu-hand-1" } });
    orchestrator.close();
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

/** Hand の BB の席と、開始時の Stack から払える Big Blind Ante の額（BB を先に払い、残りで払う。D128）。 */
function expectedBigBlindAnte(events: readonly HandEvent[]): {
  readonly playerId: string;
  readonly amount: number;
} {
  const started = startedOf(events);
  const bb = events.find((e) => e.type === "BLIND_POSTED" && e.blind === "big");
  if (bb?.type !== "BLIND_POSTED") throw new Error("BB が無い");
  const stack =
    started.seats.find((s) => s.playerId === bb.playerId)?.stack ?? 0;
  const ante = started.ante?.amount ?? 0;
  return { playerId: bb.playerId, amount: Math.min(ante, stack - bb.amount) };
}

describe("Tournament の Hand の Level と Ante（D128・#184）", () => {
  const TIME_BASE: SessionRequest = {
    mode: "tournament",
    presetId: "stt6_time_base",
  };
  const MINUTE = 60 * 1_000;

  it("hand_count: Session の Hand の数で 10 Hand ごとに Level を上げ、その Level の Blind と Big Blind Ante で始める（Chip は増減しない）", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    let previous: string | null = null;
    for (let k = 1; k <= 11; k++) {
      const handId = await playHand(
        orchestrator,
        previous,
        k === 1 ? TOURNAMENT : undefined,
        foldOrCheck,
      );
      const events = eventsOf(store, handId);
      const started = startedOf(events);
      // 1〜10 Hand 目は Level 1（10/20・Ante 20）、11 Hand 目は Level 2（15/30・Ante 30）。
      const level = k <= 10 ? 1 : 2;
      const blinds = STANDARD.levels[level - 1];
      expect(started.tournament).toEqual({
        level,
        handNumber: k,
        // hand_count でもプレイ時間は残す（Level には使わない）。
        playTimeMs: started.tournament?.playTimeMs,
      });
      expect(started.smallBlind).toBe(blinds?.smallBlind);
      expect(started.bigBlind).toBe(blinds?.bigBlind);
      expect(started.ante).toEqual({
        kind: "big_blind_ante",
        amount: blinds?.ante,
      });
      // Ante は BB の席が Blind の後に払う（Stack が足りなければ減り、0 なら置かない）。
      const expected = expectedBigBlindAnte(events);
      const antes = events.filter((e) => e.type === "ANTE_POSTED");
      expect(antes.map((e) => [e.playerId, e.amount])).toEqual(
        expected.amount > 0 ? [[expected.playerId, expected.amount]] : [],
      );
      // Chip は Session を通して増減しない（INV-TEST-002。Ante は Pot に入って誰かへ配られる）。
      const finished = events.find((e) => e.type === "HAND_FINISHED");
      if (finished?.type !== "HAND_FINISHED") throw new Error("終わっていない");
      expect(finished.stacks.reduce((sum, x) => sum + x.amount, 0)).toBe(
        STANDARD.startingStack * PHASE1_TABLE_SETUP.players.length,
      );
      previous = handId;
    }
    orchestrator.close();
  });

  it("time_base: Hand の開始から終わりまでの時間だけを累計し（Hand の間は数えない）、累計で Level を決めて HAND_STARTED に固定する", async () => {
    const TIME = TOURNAMENT_PRESETS.stt6_time_base;
    let now = 1_000;
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store, "t", () => now);
    let previous: string | null = null;
    let expectedPlayTime = 0;
    let reachedLevel2 = false;
    for (let k = 1; k <= 8; k++) {
      // Hand と Hand の間（結果を見ている間）の 30 分は数えない。
      now += 30 * MINUTE;
      let startedView: HeroView | null = null;
      const handId = await playHand(
        orchestrator,
        previous,
        k === 1 ? TIME_BASE : undefined,
        (view) => {
          startedView ??= view;
          return foldOrCheck(view);
        },
        // Hand の途中で 4 分経つ（Hero の Action で Hand が終わる）。
        () => {
          now += 4 * MINUTE;
        },
      );
      const started = startedOf(eventsOf(store, handId));
      expect(started.tournament?.handNumber).toBe(k);
      expect(started.tournament?.playTimeMs).toBe(expectedPlayTime);
      const level = levelAt(TIME, {
        handNumber: k,
        playTimeMs: expectedPlayTime,
      });
      expect(started.tournament?.level).toBe(level);
      expect(started.bigBlind).toBe(TIME.levels[level - 1]?.bigBlind);
      if (level >= 2) reachedLevel2 = true;
      // Hero が行動した Hand は 4 分、Hero の行動の前に終わった Hand（開始の時点で終わった・Hero の前に決まった）は 0。
      if (startedView !== null) expectedPlayTime += 4 * MINUTE;
      previous = handId;
    }
    expect(reachedLevel2).toBe(true);
    orchestrator.close();
  });

  it("time_base: 時計が巻き戻っても Hand のプレイ時間は負にならない（累計は減らない）", async () => {
    let now = 10 * MINUTE;
    let acted = 0;
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store, "t", () => now);
    const first = await playHand(
      orchestrator,
      null,
      TIME_BASE,
      (view) => {
        acted++;
        return passive(view);
      },
      () => {
        now -= 5 * MINUTE;
      },
    );
    // Hero の Action で Hand が終わる（終わりの時刻が開始より 5 分前になる）ことを前提にする。
    expect(acted).toBeGreaterThan(0);
    const second = await playHand(orchestrator, first, undefined, passive);
    expect(startedOf(eventsOf(store, second)).tournament).toEqual({
      level: 1,
      handNumber: 2,
      playTimeMs: 0,
    });
    orchestrator.close();
  });

  it("Cash の Hand は Level・Ante を持たない（HAND_STARTED の形と ANTE_POSTED の無さは今までと同じ）", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const first = await playHand(orchestrator, null);
    const second = await playHand(orchestrator, first);
    for (const handId of [first, second]) {
      const events = eventsOf(store, handId);
      expect(startedOf(events)).not.toHaveProperty("ante");
      expect(startedOf(events)).not.toHaveProperty("tournament");
      expect(events.some((e) => e.type === "ANTE_POSTED")).toBe(false);
    }
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

  it("再起動後は、最後の Hand の HAND_STARTED の Level と経過から、同じ数え方で次の Hand の Level を作り直す（D128）", async () => {
    // 前のプロセス: 単調な時計で Hand のプレイ時間を測る。壁時計（記録時刻）も同じだけ進める。
    let wall = Date.parse("2026-10-09T00:00:00.000Z");
    let clock = 0;
    const store = SqliteEventStore.open(join(dir, "poker.sqlite"), {
      now: () => new Date(wall),
    });
    opened.push(store);
    const before = orchestratorOn(store, "a", () => clock);
    const advance = (ms: number) => () => {
      wall += ms;
      clock += ms;
    };
    let acted = 0;
    const counting = (view: HeroView) => {
      acted++;
      return foldOrCheck(view);
    };
    const first = await playHand(
      before,
      null,
      { mode: "tournament", presetId: "stt6_time_base" },
      counting,
      advance(6 * 60_000),
    );
    const firstActed = acted > 0;
    acted = 0;
    const second = await playHand(
      before,
      first,
      undefined,
      counting,
      advance(7 * 60_000),
    );
    const secondActed = acted > 0;
    before.close();
    opened.splice(0).forEach((s) => s.close());

    // 再起動: 前の Hand の長さは、保存した記録時刻の差から作る（この Process の時計は 0 から）。
    const reopened = open();
    const after = orchestratorOn(reopened, "b", () => 0);
    const third = await playHand(after, second, undefined, foldOrCheck);
    const secondStarted = startedOf(eventsOf(reopened, second)).tournament;
    expect(secondStarted).toEqual({
      level: 1,
      handNumber: 2,
      playTimeMs: firstActed ? 6 * 60_000 : 0,
    });
    const playTimeMs =
      (secondStarted?.playTimeMs ?? 0) + (secondActed ? 7 * 60_000 : 0);
    expect(startedOf(eventsOf(reopened, third)).tournament).toEqual({
      level: playTimeMs >= 10 * 60_000 ? 2 : 1,
      handNumber: 3,
      playTimeMs,
    });
    after.close();
  });

  it("再起動の前の Hand の記録時刻が巻き戻っていても、プレイ時間は負にならない", async () => {
    let wall = Date.parse("2026-10-09T00:00:00.000Z");
    const store = SqliteEventStore.open(join(dir, "poker.sqlite"), {
      now: () => new Date(wall),
    });
    opened.push(store);
    const before = orchestratorOn(store, "a", () => 0);
    let acted = 0;
    const first = await playHand(
      before,
      null,
      { mode: "tournament", presetId: "stt6_time_base" },
      (view) => {
        acted++;
        return passive(view);
      },
      () => {
        wall -= 60 * 60_000;
      },
    );
    // HAND_FINISHED の記録時刻が最初の Event より 1 時間前になる（Hero の Action で Hand が終わる）ことを前提にする。
    expect(acted).toBeGreaterThan(0);
    before.close();
    opened.splice(0).forEach((s) => s.close());

    const reopened = open();
    const after = orchestratorOn(reopened, "b", () => 0);
    const second = await playHand(after, first, undefined, passive);
    expect(startedOf(eventsOf(reopened, second)).tournament).toEqual({
      level: 1,
      handNumber: 2,
      playTimeMs: 0,
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

/** All-in できれば All-in、できなければ Call / Check（Tournament を早く終わらせる）。 */
function shove(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("all_in")) return { type: "all_in" };
  return passive(view);
}

describe("Tournament の Elimination と順位（D129・#185）", () => {
  it("Hero の Bust（か Hero が最後の 1 人）で Tournament を終え、Hero の順位を Event Log から計算する。Bust した席は次の Hand に座らない", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const handIds: string[] = [];
    let previous: string | null = null;
    for (let guard = 0; ; guard++) {
      expect(guard).toBeLessThan(200);
      const handId = await playHand(
        orchestrator,
        previous,
        previous === null ? TOURNAMENT : undefined,
        shove,
      );
      handIds.push(handId);
      previous = handId;
      if (orchestrator.sessionStatus(handId)?.state === "ended") break;
    }
    const last = handIds.at(-1) as string;
    const ended = eventsOf(store, last).find((e) => e.type === "SESSION_ENDED");
    if (ended?.type !== "SESSION_ENDED") throw new Error("終わっていない");
    // 1 つの Session（Tournament）の Hand だけで終わる。
    expect(store.sessionHandIds(last)).toEqual(handIds);

    const standings = orchestrator.tournamentStandingsOf(last);
    if (standings === null) throw new Error("Tournament の順位が無い");
    expect(standings.status).toBe("finished");
    expect(standings.entrants).toBe(PHASE1_TABLE_SETUP.players.length);
    const hero = standings.placements.find((p) => p.playerId === HERO);
    const undecided = standings.placements.filter((p) => p.place === null);
    if (ended.reason === "hero_last_standing") {
      expect(hero).toEqual({
        playerId: HERO,
        place: 1,
        eliminatedInHandId: null,
      });
      expect(undecided).toEqual([]);
    } else {
      expect(ended.reason).toBe("hero_busted");
      expect(hero?.eliminatedInHandId).toBe(last);
      // Hero の順位は、Bust した Hand の後に残った人数より下（同じ Hand の Bust は開始時の Stack で並べる）。
      expect(hero?.place).toBeGreaterThan(standings.remaining);
      // 残った CPU の順位は、残りが 1 人（優勝が決まった）でなければ未決（D129）。
      expect(undecided).toHaveLength(
        standings.remaining === 1 ? 0 : standings.remaining,
      );
    }
    // Bust した席は次の Hand に座らない（nextHandSeating）。各 Hand の席は、その前までに Bust していない Player だけ。
    for (const [k, handId] of handIds.entries()) {
      const seated = startedOf(eventsOf(store, handId)).seats.map(
        (s) => s.playerId,
      );
      const bustedBefore = standings.placements.filter(
        (p) =>
          p.eliminatedInHandId !== null &&
          handIds.indexOf(p.eliminatedInHandId) < k,
      );
      expect(seated).toHaveLength(
        PHASE1_TABLE_SETUP.players.length - bustedBefore.length,
      );
      for (const p of bustedBefore) expect(seated).not.toContain(p.playerId);
    }
    // 同じ Event Log からは同じ順位（決定論。保存せず都度計算する）。
    expect(orchestrator.tournamentStandingsOf(last)).toEqual(standings);
    orchestrator.close();
  });

  it("cash の Session には Tournament の順位が無い（Cash の経路は変えない）", async () => {
    const store = new InMemoryEventStore();
    const orchestrator = orchestratorOn(store);
    const handId = await playHand(orchestrator, null);
    expect(orchestrator.tournamentStandingsOf(handId)).toBeNull();
    expect(orchestrator.tournamentStandingsOf("unknown")).toBeNull();
    orchestrator.close();
  });
});
