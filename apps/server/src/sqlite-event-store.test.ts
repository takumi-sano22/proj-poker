import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyAction,
  composeChips,
  foldHandEvents,
  getLegalActions,
  PHASE1_CASH_PRESET,
  startHand,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "./config.js";
import { EventSeqConflictError } from "./event-store.js";
import type { HandEventV2 } from "./event-upcast.js";
import { HandOrchestrator } from "./hand-orchestrator.js";
import type { OpponentFactory } from "./opponents/opponent-agent.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import {
  nextSessionProjection,
  type SessionProjection,
} from "./session-projection.js";
import {
  EVENT_SCHEMA_VERSION,
  SqliteEventStore,
  UnsupportedEventSchemaError,
} from "./sqlite-event-store.js";

// テストは一時ディレクトリの使い捨て DB で行い、開発用の DB を汚さない。
let dir: string;
let dbPath: string;
const opened: SqliteEventStore[] = [];

function open(options: Parameters<typeof SqliteEventStore.open>[1] = {}) {
  const store = SqliteEventStore.open(dbPath, options);
  opened.push(store);
  return store;
}

/** 再起動の代わり: いま開いている Store を閉じて、同じファイルを開き直す。 */
function reopen() {
  opened.splice(0).forEach((store) => store.close());
  return open();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-store-"));
  dbPath = join(dir, "poker.sqlite");
});

afterEach(() => {
  opened.splice(0).forEach((store) => store.close());
  rmSync(dir, { recursive: true, force: true });
});

/** 2 人卓で始め、手番の Player が Fold して終わる 1 Hand の Event（HAND_FINISHED まで）。 */
function finishedHandEvents(handId: string): {
  started: readonly HandEvent[];
  rest: readonly HandEvent[];
} {
  const started = startHand({
    handId,
    seats: [
      { playerId: "a", stack: 200 },
      { playerId: "b", stack: 200 },
    ],
    buttonPlayerId: "a",
    config: PHASE1_CASH_PRESET,
    deal: { seed: 7 },
  });
  if (!started.ok) throw new Error(started.error.message);
  const state = foldHandEvents(started.value.events);
  const actor = getLegalActions(state)?.playerId;
  if (actor === undefined) throw new Error("手番が無い");
  const folded = applyAction(state, actor, { type: "fold" });
  if (!folded.ok) throw new Error(folded.error.message);
  expect(folded.value.events.at(-1)?.type).toBe("HAND_FINISHED");
  return { started: started.value.events, rest: folded.value.events };
}

/** 3 人卓で、最初の手番が Fold し、残りの 2 人が Call / Check で Showdown まで進む 1 Hand の Event。 */
function showdownHandEvents(handId: string): {
  started: readonly HandEvent[];
  rest: readonly HandEvent[];
} {
  const started = startHand({
    handId,
    seats: [
      { playerId: "a", stack: 200 },
      { playerId: "b", stack: 200 },
      { playerId: "c", stack: 200 },
    ],
    buttonPlayerId: "a",
    config: PHASE1_CASH_PRESET,
    deal: { seed: 7 },
  });
  if (!started.ok) throw new Error(started.error.message);
  const events: HandEvent[] = [];
  let state = foldHandEvents(started.value.events);
  for (let step = 0; state.status !== "complete"; step++) {
    const legal = getLegalActions(state);
    if (legal === null || step > 50) throw new Error("Hand が進まない");
    const types = legal.actions.map((a) => a.type);
    const action: PlayerAction =
      step === 0
        ? { type: "fold" }
        : types.includes("call")
          ? { type: "call" }
          : { type: "check" };
    const result = applyAction(state, legal.playerId, action);
    if (!result.ok) throw new Error(result.error.message);
    state = result.value.state;
    events.push(...result.value.events);
  }
  expect(events.some((e) => e.type === "CARDS_TABLED")).toBe(true);
  return { started: started.value.events, rest: events };
}

