// Table Tendency（#141・D106）のテスト。public の Event だけから卓の傾向を数えること・viewer 自身の Action を入れないこと・
// viewer が座っていない Hand と打ち切った Hand を入れないこと・論理順序の範囲（入力の並び・壁時計に依らない）・十分な Sample の判定・
// 見えない Event（Hole Cards・Deck・system）を差し替えても結果が変わらないこと・CPU 用と Hero 用の入り口の範囲・
// 時計が後ろへ戻った記録でも結果が変わらないこと（D117。メモリ内と SQLite の Store）を確かめる。
import {
  parseCards,
  visibilityOf,
  type ActionType,
  type HandEvent,
  type HandEventBody,
  type Street,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { InMemoryEventStore, type EventStore } from "../event-store.js";
import { createOrdinalCounter } from "../logical-order.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import {
  buildCpuTableTendenciesFromStore,
  buildHeroTableTendencyFromStore,
  buildTableTendency,
  loadTableTendencySources,
  type TableTendency,
  type TableTendencySourceHand,
} from "./table-tendency.js";
import {
  DEFAULT_TABLE_TENDENCY_POLICY,
  PHASE7_TABLE_TENDENCY_V1,
} from "./table-tendency-policy.js";

const V = PHASE7_TABLE_TENDENCY_V1.version;
type Act = readonly [Street, string, ActionType, number];

const BOARD: Record<Exclude<Street, "preflop">, string> = {
  flop: "2c 7d 9h",
  turn: "Js",
  river: "Kc",
};

/**
 * 1 Hand の Event。Button は seats の先頭。Board は Street が変わった最初の Action の前に配る。
 * hidden を変えると、見えない Event（他者の Hole Cards・Deck・system の記録）だけが変わる。
 */
function hand(
  handId: string,
  seats: readonly string[],
  acts: readonly Act[],
  o: {
    readonly showdown: boolean;
    readonly finished?: boolean;
    readonly hidden?: boolean;
  },
): HandEvent[] {
  const cards = o.hidden
    ? ["3c 4c", "5c 6c", "8c 8d"]
    : ["As Ad", "Ks Kd", "Qs Qd"];
  const bodies: HandEventBody[] = [
    {
      type: "HAND_STARTED",
      handId,
      ruleProfile: "test",
      smallBlind: 1,
      bigBlind: 2,
      oddChipRule: "first_left_of_button",
      reopenRule: "cumulative_full_raise",
      seats: seats.map((playerId) => ({ playerId, stack: 1000 })),
      buttonPlayerId: seats[0] ?? "",
    },
    {
      type: "DECK_SHUFFLED",
      seed: null,
      deck: parseCards(o.hidden ? "Th Tc" : "Qh Qc"),
    },
    ...seats.map((playerId, i): HandEventBody => ({
      type: "HOLE_CARD_DEALT",
      playerId,
      cards: parseCards(cards[i] ?? "2s 3s"),
    })),
  ];
  let street: Street = "preflop";
  for (const [s, playerId, action, toAmount] of acts) {
    if (s !== street) {
      street = s;
      if (s !== "preflop") {
        bodies.push({
          type: "BOARD_DEALT",
          street: s,
          cards: parseCards(BOARD[s]),
        });
      }
    }
    bodies.push({
      type: "ACTION_TAKEN",
      playerId,
      street: s,
      action,
      amount: toAmount,
      toAmount,
      allIn: false,
    });
  }
  bodies.push({
    type: "AI_ACTION_INVALID",
    playerId: seats[1] ?? "",
    attempt: 1,
    stage: "schema",
    reason: o.hidden ? "別の理由" : "形が違う",
  });
  if (o.finished === false) return withSeq(bodies);
  bodies.push(
    {
      type: "POT_AWARDED",
      potIndex: 0,
      potTotal: 10,
      eligible: [seats[0] ?? ""],
      awards: [{ playerId: seats[0] ?? "", amount: 10 }],
      showdown: o.showdown,
    },
    {
      type: "HAND_FINISHED",
      stacks: seats.map((playerId) => ({ playerId, amount: 1000 })),
    },
  );
  return withSeq(bodies);
}

function withSeq(bodies: readonly HandEventBody[]): HandEvent[] {
  return bodies.map((body, seq) => ({
    ...body,
    seq,
    visibility: visibilityOf(body),
  }));
}

