// CPU Memory の Observation の Cache（D124・#165・docs/04 §6・§12）のテスト。
// - Cache あり（初回・温まった状態）/ なし / 全部消した後 / メモリ内の Event Store で、観察・Memory（注入の要約まで）が同じ
// - 抽出の Version が違う行は読まず、消して作り直す。形の合わない行は作り直す
// - Opponent Memory Reset（D120）・Guest（D118）・Observer が座っていない Hand・参加者の無い Session の扱いが Cache 前と同じ
// - 時計が後ろへ戻った記録でも同じ（D117）
// - Cache の読み書きに失敗しても結果を変えず、warn に残す
// - Hand Orchestrator は Cache を使っても、使わないときと同じ Memory を CPU に渡す
import {
  applyAction,
  getLegalActions,
  PHASE1_CASH_PRESET,
  recordSessionEvent,
  startHand,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { openDatabase } from "../db/database.js";
import { InMemoryEventStore, type EventStore } from "../event-store.js";
import { HandOrchestrator } from "../hand-orchestrator.js";
import { createOrdinalCounter } from "../logical-order.js";
import type { SessionParticipant } from "../opponents/cpu-pool.js";
import type { OpponentFactory } from "../opponents/opponent-agent.js";
import { createRuleBot } from "../opponents/rule-bot.js";
import {
  EVENT_SCHEMA_VERSION,
  SqliteEventStore,
} from "../sqlite-event-store.js";
import {
  SqliteOpponentMemoryResetStore,
  type OpponentMemoryResetStore,
} from "./memory-reset.js";
import {
  buildOpponentMemoriesFromStore,
  type MemoryTableSeat,
  type OpponentMemorySummary,
} from "./memory-summary.js";
import {
  OBSERVATION_CACHE_VERSION,
  OBSERVATION_EXTRACTION_VERSION,
  ObservationCacheReader,
  SqliteObservationCache,
  type ObservationCacheLogger,
  type ObservationCacheStore,
} from "./observation-cache.js";
import {
  extractObservedHandsFromStore,
  type ObservationQuery,
  type ObserverRef,
} from "./observation.js";

const HERO = "hero";
const POOL = "phase7_pool_v1";
const AKI = { kind: "cpu_profile", cpuProfileId: "fixed_aki" } as const;
const BEN = { kind: "cpu_profile", cpuProfileId: "fixed_ben" } as const;
const S1_GUEST: ObserverRef = { kind: "guest", guestId: "guest/s1/cpu3" };
const S2_GUEST: ObserverRef = { kind: "guest", guestId: "guest/s2/cpu3" };

function fixed(playerId: string, cpuProfileId: string): SessionParticipant {
  return { playerId, kind: "fixed", cpuProfileId, poolVersion: POOL };
}

function guest(playerId: string, guestId: string): SessionParticipant {
  return { playerId, kind: "guest", guestId, poolVersion: POOL };
}

/** 呼ぶたびに 1 分ずつ戻る時計（OS の時刻の巻き戻りの再現）。 */
function backwardsClock(): () => Date {
  let t = Date.parse("2026-10-08T12:00:00.000Z");
  return () => {
    t -= 60_000;
    return new Date(t);
  };
}

/** 1 Hand を終わりまで進めた Event（Call できれば Call、できなければ Check）。最初の Hand には SESSION_STARTED を入れる。 */
function playHand(
  handId: string,
  seats: readonly string[],
  seed: number,
  sessionStartedId?: string,
): HandEvent[] {
  const started = startHand({
    handId,
    seats: seats.map((playerId) => ({ playerId, stack: 200 })),
    buttonPlayerId: seats[0] as string,
    config: PHASE1_CASH_PRESET,
    deal: { seed },
    metadata: {
      appVersion: "0.0.0-test",
      cpuProfileVersion: "cpu-profile-test",
      cpuSeats: seats
        .filter((p) => p !== HERO)
        .map((playerId) => ({
          playerId,
          provider: "rule_bot",
          modelRole: null,
          model: null,
        })),
    },
  });
  if (!started.ok) throw new Error(started.error.message);
  const events: HandEvent[] = [...started.value.events];
  let state = started.value.state;
  if (sessionStartedId !== undefined) {
    const s = recordSessionEvent(state, {
      type: "SESSION_STARTED",
      sessionId: sessionStartedId,
    });
    state = s.state;
    events.push(...s.events);
  }
  for (let step = 0; state.status !== "complete"; step++) {
    const legal = getLegalActions(state);
    if (legal === null || step > 60) throw new Error("Hand が進まない");
    const types = legal.actions.map((a) => a.type);
    const action: PlayerAction = types.includes("call")
      ? { type: "call" }
      : { type: "check" };
    const result = applyAction(state, legal.playerId, action);
    if (!result.ok) throw new Error(result.error.message);
    state = result.value.state;
    events.push(...result.value.events);
  }
  return events;
}

/** Session の Hand を保存する（最初の Hand で参加者を渡す。participants が null の Session は参加者の行を作らない）。 */
function saveSession(
  store: EventStore,
  sessionId: string,
  hands: readonly { handId: string; seats: readonly string[] }[],
  participants: readonly SessionParticipant[] | null,
): void {
  hands.forEach(({ handId, seats }, i) => {
    const first = i === 0;
    store.append(
      handId,
      playHand(handId, seats, 11 + i, first ? sessionId : undefined),
      first && participants !== null
        ? { sessionId, participants }
        : { sessionId },
    );
  });
}

const FOUR = ["cpu2", HERO, "cpu1", "cpu3"] as const;

/** s1: Aki・Ben・Guest（s1）。s1h3 は Aki が座っていない（Bust の後）。 */
function saveS1(store: EventStore): void {
  saveSession(
    store,
    "s1",
    [
      { handId: "s1h1", seats: FOUR },
      { handId: "s1h2", seats: ["cpu3", "cpu2", HERO, "cpu1"] },
      { handId: "s1h3", seats: ["cpu2", HERO, "cpu3"] },
    ],
    [
      fixed("cpu1", "fixed_aki"),
      fixed("cpu2", "fixed_ben"),
      guest("cpu3", "guest/s1/cpu3"),
    ],
  );
}

/** sx: 参加者の行の無い Session（v10 より前・Drill の専用の Session と同じ）。s2: Aki・Ben・別の Guest（s2）。 */
function saveRest(store: EventStore): void {
  saveSession(store, "sx", [{ handId: "sxh1", seats: FOUR }], null);
  saveSession(
    store,
    "s2",
    [
      { handId: "s2h1", seats: FOUR },
      { handId: "s2h2", seats: ["cpu1", "cpu3", "cpu2", HERO] },
    ],
    [
      fixed("cpu1", "fixed_aki"),
      fixed("cpu2", "fixed_ben"),
      guest("cpu3", "guest/s2/cpu3"),
    ],
  );
}

function populate(store: EventStore): EventStore {
  saveS1(store);
  saveRest(store);
  return store;
}

function sqliteStore(now?: () => Date): {
  db: DatabaseSync;
  store: SqliteEventStore;
} {
  const db = openDatabase(":memory:");
  return {
    db,
    store: new SqliteEventStore(db, now === undefined ? {} : { now }),
  };
}

/** warn を数える logger。 */
function countingLogger(): ObservationCacheLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    warn: (_obj, msg) => {
      messages.push(msg);
    },
  };
}