/** 指定した版で Hand の行を直接書く（旧版の行を用意するため）。 */
function insertRows(
  handId: string,
  version: number,
  events: readonly object[],
) {
  open().close();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
      INSERT INTO hands VALUES ('${handId}', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
    `);
    const insert = db.prepare(
      "INSERT INTO events VALUES (?, ?, ?, ?, ?, '2026-10-05T00:00:00.000Z', ?)",
    );
    events.forEach((e, i) => {
      const { type } = e as { type: string };
      insert.run(`e${i}`, handId, i, type, version, JSON.stringify(e));
    });
  } finally {
    db.close();
  }
}

describe("SqliteEventStore（保存の経路）", () => {
  it("HAND_FINISHED で保存し、開き直しても Event の順序と内容・event_id・記録時刻が一致する", () => {
    let id = 0;
    const store = open({
      now: () => new Date("2026-10-05T00:00:00Z"),
      newEventId: () => `e${++id}`,
      sessionId: "s1",
    });
    const { started, rest } = finishedHandEvents("h1");
    store.append("h1", started);
    store.append("h1", rest);
    const before = store.read("h1");

    const after = reopen().read("h1");
    expect(after.map((s) => s.event)).toEqual([...started, ...rest]);
    expect(after).toEqual(before);
    expect(after.map((s) => s.event.seq)).toEqual(after.map((_, i) => i));

    // hands・sessions の行も同じトランザクションで書かれている。
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT * FROM hands").all()).toEqual([
        {
          hand_id: "h1",
          session_id: "s1",
          started_at: "2026-10-05T00:00:00.000Z",
          finished_at: "2026-10-05T00:00:00.000Z",
        },
      ]);
      expect(db.prepare("SELECT session_id FROM sessions").all()).toEqual([
        { session_id: "s1" },
      ]);
      expect(
        db.prepare("SELECT DISTINCT schema_version FROM events").all(),
      ).toEqual([{ schema_version: EVENT_SCHEMA_VERSION }]);
    } finally {
      db.close();
    }
  });

  it("Hand の最初の追記で渡した Session に Hand を保存し、Session の行は最初の Hand の開始時刻で 1 回だけ作る", () => {
    let minute = 0;
    // 追記のたびに 1 分進む時計（Session の開始時刻がどの Hand から来たかを見分ける）。
    const store = open({
      now: () => new Date(Date.UTC(2026, 9, 6, 0, minute++)),
      sessionId: "fallback",
    });
    for (const [handId, sessionId] of [
      ["h1", "s1"],
      ["h2", "s1"],
      ["h3", "s2"],
    ] as const) {
      const { started, rest } = finishedHandEvents(handId);
      store.append(handId, started, { sessionId });
      // 2 回目以降の追記の Session は見ない（Hand の Session は最初の追記で決まる）。
      store.append(handId, rest, { sessionId: "ignored" });
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT hand_id, session_id FROM hands ORDER BY hand_id")
          .all(),
      ).toEqual([
        { hand_id: "h1", session_id: "s1" },
        { hand_id: "h2", session_id: "s1" },
        { hand_id: "h3", session_id: "s2" },
      ]);
      expect(
        db.prepare("SELECT * FROM sessions ORDER BY session_id").all(),
      ).toEqual([
        { session_id: "s1", started_at: "2026-10-06T00:00:00.000Z" },
        { session_id: "s2", started_at: "2026-10-06T00:04:00.000Z" },
      ]);
    } finally {
      db.close();
    }
  });

  it("HAND_FINISHED 前の Hand は保存せず、開き直すと残らない（Completed Hand が保存境界。D62）", () => {
    const store = open();
    const { started } = finishedHandEvents("h1");
    store.append("h1", started);
    expect(store.read("h1").length).toBe(started.length);

    expect(reopen().read("h1")).toEqual([]);
  });

  it("listHands は保存済みの Hand とメモリの途中の Hand を開始の新しい順に返し、開き直すと途中の Hand は一覧から消える", () => {
    let minute = 0;
    const store = open({
      now: () => new Date(Date.UTC(2026, 9, 5, 0, minute++)),
    });
    const h1 = finishedHandEvents("h1");
    store.append("h1", h1.started);
    store.append("h1", h1.rest);
    const h2 = finishedHandEvents("h2");
    store.append("h2", h2.started);
    const h3 = finishedHandEvents("h3");
    store.append("h3", h3.started);
    store.append("h3", h3.rest);

    // h2 は途中（メモリだけ）で、保存済みの h1 と h3 の間に始まった。
    expect(store.listHands(10)).toEqual([
      {
        handId: "h3",
        startedAt: "2026-10-05T00:03:00.000Z",
        finishedAt: "2026-10-05T00:04:00.000Z",
        aborted: false,
      },
      {
        handId: "h2",
        startedAt: "2026-10-05T00:02:00.000Z",
        finishedAt: null,
        aborted: false,
      },
      {
        handId: "h1",
        startedAt: "2026-10-05T00:00:00.000Z",
        finishedAt: "2026-10-05T00:01:00.000Z",
        aborted: false,
      },
    ]);
    expect(store.listHands(2).map((h) => h.handId)).toEqual(["h3", "h2"]);
    expect(
      reopen()
        .listHands(10)
        .map((h) => h.handId),
    ).toEqual(["h3", "h1"]);
  });

  it("開き直した後も、保存済み（終了済み）の Hand へは追記できない", () => {
    const { started, rest } = finishedHandEvents("h1");
    open().append("h1", [...started, ...rest]);
    const count = started.length + rest.length;

    // 開き直すとメモリ側は空。DB に Hand があることで、終わった Hand と判定する。
    const store = reopen();
    const extra = { ...(rest.at(-1) as HandEvent), seq: count };
    expect(() => store.append("h1", [extra])).toThrow(EventSeqConflictError);
    expect(reopen().read("h1").length).toBe(count);
  });

  it("保存済みの Event は DB 上でも書き換えられない（append-only）", () => {
    const store = open();
    const { started, rest } = finishedHandEvents("h1");
    store.append("h1", [...started, ...rest]);
    store.close();

    const db = new DatabaseSync(dbPath);
    try {
      expect(() =>
        db.exec("UPDATE events SET payload = '{}' WHERE seq = 0"),
      ).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("知らない schema_version の Event は読まずに失敗する（旧形式を黙って新形式として扱わない）", () => {
    open().close();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
        INSERT INTO events VALUES ('e1', 'h1', 0, 'HAND_STARTED', ${EVENT_SCHEMA_VERSION + 1}, '2026-10-05T00:00:00.000Z', '{}');
      `);
    } finally {
      db.close();
    }
    expect(() => open().read("h1")).toThrow(UnsupportedEventSchemaError);
  });

  it.each([
    ["Fold で決着した Hand", () => finishedHandEvents("h1")],
    [
      "Fold した Player がいて Showdown まで進んだ Hand",
      () => showdownHandEvents("h1"),
    ],
  ])(
    "版 1 の行は読み込み時に upcast し、Main Pot の potIndex と eligible を補う。行は書き換えない（D76・D78）: %s",
    (_, make) => {
      const { started, rest } = make();
      const current = [...started, ...rest];
      // 単一 Pot の Hand では、版 1 の形（potIndex・eligible・reopenRule なし）に戻して保存したものを upcast すると、
      // 現在の Engine が発行した Event と一致する。
      const v1 = toV2(current).map((e) => {
        if (e.type !== "POT_AWARDED") return e;
        const v1Award: Record<string, unknown> = { ...e };
        delete v1Award.potIndex;
        delete v1Award.eligible;
        return v1Award;
      });
      insertRows("h1", 1, v1);

      expect(
        open()
          .read("h1")
          .map((s) => s.event),
      ).toEqual(current);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        // 保存済みの行は版 1 のまま（payload も書き換えない）。
        expect(
          db.prepare("SELECT DISTINCT schema_version FROM events").all(),
        ).toEqual([{ schema_version: 1 }]);
        const award = db
          .prepare("SELECT payload FROM events WHERE type = 'POT_AWARDED'")
          .get() as { payload: string };
        expect(JSON.parse(award.payload)).not.toHaveProperty("potIndex");
      } finally {
        db.close();
      }
    },
  );

  it("版 2 の行は読み込み時に upcast し、HAND_STARTED の reopenRule を補う。行は書き換えない（D76・D79）", () => {
    const { started, rest } = showdownHandEvents("h1");
    const current = [...started, ...rest];
    insertRows("h1", 2, toV2(current));

    expect(
      open()
        .read("h1")
        .map((s) => s.event),
    ).toEqual(current);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT DISTINCT schema_version FROM events").all(),
      ).toEqual([{ schema_version: 2 }]);
      const head = db
        .prepare("SELECT payload FROM events WHERE type = 'HAND_STARTED'")
        .get() as { payload: string };
      expect(JSON.parse(head.payload)).not.toHaveProperty("reopenRule");
    } finally {
      db.close();
    }
  });

  it("版 3 の行は変換せずに読む（保存した reopenRule を補う値で上書きしない）。行は書き換えない（D76・D83）", () => {
    const { started, rest } = showdownHandEvents("h1");
    // 版 3 の行の reopenRule は、補う値（cumulative_full_raise）ではなく保存した値のまま読む。
    const v3 = [...started, ...rest].map((e) =>
      e.type === "HAND_STARTED"
        ? ({ ...e, reopenRule: "stored_rule" } as unknown as HandEvent)
        : e,
    );
    insertRows("h1", 3, v3);

    expect(
      open()
        .read("h1")
        .map((s) => s.event),
    ).toEqual(v3);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT DISTINCT schema_version FROM events").all(),
      ).toEqual([{ schema_version: 3 }]);
    } finally {
      db.close();
    }
  });

  it("CPU の判断の経緯（AI_ACTION_INVALID / AI_FALLBACK_USED）も現在の版で保存し、再起動後に同じ Event Log を読み出せる", async () => {
    const store = open();
    const orchestrator = new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      // 出力が常に不正な CPU（毎手番 Retry の後に RuleBot で続ける）。
      createOpponent: () => ({ decide: () => Promise.resolve(null) }),
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42,
      nextHandId: () => "hand-1",
    });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    let view: HeroView = started.value.view;
    for (let guard = 0; view.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
      const result = await orchestrator.heroAction(
        "hand-1",
        view.log.at(-1)?.seq ?? -1,
        passive(view),
      );
      if (!result.ok) throw new Error(result.error.message);
      view = result.value;
    }
    orchestrator.close();
    const before = store.read("hand-1").map((s) => s.event);
    const types = new Set(before.map((e) => e.type));
    expect(types.has("AI_ACTION_INVALID")).toBe(true);
    expect(types.has("AI_FALLBACK_USED")).toBe(true);

    expect(
      reopen()
        .read("hand-1")
        .map((s) => s.event),
    ).toEqual(before);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT DISTINCT schema_version FROM events").all(),
      ).toEqual([{ schema_version: EVENT_SCHEMA_VERSION }]);
    } finally {
      db.close();
    }
  });

  it("版 4 の行（CPU の判断の経緯を含む）は変換せずに読む。行は書き換えない（D76・D90）", () => {
    const { started, rest } = showdownHandEvents("h1");
    // 版 4 の Hand: 最初の手番の前に AI_ACTION_INVALID を挟む（以降の seq を 1 つずつずらす）。
    const actor = getLegalActions(foldHandEvents(started))?.playerId;
    if (actor === undefined) throw new Error("手番が無い");
    const v4: HandEvent[] = [
      ...started,
      {
        type: "AI_ACTION_INVALID",
        playerId: actor,
        attempt: 1,
        stage: "schema",
        reason: "不正",
        seq: started.length,
        visibility: { type: "system" },
      },
      ...rest.map((e) => ({ ...e, seq: e.seq + 1 })),
    ];
    insertRows("h1", 4, v4);

    expect(
      open()
        .read("h1")
        .map((s) => s.event),
    ).toEqual(v4);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT DISTINCT schema_version FROM events").all(),
      ).toEqual([{ schema_version: 4 }]);
    } finally {
      db.close();
    }
  });

  it("Hero の宣言・Chip の操作・Dealer の裁定（PLAYER_DECLARED / PHYSICAL_CHIP_ACTION / DEALER_RULING）も現在の版で保存し、再起動後に同じ Event Log を読み出せる（D90）", async () => {
    const store = open();
    const orchestrator = new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      createOpponent: createRuleBot,
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42,
      nextHandId: () => "hand-1",
    });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    let view: HeroView = started.value.view;
    for (let guard = 0; view.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
      // Hero は Call 額ちょうどの Chip を出す（宣言なし → Call）か、Call 額が 0 なら Check を宣言する。
      const call = view.legalActions?.actions.find((a) => a.type === "call");
      const result = await orchestrator.heroPhysicalAction(
        "hand-1",
        view.log.at(-1)?.seq ?? -1,
        call?.type === "call"
          ? [{ type: "chip_push", chips: chipsFor(call.amount) }]
          : [{ type: "declare", declaration: { kind: "check" } }],
      );
      if (!result.ok) throw new Error(result.error.message);
      view = result.value;
    }
    orchestrator.close();
    const before = store.read("hand-1").map((s) => s.event);
    const types = new Set(before.map((e) => e.type));
    expect(types.has("PLAYER_DECLARED")).toBe(true);
    expect(types.has("PHYSICAL_CHIP_ACTION")).toBe(true);
    expect(types.has("DEALER_RULING")).toBe(true);

    expect(
      reopen()
        .read("hand-1")
        .map((s) => s.event),
    ).toEqual(before);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT DISTINCT schema_version FROM events").all(),
      ).toEqual([{ schema_version: EVENT_SCHEMA_VERSION }]);
    } finally {
      db.close();
    }
  });

  it("Orchestrator で 1 Hand を最後まで進めると、再起動後に同じ Event Log を読み出せる", async () => {
    const store = open();
    const orchestrator = new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      createOpponent: createRuleBot,
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42,
      nextHandId: () => "hand-1",
    });
    const started = await orchestrator.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    let view: HeroView = started.value.view;
    for (let guard = 0; view.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
      const result = await orchestrator.heroAction(
        "hand-1",
        view.log.at(-1)?.seq ?? -1,
        passive(view),
      );
      if (!result.ok) throw new Error(result.error.message);
      view = result.value;
    }
    orchestrator.close();
    const before = store.read("hand-1").map((s) => s.event);
    expect(before.at(-1)?.type).toBe("HAND_FINISHED");
    // Hand ごとの Metadata（#97）も現在の版で一緒に保存する（events のテーブル・列は変えない）。
    expect(before[1]?.type).toBe("HAND_METADATA_RECORDED");

    expect(
      reopen()
        .read("hand-1")
        .map((s) => s.event),
    ).toEqual(before);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db
          .prepare(
            "SELECT type, schema_version FROM events WHERE hand_id = 'hand-1' AND seq = 1",
          )
          .all(),
      ).toEqual([
        {
          type: "HAND_METADATA_RECORDED",
          schema_version: EVENT_SCHEMA_VERSION,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("版 6 の行（Metadata の無い Hand）は変換せずに読み、Metadata を作り直さない。行は書き換えない（D76・#97）", () => {
    const { started, rest } = showdownHandEvents("h1");
    const v6 = [...started, ...rest];
    expect(v6.some((e) => e.type === "HAND_METADATA_RECORDED")).toBe(false);
    insertRows("h1", 6, v6);
    expect(
      open()
        .read("h1")
        .map((s) => s.event),
    ).toEqual(v6);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT DISTINCT schema_version FROM events").all(),
      ).toEqual([{ schema_version: 6 }]);
    } finally {
      db.close();
    }
  });
});