/**
 * h1: hero / cpu1 / cpu2。cpu2 Fold、hero Raise、cpu1 Call。Flop で cpu1 Check、hero Bet、cpu1 Call。Showdown。
 * h2: 同じ席。cpu2 Raise、hero Fold、cpu1 Fold。Showdown なし。
 * h3: cpu1 が座っていない（hero / cpu2）。hero Raise、cpu2 Call。Flop で cpu2 Bet、hero Fold。
 * h4: 打ち切った Hand（HAND_FINISHED が無い）。
 */
function h1(hidden = false): HandEvent[] {
  return hand(
    "h1",
    ["hero", "cpu1", "cpu2"],
    [
      ["preflop", "cpu2", "fold", 0],
      ["preflop", "hero", "raise", 6],
      ["preflop", "cpu1", "call", 6],
      ["flop", "cpu1", "check", 0],
      ["flop", "hero", "bet", 8],
      ["flop", "cpu1", "call", 8],
    ],
    { showdown: true, hidden },
  );
}
function h2(hidden = false): HandEvent[] {
  return hand(
    "h2",
    ["hero", "cpu1", "cpu2"],
    [
      ["preflop", "cpu2", "raise", 6],
      ["preflop", "hero", "fold", 0],
      ["preflop", "cpu1", "fold", 0],
    ],
    { showdown: false, hidden },
  );
}
function h3(hidden = false): HandEvent[] {
  return hand(
    "h3",
    ["hero", "cpu2"],
    [
      ["preflop", "hero", "raise", 6],
      ["preflop", "cpu2", "call", 6],
      ["flop", "cpu2", "bet", 4],
      ["flop", "hero", "fold", 0],
    ],
    { showdown: false, hidden },
  );
}
function h4(): HandEvent[] {
  return hand(
    "h4",
    ["hero", "cpu1", "cpu2"],
    [["preflop", "cpu2", "raise", 6]],
    { showdown: false, finished: false },
  );
}

function sources(hidden = false): TableTendencySourceHand[] {
  return [
    { handId: "h1", ord: 1, events: h1(hidden) },
    { handId: "h2", ord: 2, events: h2(hidden) },
    { handId: "h3", ord: 3, events: h3(hidden) },
    { handId: "h4", ord: 4, events: h4() },
  ];
}

/** 項目ごとの [numerator, denominator, hands] にする。 */
function counts(t: TableTendency): Record<string, [number, number, number]> {
  return Object.fromEntries(
    t.items.map((i) => [i.item, [i.numerator, i.denominator, i.hands]]),
  );
}

describe("phase7_table_tendency_v1（OI-011 の暫定値）", () => {
  it("項目・範囲・十分な Sample の基準", () => {
    expect(DEFAULT_TABLE_TENDENCY_POLICY).toBe(PHASE7_TABLE_TENDENCY_V1);
    expect(PHASE7_TABLE_TENDENCY_V1).toMatchObject({
      version: "phase7_table_tendency_v1",
      items: ["vpip", "pfr", "aggression_frequency", "showdown"],
      windowHands: 100,
      minHands: 10,
      minOpportunities: 20,
    });
  });
});