const S2_TABLE: readonly MemoryTableSeat[] = [
  { playerId: "cpu1", participant: AKI },
  { playerId: "cpu2", participant: BEN },
  { playerId: HERO, participant: { kind: "hero" } },
  { playerId: "cpu3", participant: S2_GUEST },
];

/** 今の Session（s2）の Aki・Ben・Guest の Memory（Reset の区切りがあれば当てる）。cache を渡したときだけ Cache を使う。 */
function memories(
  store: EventStore,
  cache?: ObservationCacheStore,
  resets?: OpponentMemoryResetStore,
  logger: ObservationCacheLogger = countingLogger(),
): [string, OpponentMemorySummary][] {
  const afterOrd = (o: ObserverRef) => resets?.boundaryFor(o)?.ord ?? null;
  return [
    ...buildOpponentMemoriesFromStore(store, {
      heroPlayerId: HERO,
      currentSessionId: "s2",
      seats: S2_TABLE,
      observers: [
        {
          playerId: "cpu1",
          observer: AKI,
          observerSkill: 0.5,
          afterOrd: afterOrd(AKI),
        },
        {
          playerId: "cpu2",
          observer: BEN,
          observerSkill: 0.25,
          afterOrd: afterOrd(BEN),
        },
        {
          playerId: "cpu3",
          observer: S2_GUEST,
          observerSkill: 0.75,
          afterOrd: afterOrd(S2_GUEST),
        },
      ],
      ...(cache === undefined
        ? {}
        : { observationCache: { store: cache, logger } }),
    }).entries(),
  ];
}

