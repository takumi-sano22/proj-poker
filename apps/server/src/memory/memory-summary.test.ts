// CPU の KnowledgeState に足す Memory の要約（#139・D121）のテスト。上限（Subject ごとに 5 項目・Evidence ID）・並び・
// 十分 / 不十分・cash だけ・別の Observer の拒否・決定論と、Event Store からの計算での Isolation
// （Observer が座っていなかった Hand の Evidence が出ない・Guest の Memory を次の Session へ持ち越さない）を確かめる。
import {
  applyAction,
  getLegalActions,
  PHASE1_CASH_PRESET,
  recordSessionEvent,
  startHand,
  type HandEvent,
  type PlayerAction,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { InMemoryEventStore, type EventStore } from "../event-store.js";
import { createOrdinalCounter } from "../logical-order.js";
import type { SessionParticipant } from "../opponents/cpu-pool.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { PHASE7_MEMORY_V1, type HypothesisItemId } from "./memory-policy.js";
import {
  buildOpponentMemoriesFromStore,
  PHASE7_MEMORY_INJECTION_V1,
  summarizeOpponentMemory,
  type MemoryTableSeat,
  type OpponentMemorySummary,
} from "./memory-summary.js";
import type { ParticipantRef } from "./observation.js";
import type {
  OpponentHypothesis,
  TendencyEstimate,
} from "./opponent-hypothesis.js";

const HERO = "hero";
const POOL = "phase7_pool_v1";
const AKI = { kind: "cpu_profile", cpuProfileId: "fixed_aki" } as const;
const BEN = { kind: "cpu_profile", cpuProfileId: "fixed_ben" } as const;
const CHIKA = { kind: "cpu_profile", cpuProfileId: "fixed_chika" } as const;
const V1 = PHASE7_MEMORY_V1.version;

function fixed(playerId: string, cpuProfileId: string): SessionParticipant {
  return { playerId, kind: "fixed", cpuProfileId, poolVersion: POOL };
}

function guest(playerId: string, guestId: string): SessionParticipant {
  return { playerId, kind: "guest", guestId, poolVersion: POOL };
}

function tendency(
  item: HypothesisItemId,
  denominator: number,
  evidence: number,
  sufficient = false,
): TendencyEstimate {
  return {
    item,
    policyVersion: V1,
    numerator: denominator / 2,
    denominator,
    opportunities: Math.ceil(denominator),
    sufficient,
    evidence: Array.from({ length: evidence }, (_, i) => ({
      handId: `h${i + 1}`,
      seq: 10 + i,
      ord: i + 1,
    })),
  };
}

function hypothesis(
  subject: ParticipantRef,
  tendencies: readonly TendencyEstimate[],
  overrides: Partial<OpponentHypothesis> = {},
): OpponentHypothesis {
  return {
    observer: AKI,
    subject,
    context: "cash",
    policyVersion: V1,
    handsObserved: 9,
    lastOrd: 9,
    tendencies,
    ...overrides,
  };
}

const TABLE: readonly MemoryTableSeat[] = [
  { playerId: "cpu2", participant: BEN },
  { playerId: HERO, participant: { kind: "hero" } },
  { playerId: "cpu1", participant: AKI },
  { playerId: "cpu3", participant: null },
];

describe("summarizeOpponentMemory", () => {
  it("今の卓の席順で、Observer 自身と誰か引けない席を除き、見たことの無い相手は 0 Hand・項目なしで並べる", () => {
    const memory = summarizeOpponentMemory(
      [hypothesis({ kind: "hero" }, [tendency("vpip", 4, 2)])],
      { observer: AKI, policyVersion: V1, seats: TABLE },
    );
    expect(memory.policyVersion).toBe(V1);
    expect(memory.injectionVersion).toBe("phase7_memory_injection_v1");
    expect(memory.context).toBe("cash");
    expect(memory.subjects.map((s) => s.playerId)).toEqual(["cpu2", HERO]);
    expect(memory.subjects[0]).toEqual({
      playerId: "cpu2",
      subject: BEN,
      handsObserved: 0,
      items: [],
    });
    expect(memory.subjects[1]?.subject).toEqual({ kind: "hero" });
    expect(memory.subjects[1]?.handsObserved).toBe(9);
  });

  it("項目は機会のあるものを重み付きの機会の多い順（同じなら Policy の順）に 5 つまで、Evidence ID は新しい 3 件まで", () => {
    const memory = summarizeOpponentMemory(
      [
        hypothesis({ kind: "hero" }, [
          tendency("vpip", 3, 3),
          tendency("pfr", 8, 1, true),
          tendency("three_bet", 0, 0),
          tendency("fold_to_three_bet", 3, 1),
          tendency("cbet_flop", 1.25, 5),
          tendency("fold_to_cbet_flop", 2, 1),
          tendency("aggression_frequency", 6, 2),
        ]),
      ],
      { observer: AKI, policyVersion: V1, seats: TABLE },
    );
    const items = memory.subjects[1]?.items ?? [];
    expect(PHASE7_MEMORY_INJECTION_V1.maxItemsPerSubject).toBe(5);
    expect(items.map((i) => i.item)).toEqual([
      "pfr",
      "aggression_frequency",
      "vpip",
      "fold_to_three_bet",
      "fold_to_cbet_flop",
    ]);
    expect(items[0]).toEqual({
      item: "pfr",
      frequency: 0.5,
      weightedOpportunities: 8,
      opportunities: 8,
      sufficient: true,
      evidenceCount: 1,
      evidenceIds: ["h1#10"],
    });
    expect(items[2]?.sufficient).toBe(false);
    // Evidence は新しい 3 件（古い順）で、全件の数は evidenceCount に残る。
    const many = summarizeOpponentMemory(
      [hypothesis({ kind: "hero" }, [tendency("cbet_flop", 1.25, 5)])],
      { observer: AKI, policyVersion: V1, seats: TABLE },
    ).subjects[1]?.items[0];
    expect(many?.evidenceCount).toBe(5);
    expect(many?.evidenceIds).toEqual(["h3#12", "h4#13", "h5#14"]);
    expect(many?.weightedOpportunities).toBe(1.3);
  });

  it("cash の Hypothesis だけを使う（tournament は Phase 8）", () => {
    const memory = summarizeOpponentMemory(
      [
        hypothesis({ kind: "hero" }, [tendency("vpip", 4, 1)], {
          context: "tournament",
        }),
      ],
      { observer: AKI, policyVersion: V1, seats: TABLE },
    );
    expect(memory.subjects[1]).toMatchObject({ handsObserved: 0, items: [] });
  });

  it("別の Observer の Hypothesis・別の Policy の Version が混ざった入力は拒否する", () => {
    expect(() =>
      summarizeOpponentMemory([hypothesis(BEN, [], { observer: CHIKA })], {
        observer: AKI,
        policyVersion: V1,
        seats: TABLE,
      }),
    ).toThrow(RangeError);
    expect(() =>
      summarizeOpponentMemory(
        [hypothesis(BEN, [], { policyVersion: "other" })],
        { observer: AKI, policyVersion: V1, seats: TABLE },
      ),
    ).toThrow(RangeError);
  });
});

/**
 * 1 Hand を終わりまで進めた Event。folds の席は Preflop の最初の手番で Fold し、それ以外は Call / Check で Showdown まで進む。
 */
function playHand(
  handId: string,
  seats: readonly string[],
  folds: readonly string[],
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
    const action: PlayerAction =
      folds.includes(legal.playerId) && types.includes("fold")
        ? { type: "fold" }
        : types.includes("call")
          ? { type: "call" }
          : { type: "check" };
    const result = applyAction(state, legal.playerId, action);
    if (!result.ok) throw new Error(result.error.message);
    state = result.value.state;
    events.push(...result.value.events);
  }
  return events;
}