describe("buildTableTendency（public の Event だけから数える）", () => {
  it("viewer 以外の Action を合算し、viewer が座っていない Hand・打ち切った Hand は入れない（cpu1 は h1・h2 だけ）", () => {
    const t = buildTableTendency(sources(), "cpu1");
    expect(t.policyVersion).toBe(V);
    expect(t.hands).toBe(2);
    expect(counts(t)).toEqual({
      // h1: hero 1/1・cpu2 0/1、h2: cpu2 1/1・hero 0/1
      vpip: [2, 4, 2],
      pfr: [2, 4, 2],
      // h1 の hero の Flop の Bet だけ（cpu1 自身の Check / Call は入れない）
      aggression_frequency: [1, 1, 1],
      // h1 だけが Showdown（Hand 単位）
      showdown: [1, 2, 2],
    });
    for (const item of t.items) {
      expect(item.policyVersion).toBe(V);
      expect(item.sufficient).toBe(false);
    }
  });

  it("Hero から見ると、Hero が座っていた h1〜h3 を数え、Hero 自身の Action は入れない", () => {
    expect(counts(buildTableTendency(sources(), "hero"))).toEqual({
      // h1: cpu1 1/1・cpu2 0/1、h2: cpu2 1/1・cpu1 0/1、h3: cpu2 1/1
      vpip: [3, 5, 3],
      // h2 の cpu2 の Raise だけ
      pfr: [1, 5, 3],
      // h1 の cpu1 の Call（0/1）、h3 の cpu2 の Bet（1/1）
      aggression_frequency: [1, 2, 2],
      showdown: [1, 3, 3],
    });
  });

  it("十分かは、項目の機会があった Hand の数と機会の数の両方が Policy の基準以上か", () => {
    const policy = {
      ...PHASE7_TABLE_TENDENCY_V1,
      minHands: 2,
      minOpportunities: 3,
    };
    const t = buildTableTendency(sources(), "cpu1", policy);
    expect(
      Object.fromEntries(t.items.map((i) => [i.item, i.sufficient])),
    ).toEqual({
      vpip: true,
      pfr: true,
      aggression_frequency: false,
      showdown: false,
    });
  });

  it("範囲は viewer が座っていた Hand の、論理順序で新しい windowHands まで。入力の並びに依らず、ord の重複・不正は拒否する", () => {
    const policy = { ...PHASE7_TABLE_TENDENCY_V1, windowHands: 1 };
    // cpu1 の新しい 1 Hand は h2（h3 は座っていないので数えない）。
    const t = buildTableTendency(sources(), "cpu1", policy);
    expect(t.hands).toBe(1);
    expect(counts(t)["vpip"]).toEqual([1, 2, 1]);
    expect(
      buildTableTendency([...sources()].reverse(), "cpu1", policy),
    ).toEqual(t);
    expect(buildTableTendency([...sources()].reverse(), "cpu1")).toEqual(
      buildTableTendency(sources(), "cpu1"),
    );
    const dup = sources().map((s) => ({ ...s, ord: 1 }));
    expect(() => buildTableTendency(dup, "cpu1")).toThrow(RangeError);
    const bad = [{ ...sources()[0], ord: 1.5 } as TableTendencySourceHand];
    expect(() => buildTableTendency(bad, "cpu1")).toThrow(RangeError);
  });

  it("見えない Event（他者の Hole Cards・Deck・system の記録）を差し替えても、保存された Visibility が public でない Event を混ぜても同じ", () => {
    const base = buildTableTendency(sources(), "cpu1");
    expect(buildTableTendency(sources(true), "cpu1")).toEqual(base);
    // ACTION_TAKEN でも保存された Visibility が public でなければ通さない（whitelist は両方の Visibility を見る）。
    const stray: HandEvent = {
      type: "ACTION_TAKEN",
      playerId: "cpu2",
      street: "preflop",
      action: "raise",
      amount: 50,
      toAmount: 50,
      allIn: false,
      seq: 999,
      visibility: { type: "private", playerId: "cpu2" },
    };
    const forged: TableTendencySourceHand[] = sources().map((s) => ({
      ...s,
      events: [...s.events, stray],
    }));
    expect(buildTableTendency(forged, "cpu1")).toEqual(base);
    // 同じ入力からは同じ結果。
    expect(buildTableTendency(sources(), "cpu1")).toEqual(base);
  });
});