function cacheRows(db: DatabaseSync): {
  observer_key: string;
  hand_id: string;
  extraction_version: string;
  observed: string | null;
}[] {
  return db
    .prepare(
      "SELECT observer_key, hand_id, extraction_version, observed FROM observed_hand_cache ORDER BY observer_key, ord",
    )
    .all() as {
    observer_key: string;
    hand_id: string;
    extraction_version: string;
    observed: string | null;
  }[];
}

/** 観察の抽出の比べる条件（Observer・今の Session・Reset の区切りの組み合わせ）。 */
const QUERIES: readonly ObservationQuery[] = [
  { observer: AKI, heroPlayerId: HERO, currentSessionId: "s2" },
  { observer: AKI, heroPlayerId: HERO, currentSessionId: "s1" },
  { observer: BEN, heroPlayerId: HERO, currentSessionId: "s2", afterOrd: 2 },
  { observer: S1_GUEST, heroPlayerId: HERO, currentSessionId: "s1" },
  { observer: S2_GUEST, heroPlayerId: HERO, currentSessionId: "s2" },
  { observer: S1_GUEST, heroPlayerId: HERO, currentSessionId: "s2" },
];

describe("Cache の有無で結果が同じ", () => {
  it("Cache なし・初回（空から作る）・温まった状態・全部消した後・メモリ内の Event Store で、Memory（注入の要約まで）が同じ", () => {
    const { db, store } = sqliteStore();
    populate(store);
    const cache = new SqliteObservationCache(db);
    const expected = memories(store);
    // 比べる値が空でないこと（空どうしの一致で通らない）。
    expect(
      expected.every(([, m]) => m.subjects.some((s) => s.items.length > 0)),
    ).toBe(true);

    expect(memories(store, cache)).toEqual(expected);
    const filled = cacheRows(db);
    expect(filled.length).toBeGreaterThan(0);
    expect(memories(store, cache)).toEqual(expected);
    // 温まった状態では行を足さない（Cache に無い Hand だけを作る）。
    expect(cacheRows(db)).toEqual(filled);

    db.exec("DELETE FROM observed_hand_cache");
    expect(memories(store, cache)).toEqual(expected);
    expect(cacheRows(db)).toEqual(filled);

    const inMemory = populate(
      new InMemoryEventStore({ ordinals: createOrdinalCounter() }),
    );
    expect(memories(inMemory)).toEqual(expected);
  });

  it("観察の抽出（ObservedHand）が Observer・今の Session・Reset の区切りに依らず Cache なしと同じ（どの順で Cache を温めても）", () => {
    for (const order of [QUERIES, [...QUERIES].reverse()]) {
      const { db, store } = sqliteStore();
      populate(store);
      const cache = new SqliteObservationCache(db);
      for (const q of order) {
        const logger = countingLogger();
        // 1 回目は Cache に無い Hand を作り、2 回目は Cache から読む。
        for (let i = 0; i < 2; i++) {
          expect(
            new ObservationCacheReader(cache, logger).extract(store, q),
          ).toEqual(extractObservedHandsFromStore(store, q));
        }
        expect(logger.messages).toEqual([]);
      }
    }
  });

  it("Hand を足すと、Cache に無い Hand（ord で引く）だけを足し、結果は Cache なしと同じ", () => {
    const { db, store } = sqliteStore();
    saveS1(store);
    const cache = new SqliteObservationCache(db);
    memories(store, cache);
    const before = cacheRows(db);
    saveRest(store);
    expect(memories(store, cache)).toEqual(memories(store));
    const after = cacheRows(db);
    // 既にあった行は変わらず、足されたのは後から保存した Hand の行だけ。
    expect(after).toEqual(expect.arrayContaining(before));
    expect(
      after
        .filter(
          (r) =>
            !before.some(
              (b) =>
                b.observer_key === r.observer_key && b.hand_id === r.hand_id,
            ),
        )
        .every((r) => r.hand_id.startsWith("s2")),
    ).toBe(true);
  });
});