function saveSession(
  store: EventStore,
  sessionId: string,
  hands: readonly { handId: string; seats: readonly string[] }[],
  participants: readonly SessionParticipant[],
): void {
  hands.forEach((h, i) => {
    store.append(
      h.handId,
      playHand(h.handId, h.seats, [], i === 0 ? sessionId : undefined),
      { sessionId, participants },
    );
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

describe("buildOpponentMemoriesFromStore（Event Store から・Isolation）", () => {
  /**
   * s1: Aki（cpu1）・Ben（cpu2）・Hero。h2 では Aki が Bust して座っていない。
   * s2: Aki は座らず、Chika（cpu1）・Ben（cpu2）・Guest（cpu3）・Hero。
   * s3（今の Session）: Aki（cpu1）・Ben（cpu2）・別の Guest（cpu3）・Hero。
   */
  function store(sqlite: boolean): EventStore {
    const s: EventStore = sqlite
      ? SqliteEventStore.open(":memory:")
      : new InMemoryEventStore({ ordinals: createOrdinalCounter() });
    saveSession(
      s,
      "s1",
      [
        { handId: "s1h1", seats: ["cpu2", HERO, "cpu1"] },
        { handId: "s1h2", seats: ["cpu2", HERO] },
        { handId: "s1h3", seats: ["cpu1", "cpu2", HERO] },
      ],
      [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
    );
    saveSession(
      s,
      "s2",
      [
        { handId: "s2h1", seats: ["cpu2", HERO, "cpu1", "cpu3"] },
        { handId: "s2h2", seats: ["cpu3", "cpu2", HERO, "cpu1"] },
      ],
      [
        fixed("cpu1", "fixed_chika"),
        fixed("cpu2", "fixed_ben"),
        guest("cpu3", "guest/s2/cpu3"),
      ],
    );
    saveSession(
      s,
      "s3",
      [{ handId: "s3h1", seats: ["cpu2", HERO, "cpu1", "cpu3"] }],
      [
        fixed("cpu1", "fixed_aki"),
        fixed("cpu2", "fixed_ben"),
        guest("cpu3", "guest/s3/cpu3"),
      ],
    );
    return s;
  }

  const s3Table: readonly MemoryTableSeat[] = [
    { playerId: "cpu1", participant: AKI },
    { playerId: "cpu2", participant: BEN },
    { playerId: HERO, participant: { kind: "hero" } },
    {
      playerId: "cpu3",
      participant: { kind: "guest", guestId: "guest/s3/cpu3" },
    },
  ];

  function build(s: EventStore) {
    return buildOpponentMemoriesFromStore(s, {
      heroPlayerId: HERO,
      currentSessionId: "s3",
      seats: s3Table,
      observers: [
        { playerId: "cpu1", observer: AKI, observerSkill: 0.75 },
        { playerId: "cpu2", observer: BEN, observerSkill: 0.75 },
        {
          playerId: "cpu3",
          observer: { kind: "guest", guestId: "guest/s3/cpu3" },
          observerSkill: 0.5,
        },
      ],
    });
  }

  it.each([false, true])(
    "Observer が座っていた Hand の Evidence だけで、Guest は今の Session の Hand だけ（sqlite=%s）",
    (sqlite) => {
      const memories = build(store(sqlite));
      const aki = memories.get("cpu1");
      // Aki は s1 の Bust した Hand（s1h2）と、座っていない s2 の Hand を観察していない。
      expect(evidenceHands(aki).length).toBeGreaterThan(0);
      expect(
        evidenceHands(aki).every((h) => ["s1h1", "s1h3", "s3h1"].includes(h)),
      ).toBe(true);
      expect(aki?.subjects.map((s) => s.playerId)).toEqual([
        "cpu2",
        HERO,
        "cpu3",
      ]);
      expect(aki?.subjects.map((s) => s.handsObserved)).toEqual([3, 3, 1]);
      // Ben は全 Session に座っていた（Hero は 6 Hand、今の Session の Guest は s3 の 1 Hand だけ）。
      const ben = memories.get("cpu2");
      expect(ben?.subjects.map((s) => s.playerId)).toEqual([
        "cpu1",
        HERO,
        "cpu3",
      ]);
      expect(ben?.subjects.map((s) => s.handsObserved)).toEqual([3, 6, 1]);
      expect(evidenceHands(ben).some((h) => h.startsWith("s2"))).toBe(true);
      // Ben の Hero についての要約は Aki と違う（他の CPU の観察を混ぜない）。
      expect(ben?.subjects.find((s) => s.playerId === HERO)).not.toEqual(
        aki?.subjects.find((s) => s.playerId === HERO),
      );
      // 今の Session の Guest（Observer）は今の Session の Hand だけを観察する。
      expect(evidenceHands(memories.get("cpu3"))).toEqual(["s3h1"]);
      // 前の Session の Guest（guest/s2/cpu3）は Subject にも Evidence にも出ない。
      for (const memory of memories.values()) {
        expect(JSON.stringify(memory)).not.toContain("guest/s2/cpu3");
      }
    },
  );

  it("同じ Store から同じ要約になる（決定論）。メモリ内と SQLite の Store でも同じ", () => {
    const a = build(store(false));
    const b = build(store(false));
    const c = build(store(true));
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect([...a.entries()]).toEqual([...c.entries()]);
  });
});
