// Opponent Memory Reset（#143・D64・D120・docs/04 §11）のテスト。
// - 区切りは追加した時点の ordinals の最大の ord を持ち、Observer に効く最後の区切り（all と自分の cpu_profile のうち ord が大きい方）
//   より後に保存された Hand だけが Observation・Hypothesis・Memory の注入の入力になる（Subject 側の Memory は消さない）
// - 前後は論理順序で決め、壁時計が後ろへ戻っても崩れない（D117・#129・#130）
// - Raw Evidence（Event Log）から Hypothesis を作り直せる（Reset 後の Hand が無ければ空、あれば同じ入力から同じ結果）
// - Event Log・reviews・User Read / Note / Tag（cpu_profile の Subject を含む）・Learning Reset の区切り・Stats・Hero の Score / Profile・
//   Table Tendency・Tilt は変わらない（区切りの表に行が足されるだけ）
// - Guest は Session 限りで次の Session では読まないので、Reset に追加の後始末は要らない
// - Hand Orchestrator は Hand の開始時に、その CPU に効く区切りより後の Hand だけで Memory を作る
import {
  applyAction,
  getLegalActions,
  PHASE1_CASH_PRESET,
  projectPlayerStats,
  recordSessionEvent,
  startHand,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { openDatabase } from "../db/database.js";
import { InMemoryEventStore, type EventStore } from "../event-store.js";
import { HandOrchestrator } from "../hand-orchestrator.js";
import { InMemoryHypothesisSnapshotStore } from "../learning/hypothesis-snapshot.js";
import { SqliteLearningResetStore } from "../learning/learning-reset.js";
import { LearningService } from "../learning/learning-service.js";
import { createOrdinalCounter, type OrdinalCounter } from "../logical-order.js";
import { SqliteNoteStore } from "../notes/note-store.js";
import type { SessionParticipant } from "../opponents/cpu-pool.js";
import type { OpponentFactory } from "../opponents/opponent-agent.js";
import { PERSONA_PRESETS } from "../opponents/persona.js";
import { createRuleBot } from "../opponents/rule-bot.js";
import { buildTiltsFromStore } from "../opponents/tilt.js";
import { SqliteReviewStore } from "../review/review-store.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import {
  InMemoryOpponentMemoryResetStore,
  SqliteOpponentMemoryResetStore,
  type OpponentMemoryResetStore,
} from "./memory-reset.js";
import {
  buildOpponentMemoriesFromStore,
  type MemoryTableSeat,
  type OpponentMemorySummary,
} from "./memory-summary.js";
import {
  extractObservedHands,
  loadObservationSources,
  type ObserverRef,
} from "./observation.js";
import {
  buildOpponentHypotheses,
  buildOpponentHypothesesFromStore,
} from "./opponent-hypothesis.js";
import { buildCpuTableTendenciesFromStore } from "./table-tendency.js";

const HERO = "hero";
const POOL = "phase7_pool_v1";
const AKI = { kind: "cpu_profile", cpuProfileId: "fixed_aki" } as const;
const BEN = { kind: "cpu_profile", cpuProfileId: "fixed_ben" } as const;

function fixed(playerId: string, cpuProfileId: string): SessionParticipant {
  return { playerId, kind: "fixed", cpuProfileId, poolVersion: POOL };
}

function guest(playerId: string, guestId: string): SessionParticipant {
  return { playerId, kind: "guest", guestId, poolVersion: POOL };
}

/** 呼ぶたびに 1 分ずつ戻る時計（OS の時刻の巻き戻りの再現。後に記録したものほど時刻が古い）。 */
function backwardsClock(): () => Date {
  let t = Date.parse("2026-10-08T12:00:00.000Z");
  return () => {
    t -= 60_000;
    return new Date(t);
  };
}