describe("抽出の Version", () => {
  it("表に書く Version は、抽出の規則の Version と Event の版の組", () => {
    expect(OBSERVATION_CACHE_VERSION).toBe(
      `${OBSERVATION_EXTRACTION_VERSION}+event_schema_v${EVENT_SCHEMA_VERSION}`,
    );
  });

  it("Version の違う行は読まず、消して作り直す", () => {
    const { db, store } = sqliteStore();
    populate(store);
    const expected = memories(store);
    memories(store, new SqliteObservationCache(db, { version: "test_a" }));
    // 古い Version の行を、読めば結果が変わる中身（席→参加者が空）に書き換える。
    db.exec(
      "UPDATE observed_hand_cache SET observed = json_set(observed, '$.seats', json('[]')) WHERE observed IS NOT NULL",
    );
    // 陽性の対照: 同じ Version で読めば、書き換えた行がそのまま使われる（検査が空振りしていない）。
    expect(
      memories(store, new SqliteObservationCache(db, { version: "test_a" })),
    ).not.toEqual(expected);

    expect(
      memories(store, new SqliteObservationCache(db, { version: "test_b" })),
    ).toEqual(expected);
    const versions = new Set(cacheRows(db).map((r) => r.extraction_version));
    expect(versions).toEqual(new Set(["test_b"]));
  });

  it("形の合わない行（Event の数と行為者の数が違う・片方だけ NULL）は使わず、Event Log から作り直して置き換える", () => {
    const { db, store } = sqliteStore();
    populate(store);
    const cache = new SqliteObservationCache(db);
    const expected = memories(store, cache);
    const filled = cacheRows(db);
    db.exec(
      "UPDATE observed_hand_cache SET events = '[]' WHERE hand_id = 's2h1'",
    );
    db.exec(
      `UPDATE observed_hand_cache SET observed = '{"seats":[]}' WHERE hand_id = 's1h1'`,
    );
    expect(memories(store, cache)).toEqual(expected);
    expect(cacheRows(db)).toEqual(filled);
  });
});