describe("Event Store からの入り口（CPU 用・Hero 用）", () => {
  type Clock = () => Date;
  /** 呼ぶたびに 1 時間ずつ戻る時計。 */
  function backwardsClock(): Clock {
    let t = Date.parse("2026-10-08T12:00:00.000Z");
    return () => {
      t -= 60 * 60 * 1000;
      return new Date(t);
    };
  }

  function open(sqlite: boolean, now?: Clock): EventStore {
    return sqlite
      ? SqliteEventStore.open(":memory:", now === undefined ? {} : { now })
      : new InMemoryEventStore({
          ordinals: createOrdinalCounter(),
          ...(now === undefined ? {} : { now }),
        });
  }

  function close(store: EventStore): void {
    if (store instanceof SqliteEventStore) store.close();
  }

  /** s1: h1〜h3（ord の順に保存）。s2: h2 と同じ形の 1 Hand。 */
  function build(sqlite: boolean, now?: Clock): EventStore {
    const store = open(sqlite, now);
    store.append("h1", h1(), { sessionId: "s1" });
    store.append("h2", h2(), { sessionId: "s1" });
    store.append("h3", h3(), { sessionId: "s1" });
    store.append(
      "s2h1",
      hand(
        "s2h1",
        ["hero", "cpu1", "cpu2"],
        [
          ["preflop", "cpu2", "call", 2],
          ["preflop", "hero", "call", 2],
          ["preflop", "cpu1", "check", 2],
        ],
        { showdown: false },
      ),
      { sessionId: "s2" },
    );
    return store;
  }

  it.each([false, true])(
    "CPU 用: 今の Session の、その CPU が座っていた Hand だけを数え、Hand が 0 の CPU は返さない（sqlite=%s）",
    (sqlite) => {
      const store = build(sqlite);
      const s1 = buildCpuTableTendenciesFromStore(store, {
        sessionId: "s1",
        playerIds: ["cpu1", "cpu2", "cpu3"],
      });
      expect([...s1.keys()]).toEqual(["cpu1", "cpu2"]);
      // cpu1 は h1・h2 だけ（座っていない h3 は入らない）。
      const own = loadTableTendencySources(store, "s1").filter(
        (h) => h.handId !== "h3",
      );
      expect(s1.get("cpu1")).toEqual(buildTableTendency(own, "cpu1"));
      expect(s1.get("cpu1")?.hands).toBe(2);
      expect(s1.get("cpu2")?.hands).toBe(3);
      // 前の Session の Hand は持ち越さない。
      const s2 = buildCpuTableTendenciesFromStore(store, {
        sessionId: "s2",
        playerIds: ["cpu1"],
      });
      expect(s2.get("cpu1")?.hands).toBe(1);
      expect(counts(s2.get("cpu1") as TableTendency)["vpip"]).toEqual([
        2, 2, 1,
      ]);
      expect(
        buildCpuTableTendenciesFromStore(store, {
          sessionId: "s9",
          playerIds: ["cpu1"],
        }).size,
      ).toBe(0);
      close(store);
    },
  );

  it.each([false, true])(
    "Hero 用: Hero が座って見えた Hand だけを数え、beforeOrd より後の Hand を混ぜない。Hand が無ければ hands 0（sqlite=%s）",
    (sqlite) => {
      const store = build(sqlite);
      const all = buildHeroTableTendencyFromStore(store, {
        sessionId: "s1",
        heroPlayerId: "hero",
      });
      expect(all).toEqual(buildTableTendency(sources().slice(0, 3), "hero"));
      const ordOfH3 = store.savedOrder("h3") ?? 0;
      const before = buildHeroTableTendencyFromStore(store, {
        sessionId: "s1",
        heroPlayerId: "hero",
        beforeOrd: ordOfH3,
      });
      expect(before.hands).toBe(2);
      const none = buildHeroTableTendencyFromStore(store, {
        sessionId: "s9",
        heroPlayerId: "hero",
      });
      expect(none.hands).toBe(0);
      expect(
        none.items.every((i) => i.denominator === 0 && !i.sufficient),
      ).toBe(true);
      close(store);
    },
  );

  it.each([false, true])(
    "時計が後ろへ戻った記録でも、範囲は保存の順（ord）で決まり、結果は変わらない（sqlite=%s）",
    (sqlite) => {
      const policy = { ...PHASE7_TABLE_TENDENCY_V1, windowHands: 1 };
      const store = build(sqlite, backwardsClock());
      const forward = build(sqlite);
      const times = ["h1", "h2", "h3"].map(
        (h) => store.read(h)[0]?.recordedAt ?? "",
      );
      // 記録時刻は保存の順と逆に並んでいる（時計が戻った）。
      expect([...times].sort().reverse()).toEqual(times);
      const query = { sessionId: "s1", playerIds: ["cpu1", "hero"] };
      const backwards = buildCpuTableTendenciesFromStore(store, query, policy);
      // cpu1 の新しい 1 Hand は ord で h2（記録時刻で選べば h1 になる）。
      expect(counts(backwards.get("cpu1") as TableTendency)["vpip"]).toEqual([
        1, 2, 1,
      ]);
      expect([...backwards.entries()]).toEqual([
        ...buildCpuTableTendenciesFromStore(forward, query, policy).entries(),
      ]);
      expect(
        buildHeroTableTendencyFromStore(
          store,
          { sessionId: "s1", heroPlayerId: "hero" },
          policy,
        ),
      ).toEqual(
        buildHeroTableTendencyFromStore(
          forward,
          { sessionId: "s1", heroPlayerId: "hero" },
          policy,
        ),
      );
      close(store);
      close(forward);
    },
  );
});