/** 1 Hand を Showdown まで進めた Event（全員が Call / Check）。最初の Hand には SESSION_STARTED を入れる。 */
function playHand(
  handId: string,
  seats: readonly string[],
  sessionStartedId?: string,
): HandEvent[] {
  const started = startHand({
    handId,
    seats: seats.map((playerId) => ({ playerId, stack: 200 })),
    buttonPlayerId: seats[0] as string,
    config: PHASE1_CASH_PRESET,
    deal: { seed: 11 },
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

/** Session の Hand を保存する（最初の Hand で参加者を渡す）。 */
function saveHands(
  store: EventStore,
  sessionId: string,
  handIds: readonly string[],
  seats: readonly string[],
  participants: readonly SessionParticipant[],
  first: boolean,
): void {
  handIds.forEach((handId, i) => {
    const isFirst = first && i === 0;
    store.append(
      handId,
      playHand(handId, seats, isFirst ? sessionId : undefined),
      isFirst ? { sessionId, participants } : { sessionId },
    );
  });
}

const S1_SEATS = ["cpu2", HERO, "cpu1"] as const;
const S1_PARTICIPANTS = [
  fixed("cpu1", "fixed_aki"),
  fixed("cpu2", "fixed_ben"),
];
const S1_TABLE: readonly MemoryTableSeat[] = [
  { playerId: "cpu1", participant: AKI },
  { playerId: "cpu2", participant: BEN },
  { playerId: HERO, participant: { kind: "hero" } },
];

/** Event Store と Reset Store を同じ順序の源で作る（メモリ内は同じカウンタ、SQLite は同じ DB）。 */
function stores(
  sqlite: boolean,
  now?: () => Date,
): {
  events: EventStore;
  resets: OpponentMemoryResetStore;
  db: DatabaseSync | null;
  ordinals: OrdinalCounter | null;
} {
  if (sqlite) {
    const db = openDatabase(":memory:");
    return {
      events: new SqliteEventStore(db, now === undefined ? {} : { now }),
      resets: new SqliteOpponentMemoryResetStore(
        db,
        now === undefined ? {} : { now },
      ),
      db,
      ordinals: null,
    };
  }
  const ordinals = createOrdinalCounter();
  return {
    events: new InMemoryEventStore(
      now === undefined ? { ordinals } : { ordinals, now },
    ),
    resets: new InMemoryOpponentMemoryResetStore(
      now === undefined ? { ordinals } : { ordinals, now },
    ),
    db: null,
    ordinals,
  };
}

/** 今の Session（s1）の Aki・Ben の Memory を、それぞれに効く区切りの後の Hand だけで作る。 */
function memories(
  events: EventStore,
  resets: OpponentMemoryResetStore,
  currentSessionId = "s1",
): Map<string, OpponentMemorySummary> {
  return buildOpponentMemoriesFromStore(events, {
    heroPlayerId: HERO,
    currentSessionId,
    seats: S1_TABLE,
    observers: [
      {
        playerId: "cpu1",
        observer: AKI,
        observerSkill: 0.5,
        afterOrd: resets.boundaryFor(AKI)?.ord ?? null,
      },
      {
        playerId: "cpu2",
        observer: BEN,
        observerSkill: 0.5,
        afterOrd: resets.boundaryFor(BEN)?.ord ?? null,
      },
    ],
  });
}

/** Memory の全 Evidence の Hand。 */
function evidenceHands(memory: OpponentMemorySummary | undefined): string[] {
  return [
    ...new Set(
      (memory?.subjects ?? []).flatMap((s) =>
        s.items.flatMap((i) =>
          i.evidenceIds.map((id) => id.split("#")[0] ?? ""),
        ),
      ),
    ),
  ].sort();
}

function observed(memory: OpponentMemorySummary | undefined): number[] {
  return (memory?.subjects ?? []).map((s) => s.handsObserved);
}

describe("OpponentMemoryResetStore", () => {
  it.each([false, true])(
    "区切りは追加した時点の最大の ord（Hand が 0 件なら 0）で、Fixed CPU には all と自分の cpu_profile のうち ord が大きい方、Guest には all だけが効く（sqlite=%s）",
    (sqlite) => {
      const { events, resets } = stores(sqlite);
      const guestRef: ObserverRef = { kind: "guest", guestId: "guest/s1/cpu3" };
      expect(resets.boundaryFor(AKI)).toBeNull();
      expect(resets.boundaryFor(guestRef)).toBeNull();

      const empty = resets.add({ scope: "all" });
      expect(empty).toMatchObject({ scope: "all", cpuProfileId: null });
      expect(resets.boundaryFor(AKI)?.ord).toBe(0);
      expect(resets.boundaryFor(guestRef)?.ord).toBe(0);

      saveHands(events, "s1", ["h1", "h2"], S1_SEATS, S1_PARTICIPANTS, true);
      const h2 = events.savedOrder("h2") ?? -1;
      const aki = resets.add({
        scope: "cpu_profile",
        cpuProfileId: "fixed_aki",
      });
      expect(aki).toMatchObject({
        scope: "cpu_profile",
        cpuProfileId: "fixed_aki",
      });
      expect(resets.boundaryFor(AKI)).toEqual({
        ord: h2,
        createdAt: aki.createdAt,
      });
      // Ben・Guest には Aki の区切りは効かない（all の区切りのまま）。
      expect(resets.boundaryFor(BEN)?.ord).toBe(0);
      expect(resets.boundaryFor(guestRef)?.ord).toBe(0);

      saveHands(events, "s1", ["h3"], S1_SEATS, S1_PARTICIPANTS, false);
      const h3 = events.savedOrder("h3") ?? -1;
      const all = resets.add({ scope: "all" });
      expect(resets.boundaryFor(AKI)).toEqual({
        ord: h3,
        createdAt: all.createdAt,
      });
      expect(resets.boundaryFor(BEN)?.ord).toBe(h3);
      expect(resets.boundaryFor(guestRef)?.ord).toBe(h3);
      // Hand を挟まない次の区切り（同じ ord）は追加の順で後の行。
      const again = resets.add({
        scope: "cpu_profile",
        cpuProfileId: "fixed_aki",
      });
      expect(resets.boundaryFor(AKI)).toEqual({
        ord: h3,
        createdAt: again.createdAt,
      });
    },
  );

  it.each([false, true])(
    "空の cpuProfileId は受け付けず、何も足さない（sqlite=%s）",
    (sqlite) => {
      const { resets } = stores(sqlite);
      expect(() =>
        resets.add({ scope: "cpu_profile", cpuProfileId: "" }),
      ).toThrow(RangeError);
      expect(resets.boundaryFor(AKI)).toBeNull();
    },
  );
});

describe("Reset の後の Memory（Observation・Hypothesis・注入）", () => {
  it.each([false, true])(
    "1 つの Fixed CPU の Reset は Observer としてのその CPU の Memory だけを区切り、Subject 側（他の CPU が持つ Memory）は消さない。all は全員を区切る（sqlite=%s）",
    (sqlite) => {
      const { events, resets } = stores(sqlite);
      saveHands(events, "s1", ["h1", "h2"], S1_SEATS, S1_PARTICIPANTS, true);
      const before = memories(events, resets);
      expect(observed(before.get("cpu1"))).toEqual([2, 2]);
      expect(evidenceHands(before.get("cpu1"))).toEqual(["h1", "h2"]);

      resets.add({ scope: "cpu_profile", cpuProfileId: "fixed_aki" });
      const afterAki = memories(events, resets);
      // Aki は Reset より後の Hand をまだ見ていない（初めての相手と同じ）。
      expect(observed(afterAki.get("cpu1"))).toEqual([0, 0]);
      expect(
        afterAki.get("cpu1")?.subjects.every((s) => s.items.length === 0),
      ).toBe(true);
      // Ben の Memory（Aki についての Memory を含む）はそのまま。
      expect(afterAki.get("cpu2")).toEqual(before.get("cpu2"));

      saveHands(events, "s1", ["h3"], S1_SEATS, S1_PARTICIPANTS, false);
      const later = memories(events, resets);
      expect(observed(later.get("cpu1"))).toEqual([1, 1]);
      expect(evidenceHands(later.get("cpu1"))).toEqual(["h3"]);
      expect(observed(later.get("cpu2"))).toEqual([3, 3]);

      resets.add({ scope: "all" });
      const afterAll = memories(events, resets);
      expect(observed(afterAll.get("cpu1"))).toEqual([0, 0]);
      expect(observed(afterAll.get("cpu2"))).toEqual([0, 0]);
    },
  );

  it.each([false, true])(
    "時計が後ろへ戻った状態で Reset しても、前後は保存の順で決まる（D117・#129・#130 の再発防止。sqlite=%s）",
    (sqlite) => {
      // Event の記録時刻も Reset の時刻も、後に記録したものほど古い。
      const { events, resets } = stores(sqlite, backwardsClock());
      saveHands(events, "s1", ["h1", "h2"], S1_SEATS, S1_PARTICIPANTS, true);
      const reset = resets.add({ scope: "all" });
      saveHands(events, "s1", ["h3"], S1_SEATS, S1_PARTICIPANTS, false);
      const h1Time = events.read("h1").at(-1)?.recordedAt ?? "";
      const h3Time = events.read("h3").at(-1)?.recordedAt ?? "";
      // 時刻で比べると、h1 は Reset より後・h3 は Reset より前に見える。
      expect(Date.parse(h1Time)).toBeGreaterThan(Date.parse(reset.createdAt));
      expect(Date.parse(h3Time)).toBeLessThan(Date.parse(reset.createdAt));
      // 論理順序では h1・h2 が Reset 前、h3 が Reset 後。
      const m = memories(events, resets);
      expect(evidenceHands(m.get("cpu1"))).toEqual(["h3"]);
      expect(evidenceHands(m.get("cpu2"))).toEqual(["h3"]);
      expect(observed(m.get("cpu1"))).toEqual([1, 1]);
    },
  );

  it.each([false, true])(
    "Raw Evidence から作り直せる: Reset 後の Hand が無ければ空、あれば同じ入力から同じ Hypothesis。区切りの前の Hypothesis も Event Log から作れる（sqlite=%s）",
    (sqlite) => {
      const { events, resets } = stores(sqlite);
      saveHands(events, "s1", ["h1", "h2"], S1_SEATS, S1_PARTICIPANTS, true);
      const query = (afterOrd: number | null) => ({
        observer: AKI,
        heroPlayerId: HERO,
        currentSessionId: "s1",
        afterOrd,
      });
      const hypotheses = (afterOrd: number | null) =>
        buildOpponentHypothesesFromStore(events, query(afterOrd), {
          observerSkill: 0.5,
        });
      const full = hypotheses(null);
      expect(full.length).toBeGreaterThan(0);

      resets.add({ scope: "cpu_profile", cpuProfileId: "fixed_aki" });
      const boundary = resets.boundaryFor(AKI)?.ord ?? null;
      expect(hypotheses(boundary)).toEqual([]);

      saveHands(events, "s1", ["h3", "h4"], S1_SEATS, S1_PARTICIPANTS, false);
      const rebuilt = hypotheses(boundary);
      expect(rebuilt.length).toBeGreaterThan(0);
      expect(hypotheses(boundary)).toEqual(rebuilt);
      // 区切りより後の Raw Evidence（保存済みの Hand）だけを入力にした計算と一致する。
      const after = loadObservationSources(events, query(null)).filter(
        (s) => s.ord > (boundary ?? 0),
      );
      expect(after.map((s) => s.handId)).toEqual(["h3", "h4"]);
      expect(
        buildOpponentHypotheses(extractObservedHands(after, query(null)), {
          observer: AKI,
          observerSkill: 0.5,
        }),
      ).toEqual(rebuilt);
      for (const h of rebuilt) {
        for (const t of h.tendencies) {
          for (const e of t.evidence) {
            expect(["h3", "h4"]).toContain(e.handId);
          }
        }
      }
      // Event Log は消していないので、区切りを外せば前の Hand を含めた Hypothesis も作り直せる。
      expect(hypotheses(null).map((h) => h.handsObserved)).toEqual(
        full.map((h) => h.handsObserved + 2),
      );
    },
  );

  it("extractObservedHands は区切り（afterOrd）以前の Hand を入力の並びに依らず外す", () => {
    const { events } = stores(false);
    saveHands(
      events,
      "s1",
      ["h1", "h2", "h3"],
      S1_SEATS,
      S1_PARTICIPANTS,
      true,
    );
    const q = { observer: AKI, heroPlayerId: HERO, currentSessionId: "s1" };
    const sources = loadObservationSources(events, q);
    const h2 = events.savedOrder("h2") ?? -1;
    expect(
      extractObservedHands([...sources].reverse(), { ...q, afterOrd: h2 }).map(
        (h) => h.handId,
      ),
    ).toEqual(["h3"]);
  });
});

describe("Guest（Session 限り）", () => {
  it.each([false, true])(
    "前の Session の Guest は Reset が無くても次の Session で読まず、Reset に後始末は要らない。all の区切りは今の Session の Guest にも効く（sqlite=%s）",
    (sqlite) => {
      const { events, resets } = stores(sqlite);
      saveHands(
        events,
        "s1",
        ["s1h1", "s1h2"],
        ["cpu2", HERO, "cpu1", "cpu3"],
        [...S1_PARTICIPANTS, guest("cpu3", "guest/s1/cpu3")],
        true,
      );
      saveHands(
        events,
        "s2",
        ["s2h1"],
        ["cpu2", HERO, "cpu1", "cpu3"],
        [...S1_PARTICIPANTS, guest("cpu3", "guest/s2/cpu3")],
        true,
      );
      const s2Guest: ObserverRef = { kind: "guest", guestId: "guest/s2/cpu3" };
      const build = () =>
        buildOpponentMemoriesFromStore(events, {
          heroPlayerId: HERO,
          currentSessionId: "s2",
          seats: [...S1_TABLE, { playerId: "cpu3", participant: s2Guest }],
          observers: [
            {
              playerId: "cpu1",
              observer: AKI,
              observerSkill: 0.5,
              afterOrd: resets.boundaryFor(AKI)?.ord ?? null,
            },
            {
              playerId: "cpu3",
              observer: s2Guest,
              observerSkill: 0.5,
              afterOrd: resets.boundaryFor(s2Guest)?.ord ?? null,
            },
          ],
        });
      const before = build();
      // Reset の前から、前の Session の Guest は Subject にも Evidence にも出ず、今の Guest は今の Session だけを見る。
      for (const m of before.values()) {
        expect(JSON.stringify(m)).not.toContain("guest/s1/cpu3");
      }
      expect(evidenceHands(before.get("cpu3"))).toEqual(["s2h1"]);

      // Fixed CPU の Reset は Guest の Memory を変えない。
      resets.add({ scope: "cpu_profile", cpuProfileId: "fixed_aki" });
      expect(build().get("cpu3")).toEqual(before.get("cpu3"));
      // all は今の Session の Guest も区切る。
      resets.add({ scope: "all" });
      expect(observed(build().get("cpu3"))).toEqual([0, 0, 0]);
    },
  );
});

describe("カテゴリの分離（SQLite）: Opponent Memory Reset は区切りの行を足すだけ", () => {
  let db: DatabaseSync | null = null;
  afterEach(() => {
    db?.close();
    db = null;
  });

  /** opponent_memory_resets 以外の全テーブルの全行。 */
  function otherRows(d: DatabaseSync): Record<string, unknown[]> {
    const tables = d
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'opponent_memory_resets' ORDER BY name",
      )
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map((t) => [t.name, d.prepare(`SELECT * FROM "${t.name}"`).all()]),
    );
  }

  it("Event Log・reviews・User Read / Note / Tag・Learning Reset の区切り・Stats・Score / Profile・Table Tendency・Tilt は変わらない", () => {
    db = openDatabase(":memory:");
    const events = new SqliteEventStore(db);
    const notes = new SqliteNoteStore(db);
    const learningResets = new SqliteLearningResetStore(db);
    const memoryResets = new SqliteOpponentMemoryResetStore(db);
    const learning = new LearningService({
      events,
      reviews: new SqliteReviewStore(db),
      heroId: HERO,
      hypotheses: new InMemoryHypothesisSnapshotStore(),
      resets: learningResets,
    });
    saveHands(events, "s1", ["h1", "h2"], S1_SEATS, S1_PARTICIPANTS, true);
    learningResets.add(["score"]);
    saveHands(events, "s1", ["h3"], S1_SEATS, S1_PARTICIPANTS, false);
    // Hero の Note / Tag（Fixed CPU の Subject と Session の席の Subject）。
    notes.addNote(AKI, "よく Bluff する");
    notes.addTag(AKI, "LAG");
    notes.addTag(
      { kind: "session_player", sessionId: "s1", playerId: "cpu2" },
      "Nit",
    );

    const derived = () => ({
      learningBoundaries: learningResets.boundaries(),
      stats: projectPlayerStats(
        events
          .finishedHandIds()
          .map((id) => events.read(id).map((s) => s.event)),
      ),
      profile: learning.profile(),
      tableTendency: [
        ...buildCpuTableTendenciesFromStore(events, {
          sessionId: "s1",
          playerIds: ["cpu1", "cpu2"],
        }).entries(),
      ],
      tilt: [
        ...buildTiltsFromStore(events, {
          sessionId: "s1",
          seats: [
            { playerId: "cpu1", traits: PERSONA_PRESETS.lag.traits },
            { playerId: "cpu2", traits: PERSONA_PRESETS.nit.traits },
          ],
        }).entries(),
      ],
      notes: notes.notesOf(AKI),
    });
    const before = derived();
    const rows = otherRows(db);
    const memoryBefore = memories(events, memoryResets);

    memoryResets.add({ scope: "all" });
    memoryResets.add({ scope: "cpu_profile", cpuProfileId: "fixed_aki" });

    // 区切りの表以外の行は 1 行も変わらない（正本・Note / Tag・learning_resets・ordinals・session_participants 等）。
    expect(otherRows(db)).toEqual(rows);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM opponent_memory_resets").get(),
    ).toEqual({ n: 2 });
    // 削除拒否の Trigger も残る。
    expect(() => db?.exec("DELETE FROM events")).toThrow(/append-only/);
    expect(() => db?.exec("DELETE FROM user_tags")).toThrow(/append-only/);
    // 派生の値も変わらない（Hero の Score / Profile・Stats・Table Tendency・Tilt・Note / Tag）。
    expect(derived()).toEqual(before);
    expect(before.notes).toMatchObject({
      notes: [{ body: "よく Bluff する" }],
      tags: ["LAG"],
    });
    // 変わるのは CPU の Memory だけ。
    expect(observed(memoryBefore.get("cpu1"))).toEqual([3, 3]);
    expect(observed(memories(events, memoryResets).get("cpu1"))).toEqual([
      0, 0,
    ]);
  });
});