describe("判定は Event Log 側で行う（Cache 前と同じ）", () => {
  it("Opponent Memory Reset: Cache が温まった後の区切りでも、区切り以前の Hand を使わない", () => {
    const { db, store } = sqliteStore();
    const resets = new SqliteOpponentMemoryResetStore(db);
    const cache = new SqliteObservationCache(db);
    saveS1(store);
    memories(store, cache, resets);
    // s1 の Hand の行が Cache にある状態で、Aki だけを Reset する。
    resets.add({ scope: "cpu_profile", cpuProfileId: "fixed_aki" });
    saveRest(store);
    const withCache = memories(store, cache, resets);
    expect(withCache).toEqual(memories(store, undefined, resets));
    const evidence = (playerId: string) =>
      new Set(
        (withCache.find(([p]) => p === playerId)?.[1].subjects ?? []).flatMap(
          (s) =>
            s.items.flatMap((i) => i.evidenceIds.map((id) => id.split("#")[0])),
        ),
      );
    // Aki は Reset の後の Hand だけ、Ben は Reset 前の Hand も使う（Subject 側の Memory は消さない）。
    expect([...evidence("cpu1")].every((h) => h?.startsWith("s2"))).toBe(true);
    expect([...evidence("cpu2")].some((h) => h?.startsWith("s1"))).toBe(true);
    // Cache の行は消さない（区切りは読むときに当てる）。
    expect(
      cacheRows(db).some(
        (r) =>
          r.observer_key === '["cpu_profile","fixed_aki"]' &&
          r.hand_id === "s1h1",
      ),
    ).toBe(true);
  });

  it("Guest: 前の Session の Guest は、s1 を今として温めた Cache を s2 から読んでも Subject にならない", () => {
    const { db, store } = sqliteStore();
    populate(store);
    const cache = new SqliteObservationCache(db);
    const s1View: ObservationQuery = {
      observer: AKI,
      heroPlayerId: HERO,
      currentSessionId: "s1",
    };
    const warmed = new ObservationCacheReader(cache, countingLogger()).extract(
      store,
      s1View,
    );
    // s1 を今とした観察では s1 の Guest を引く。
    expect(JSON.stringify(warmed)).toContain("guest/s1/cpu3");
    const s2 = memories(store, cache);
    expect(s2).toEqual(memories(store));
    expect(JSON.stringify(s2)).not.toContain("guest/s1/cpu3");
    // 前の Session の Guest（Observer）は、次の Session では何も観察しない。
    expect(
      new ObservationCacheReader(cache, countingLogger()).extract(store, {
        observer: S1_GUEST,
        heroPlayerId: HERO,
        currentSessionId: "s2",
      }),
    ).toEqual([]);
  });

  it("Observer が座っていない Hand は観察せず（読み直さないよう NULL の行を持つ）、参加者の無い Session の Hand は行も作らない", () => {
    const { db, store } = sqliteStore();
    populate(store);
    const cache = new SqliteObservationCache(db);
    const hands = new ObservationCacheReader(cache, countingLogger()).extract(
      store,
      {
        observer: AKI,
        heroPlayerId: HERO,
        currentSessionId: "s2",
      },
    );
    expect(hands.map((h) => h.handId)).toEqual([
      "s1h1",
      "s1h2",
      "s2h1",
      "s2h2",
    ]);
    const aki = cacheRows(db).filter(
      (r) => r.observer_key === '["cpu_profile","fixed_aki"]',
    );
    expect(aki.map((r) => [r.hand_id, r.observed === null])).toEqual([
      ["s1h1", false],
      ["s1h2", false],
      ["s1h3", true],
      ["s2h1", false],
      ["s2h2", false],
    ]);
    expect(cacheRows(db).some((r) => r.hand_id === "sxh1")).toBe(false);
  });
});

describe("論理順序（D117）", () => {
  it("時計が後ろへ戻った記録でも、Cache あり・なしで同じ結果（時計が進む記録とも同じ）", () => {
    const forward = sqliteStore();
    populate(forward.store);
    const expected = memories(forward.store);
    const backward = sqliteStore(backwardsClock());
    populate(backward.store);
    const cache = new SqliteObservationCache(backward.db);
    expect(memories(backward.store, cache)).toEqual(expected);
    expect(memories(backward.store, cache)).toEqual(expected);
    expect(memories(backward.store)).toEqual(expected);
  });
});