describe("SqliteEventStore（Session の永続化と Resume。#77・D95）", () => {
  /** 6 人卓・RuleBot・待ちなしの Orchestrator（store を共有して作り直すと再起動の代わりになる）。 */
  function orchestratorOn(
    store: SqliteEventStore,
    prefix: string,
    createOpponent: OpponentFactory = createRuleBot,
  ) {
    let handNo = 0;
    let sessionNo = 0;
    return new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      createOpponent,
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42 + handNo,
      nextHandId: () => `${prefix}-hand-${++handNo}`,
      nextSessionId: () => `${prefix}-session-${++sessionNo}`,
    });
  }

  async function playHand(
    orchestrator: HandOrchestrator,
    afterHandId: string | null,
  ): Promise<string> {
    const started = await orchestrator.startHand(afterHandId);
    if (!started.ok) throw new Error(started.error.message);
    let view: HeroView = started.value.view;
    for (let guard = 0; view.status !== "complete"; guard++) {
      expect(guard).toBeLessThan(100);
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

  function sessionOfHand(handId: string): string | undefined {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT session_id FROM hands WHERE hand_id = ?")
        .get(handId) as { session_id: string } | undefined;
      return row?.session_id;
    } finally {
      db.close();
    }
  }

  it("版 5 の行は変換せずに読む。行は書き換えない（D76・D95）", () => {
    const { started, rest } = showdownHandEvents("h1");
    const v5 = [...started, ...rest];
    insertRows("h1", 5, v5);
    expect(
      open()
        .read("h1")
        .map((s) => s.event),
    ).toEqual(v5);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT DISTINCT schema_version FROM events").all(),
      ).toEqual([{ schema_version: 5 }]);
    } finally {
      db.close();
    }
  });

  it("Session Projection を Hand の保存と一緒に書き、開き直しても読める。Event Log から作り直した値と一致する（D37）", async () => {
    const store = open();
    const orchestrator = orchestratorOn(store, "a");
    const first = await playHand(orchestrator, null);
    const second = await playHand(orchestrator, first);
    orchestrator.close();

    const saved = reopen().latestSessionProjection();
    expect(saved).toMatchObject({
      sessionId: "a-session-1",
      lastHandId: second,
      state: "ready_for_next_hand",
      endReason: null,
      personas: PHASE1_TABLE_SETUP.personas,
      emergencyBots: [],
    });
    // Session の Hand を順に畳み込み直すと、保存した Projection と同じになる。
    const reread = reopen();
    const rebuilt = [first, second].reduce<SessionProjection | null>(
      (previous, handId) => {
        const log = reread.read(handId);
        return nextSessionProjection(previous, {
          sessionId: "a-session-1",
          handId,
          events: log.map((s) => s.event),
          personas: PHASE1_TABLE_SETUP.personas,
          recordedAt: log.at(-1)?.recordedAt ?? "",
        });
      },
      null,
    );
    expect(rebuilt).toEqual(saved);
    expect(saved?.stacks).toEqual(
      reread
        .read(second)
        .map((s) => s.event)
        .find((e) => e.type === "HAND_FINISHED")?.stacks,
    );
  });

  it("Session Projection を書けなければ Hand も保存しない（同じトランザクション）", () => {
    open().close();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER projections_fail BEFORE INSERT ON session_projections
        BEGIN SELECT RAISE(ABORT, 'projection failed'); END;
      `);
    } finally {
      db.close();
    }
    const store = open();
    const { started, rest } = finishedHandEvents("h1");
    store.append("h1", started);
    expect(() => store.append("h1", rest)).toThrow(/projection failed/);
    // Hand は途中のまま（メモリ側）で、DB には何も残らない。
    expect(store.read("h1").length).toBe(started.length);
    expect(reopen().read("h1")).toEqual([]);
    expect(reopen().listHands(10)).toEqual([]);
  });

  it("再起動後は Hand の合間の Session を Resume し、途中だった Hand は捨てて最後に終わった Hand から続ける（D62）", async () => {
    const store = open();
    const before = orchestratorOn(store, "a");
    const first = await playHand(before, null);
    // 2 Hand 目は途中（Hero の手番）のまま再起動する。
    const unfinished = await before.startHand(first);
    if (!unfinished.ok) throw new Error(unfinished.error.message);
    expect(unfinished.value.view.status).toBe("in_progress");
    before.close();

    const restarted = reopen();
    expect(restarted.read(unfinished.value.handId)).toEqual([]);
    const after = orchestratorOn(restarted, "b");
    const resumedHand = await playHand(after, unfinished.value.handId);
    after.close();

    expect(sessionOfHand(resumedHand)).toBe("a-session-1");
    const events = restarted.read(resumedHand).map((s) => s.event);
    const opening = events[0];
    const firstFinished = restarted
      .read(first)
      .map((s) => s.event)
      .find((e) => e.type === "HAND_FINISHED");
    if (
      opening?.type !== "HAND_STARTED" ||
      firstFinished?.type !== "HAND_FINISHED"
    ) {
      throw new Error("Hand の開始・終了が無い");
    }
    expect(opening.seats).toEqual(
      firstFinished.stacks.map((s) => ({
        playerId: s.playerId,
        stack: s.amount,
      })),
    );
    expect(events.some((e) => e.type === "SESSION_STARTED")).toBe(false);
    expect(reopen().latestSessionProjection()).toMatchObject({
      sessionId: "a-session-1",
      lastHandId: resumedHand,
    });
  });

  it("AI 障害で打ち切った Hand は保存され、再起動後も一覧に aborted で残り、Session は続けない", async () => {
    let down = true;
    const brokenOnce: OpponentFactory = (seed, playerId, persona) => {
      const bot = createRuleBot(seed, playerId, persona);
      return {
        decide: (input, signal) => {
          if (down) {
            down = false;
            return Promise.reject(new Error("down"));
          }
          return bot.decide(input, signal);
        },
      };
    };
    const store = open();
    const before = orchestratorOn(store, "a", brokenOnce);
    const started = await before.startHand(null);
    if (!started.ok) throw new Error(started.error.message);
    const handId = started.value.handId;
    expect((await before.resolveOutage(handId, 1, "end_session")).ok).toBe(
      true,
    );
    before.close();

    const restarted = reopen();
    expect(restarted.listHands(10)).toMatchObject([
      { handId, finishedAt: null, aborted: true },
    ]);
    expect(
      restarted
        .read(handId)
        .slice(-2)
        .map((s) => s.event.type),
    ).toEqual(["HAND_ABORTED", "SESSION_ENDED"]);
    expect(restarted.latestSessionProjection()).toMatchObject({
      sessionId: "a-session-1",
      state: "ended",
      endReason: "ai_outage",
    });
    const after = orchestratorOn(restarted, "b");
    const next = await playHand(after, null);
    after.close();
    expect(sessionOfHand(next)).toBe("b-session-1");
  });
});

/** 現在の Event を版 2 の形（HAND_STARTED に reopenRule が無い）に戻す。版 4〜7 で足した種類は版 2 に無いので渡さない。 */
function toV2(events: readonly HandEvent[]): HandEventV2[] {
  return events.map((e): HandEventV2 => {
    if (
      e.type === "AI_ACTION_INVALID" ||
      e.type === "AI_FALLBACK_USED" ||
      e.type === "PLAYER_DECLARED" ||
      e.type === "PHYSICAL_CHIP_ACTION" ||
      e.type === "DEALER_RULING" ||
      e.type === "SESSION_STARTED" ||
      e.type === "SESSION_ENDED" ||
      e.type === "HAND_ABORTED" ||
      e.type === "EMERGENCY_BOT_ENGAGED" ||
      e.type === "HAND_METADATA_RECORDED"
    ) {
      throw new Error(`版 2 に無い Event: ${e.type}`);
    }
    if (e.type !== "HAND_STARTED") return e;
    const v2: Record<string, unknown> = { ...e };
    delete v2.reopenRule;
    return v2 as HandEventV2;
  });
}

/** 額ちょうどの Chip の額面の列（大きい額面から）。 */
function chipsFor(amount: number): number[] {
  return composeChips(amount).flatMap((c) =>
    Array.from({ length: c.count }, () => c.denomination.value),
  );
}

/** Call できれば Call、できなければ Check、どちらも無ければ Fold。 */
function passive(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}