describe("Hand Orchestrator の Memory の注入", () => {
  /** CPU の判断の入力の Memory を Hand ごとに記録する RuleBot。 */
  function recordingFactory(
    seen: Map<string, Map<string, OpponentMemorySummary | undefined>>,
  ): OpponentFactory {
    return (seed, playerId, persona) => {
      const bot = createRuleBot(seed, playerId, persona);
      return {
        decide: (input, signal) => {
          const byCpu =
            seen.get(input.knowledge.handId) ??
            new Map<string, OpponentMemorySummary | undefined>();
          byCpu.set(playerId, input.knowledge.memory);
          seen.set(input.knowledge.handId, byCpu);
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

  it("Reset の後の Hand は、その時点の区切りより後に保存された Hand だけで Memory を作る", async () => {
    const ordinals = createOrdinalCounter();
    const store = new InMemoryEventStore({ ordinals });
    const resets = new InMemoryOpponentMemoryResetStore({ ordinals });
    const seen = new Map<
      string,
      Map<string, OpponentMemorySummary | undefined>
    >();
    let handNo = 0;
    const orchestrator = new HandOrchestrator({
      store,
      setup: PHASE1_TABLE_SETUP,
      createOpponent: recordingFactory(seen),
      botDelayMs: 0,
      opponentTimeoutMs: 1000,
      nextSeed: () => 42,
      nextHandId: () => `hand-${++handNo}`,
      nextSessionId: () => "session-1",
      memoryResets: resets,
    });
    try {
      let previous: string | null = null;
      const play = async (): Promise<string> => {
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
        return handId;
      };
      const maxObserved = (handId: string) =>
        Math.max(
          ...[...(seen.get(handId)?.values() ?? [])].flatMap((m) =>
            observed(m),
          ),
        );
      const evidenceOf = (handId: string) =>
        [...(seen.get(handId)?.values() ?? [])].flatMap(evidenceHands);

      await play();
      const h2 = await play();
      // Reset 前は前の Hand を覚えている。
      expect(maxObserved(h2)).toBe(1);

      resets.add({ scope: "all" });
      const h3 = await play();
      // Reset の後の最初の Hand: どの CPU も前の Hand を覚えていない。
      expect(seen.get(h3)?.size ?? 0).toBeGreaterThan(0);
      expect(maxObserved(h3)).toBe(0);
      expect(evidenceOf(h3)).toEqual([]);
      const h4 = await play();
      // 次の Hand: Reset の後に保存した h3 だけ。
      expect(maxObserved(h4)).toBe(1);
      expect(new Set(evidenceOf(h4))).toEqual(new Set([h3]));
    } finally {
      orchestrator.close();
    }
  });
});