describe("Cache の失敗", () => {
  it("読めないときは warn に残し、Event Log から同じ結果を作る", () => {
    const { store } = sqliteStore();
    populate(store);
    const broken: ObservationCacheStore = {
      load: () => {
        throw new Error("load failed");
      },
      save: () => {
        throw new Error("must not be called");
      },
    };
    const logger = countingLogger();
    expect(memories(store, broken, undefined, logger)).toEqual(memories(store));
    expect(logger.messages.length).toBe(3);
    expect(logger.messages.every((m) => m.includes("Cache"))).toBe(true);
  });

  it("書けないときは warn に残し、結果は変えない（次の計算でまた足りない分として作る）", () => {
    const { db, store } = sqliteStore();
    populate(store);
    const real = new SqliteObservationCache(db);
    let saves = 0;
    const readOnly: ObservationCacheStore = {
      load: (key, hero) => real.load(key, hero),
      save: () => {
        saves += 1;
        throw new Error("disk full");
      },
    };
    const logger = countingLogger();
    const expected = memories(store);
    expect(memories(store, readOnly, undefined, logger)).toEqual(expected);
    expect(memories(store, readOnly, undefined, logger)).toEqual(expected);
    expect(saves).toBe(6);
    expect(logger.messages.length).toBe(6);
    expect(cacheRows(db)).toEqual([]);
  });
});

describe("Hand Orchestrator", () => {
  /** CPU の判断の入力の Memory を Hand・CPU ごとに記録する RuleBot。 */
  function recordingFactory(
    seen: Map<string, OpponentMemorySummary | undefined>,
  ): OpponentFactory {
    return (seed, playerId, persona) => {
      const bot = createRuleBot(seed, playerId, persona);
      return {
        decide: (input, signal) => {
          seen.set(
            `${input.knowledge.handId}/${playerId}`,
            input.knowledge.memory,
          );
          return bot.decide(input, signal);
        },
      };
    };
  }

  function passiveHero(view: HeroView): PlayerAction {
    const types = view.legalActions?.actions.map((a) => a.type) ?? [];
    if (types.includes("call")) return { type: "call" };
    if (types.includes("check")) return { type: "check" };
    return { type: "fold" };
  }

  /** 同じ seed で 5 Hand 進め、CPU に渡った Memory を返す。 */
  async function run(withCache: boolean) {
    const db = openDatabase(":memory:");
    const store = new SqliteEventStore(db);
    const seen = new Map<string, OpponentMemorySummary | undefined>();
    let handNo = 0;
    const warnings: string[] = [];
    const orchestrator = new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      createOpponent: recordingFactory(seen),
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42 + handNo,
      nextHandId: () => `hand-${++handNo}`,
      nextSessionId: () => "session-1",
      ...(withCache
        ? { observationCache: new SqliteObservationCache(db) }
        : {}),
      logger: { warn: (_o, msg) => warnings.push(msg), error: () => {} },
    });
    try {
      let previous: string | null = null;
      for (let n = 0; n < 5; n++) {
        const started = await orchestrator.startHand(previous);
        if (!started.ok) throw new Error(started.error.message);
        const { handId } = started.value;
        let view = started.value.view;
        for (let guard = 0; view.status !== "complete"; guard++) {
          if (guard > 100) throw new Error("Hand が終わらない");
          const r = await orchestrator.heroAction(
            handId,
            view.log.at(-1)?.seq ?? -1,
            passiveHero(view),
          );
          if (!r.ok) throw new Error(r.error.message);
          view = r.value;
        }
        previous = handId;
      }
    } finally {
      orchestrator.close();
    }
    const rows = (
      db.prepare("SELECT COUNT(*) AS n FROM observed_hand_cache").get() as {
        n: number;
      }
    ).n;
    db.close();
    return { seen: [...seen.entries()], rows, warnings };
  }

  it("Cache を使っても、使わないときと同じ Memory を CPU に渡し、Hand の開始で足りない Hand を Cache に足す", async () => {
    const without = await run(false);
    const withCache = await run(true);
    expect(withCache.seen).toEqual(without.seen);
    // 後の Hand の Memory は前の Hand を観察している（比べる値が空でない）。
    expect(
      without.seen.some(([, m]) =>
        (m?.subjects ?? []).some((s) => s.handsObserved > 0),
      ),
    ).toBe(true);
    expect(without.rows).toBe(0);
    expect(withCache.rows).toBeGreaterThan(0);
    expect(withCache.warnings.filter((w) => w.includes("Cache"))).toEqual([]);
  });
});
