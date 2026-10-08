// CPU の Observation の抽出（#137・D106・D118）のテスト。情報境界（Learning-only Reveal・他者の Hidden / Future Cards・
// Observer 自身の private が入らない）・provenance・Observer が座っていない Hand・Guest・v10 より前の Session・決定論・
// 時計が後ろへ戻った記録でも順序が変わらないこと（#129・#130 の再発防止。D117）を確かめる。
import {
  applyAction,
  cardToString,
  foldHandEvents,
  getLegalActions,
  parseCards,
  PHASE1_CASH_PRESET,
  projectLearningReveal,
  recordAiEvent,
  recordSessionEvent,
  recordUserRead,
  startHand,
  type HandEvent,
  type HandState,
  type PlayerAction,
  type SeatInit,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { createOrdinalCounter } from "../logical-order.js";
import { InMemoryEventStore, type EventStore } from "../event-store.js";
import type { SessionParticipant } from "../opponents/cpu-pool.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { collectCards } from "../testing/leaks.js";
import {
  extractObservedHands,
  extractObservedHandsFromStore,
  loadObservationSources,
  observationsOf,
  type ObservationQuery,
  type ObservedHand,
} from "./observation.js";

const HERO = "hero";
const POOL = "phase7_pool_v1";

function fixed(playerId: string, cpuProfileId: string): SessionParticipant {
  return { playerId, kind: "fixed", cpuProfileId, poolVersion: POOL };
}

function guest(
  sessionId: string,
  playerId: string,
): Extract<SessionParticipant, { kind: "guest" }> {
  return {
    playerId,
    kind: "guest",
    guestId: `guest/${sessionId}/${playerId}`,
    poolVersion: POOL,
  };
}

const AKI = { kind: "cpu_profile", cpuProfileId: "fixed_aki" } as const;
const BEN = { kind: "cpu_profile", cpuProfileId: "fixed_ben" } as const;

/** 手番を 1 つ進める（成功しなければテストの誤り）。 */
function act(state: HandState, playerId: string, action: PlayerAction) {
  const result = applyAction(state, playerId, action);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/**
 * 1 Hand を終わりまで進めた Event。最初の手番が Fold し、残りは Call / Check で Showdown まで進む。
 * public 以外の Event も混ぜる: Hole Cards（private）・Deck（engine）・Metadata / Session の開始 / CPU の不正な出力（system）・
 * Hero の User Read（Hero の private）。
 */
function playHand(input: {
  readonly handId: string;
  readonly seats: readonly string[];
  readonly seed: number;
  readonly sessionStartedId?: string;
}): HandEvent[] {
  const seats: SeatInit[] = input.seats.map((playerId) => ({
    playerId,
    stack: 200,
  }));
  const started = startHand({
    handId: input.handId,
    seats,
    buttonPlayerId: input.seats[0] as string,
    config: PHASE1_CASH_PRESET,
    deal: { seed: input.seed },
    metadata: {
      appVersion: "0.0.0-test",
      cpuProfileVersion: "cpu-profile-test",
      cpuSeats: input.seats
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
  if (input.sessionStartedId !== undefined) {
    const s = recordSessionEvent(state, {
      type: "SESSION_STARTED",
      sessionId: input.sessionStartedId,
    });
    state = s.state;
    events.push(...s.events);
  }
  let readDone = false;
  let invalidDone = false;
  for (let step = 0; state.status !== "complete"; step++) {
    const legal = getLegalActions(state);
    if (legal === null || step > 60) throw new Error("Hand が進まない");
    if (legal.playerId === HERO && !readDone) {
      const read = recordUserRead(state, {
        playerId: HERO,
        targetPlayerId: null,
        text: "相手は強い",
      });
      if (!read.ok) throw new Error(read.error.message);
      state = read.value.state;
      events.push(...read.value.events);
      readDone = true;
    }
    if (legal.playerId !== HERO && !invalidDone) {
      const invalid = recordAiEvent(state, {
        type: "AI_ACTION_INVALID",
        playerId: legal.playerId,
        attempt: 1,
        stage: "schema",
        reason: "test",
      });
      state = invalid.state;
      events.push(...invalid.events);
      invalidDone = true;
    }
    const types = legal.actions.map((a) => a.type);
    const action: PlayerAction =
      step === 0
        ? { type: "fold" }
        : types.includes("call")
          ? { type: "call" }
          : { type: "check" };
    const progressed = act(state, legal.playerId, action);
    state = progressed.state;
    events.push(...progressed.events);
  }
  return events;
}

/** 卓で見聞きできた札（Board と Showdown で表にされた札）。 */
function observableCards(events: readonly HandEvent[]): Set<string> {
  const state = foldHandEvents(events);
  const cards = new Set(state.board.map(cardToString));
  for (const e of events) {
    if (e.type === "CARDS_TABLED")
      e.cards.forEach((c) => cards.add(cardToString(c)));
  }
  return cards;
}

/**
 * Session を 1 つ保存する（最初の Hand で SESSION_STARTED と参加者を渡す。Event Store の契約どおり）。
 * participants を省くと v10 より前の Session（参加者の行が無い）になる。
 */
function saveSession(
  store: EventStore,
  sessionId: string,
  hands: readonly {
    readonly handId: string;
    readonly seats: readonly string[];
  }[],
  participants?: readonly SessionParticipant[],
  seed = 11,
): void {
  hands.forEach((h, i) => {
    const events = playHand({
      handId: h.handId,
      seats: h.seats,
      seed: seed + i,
      ...(i === 0 ? { sessionStartedId: sessionId } : {}),
    });
    store.append(h.handId, events, {
      sessionId,
      ...(participants === undefined ? {} : { participants }),
    });
  });
}

function query(
  observer: ObservationQuery["observer"],
  currentSessionId: string,
): ObservationQuery {
  return { observer, heroPlayerId: HERO, currentSessionId };
}

/** 標準の卓: Session s1 に Hero・Aki（cpu1）・Ben（cpu2）。 */
function standardStore(): InMemoryEventStore {
  const store = new InMemoryEventStore({ ordinals: createOrdinalCounter() });
  saveSession(
    store,
    "s1",
    [
      { handId: "h1", seats: [HERO, "cpu1", "cpu2"] },
      { handId: "h2", seats: ["cpu1", "cpu2", HERO] },
      { handId: "h3", seats: ["cpu2", HERO, "cpu1"] },
    ],
    [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
  );
  return store;
}

describe("Observation の抽出: 情報境界", () => {
  it("Observer が見聞きした public の Event だけを通し、Hole Cards・Deck・system・Hero の読みを入れない", () => {
    const store = standardStore();
    const hands = extractObservedHandsFromStore(store, query(AKI, "s1"));
    expect(hands.map((h) => h.handId)).toEqual(["h1", "h2", "h3"]);
    for (const hand of hands) {
      const all = store.read(hand.handId).map((s) => s.event);
      // 元の Log には public 以外の Event がある（テストが空振りしない）。
      expect(all.some((e) => e.visibility.type !== "public")).toBe(true);
      expect(hand.events.length).toBe(
        all.filter((e) => e.visibility.type === "public").length,
      );
      for (const e of hand.events) {
        expect(e.event.visibility).toEqual({ type: "public" });
        expect(e.visibility).toBe("public");
        expect([
          "HOLE_CARD_DEALT",
          "DECK_SHUFFLED",
          "USER_READ_RECORDED",
          "HAND_METADATA_RECORDED",
          "SESSION_STARTED",
          "AI_ACTION_INVALID",
        ]).not.toContain(e.event.type);
      }
    }
  });

  it("抽出の値に、Board と Showdown で表にされた札以外の Card（他者の Hidden Cards・Future Cards・Learning-only Reveal でだけ見える札）が無い", () => {
    const store = standardStore();
    for (const observer of [AKI, BEN]) {
      for (const hand of extractObservedHandsFromStore(
        store,
        query(observer, "s1"),
      )) {
        const all = store.read(hand.handId).map((s) => s.event);
        const allowed = observableCards(all);
        const found = collectCards(hand).map(cardToString);
        expect(found.length).toBeGreaterThan(0);
        expect(found.filter((c) => !allowed.has(c))).toEqual([]);
        // Learning-only Reveal でだけ見える札（Fold した Player の札）が実際にあり、それが入っていない。
        const reveal = projectLearningReveal(all);
        const hiddenOnly = (reveal?.holeCards ?? [])
          .flatMap((h) => h.cards.map(cardToString))
          .filter((c) => !allowed.has(c));
        expect(hiddenOnly.length).toBeGreaterThan(0);
        expect(found.filter((c) => hiddenOnly.includes(c))).toEqual([]);
      }
    }
  });

  it("public でない Event の中身（他者・自分の Hole Cards・Deck・system・Hero の読み）を差し替えても結果が変わらない", () => {
    const store = standardStore();
    const sources = loadObservationSources(store, query(AKI, "s1"));
    const swapped = sources.map((s) => ({
      ...s,
      events: s.events.map((e): HandEvent => {
        switch (e.type) {
          case "HOLE_CARD_DEALT":
            return {
              ...e,
              cards: parseCards("2c 3d"),
            };
          case "DECK_SHUFFLED":
            return { ...e, deck: [] };
          case "USER_READ_RECORDED":
            return { ...e, text: "差し替えた読み" };
          case "AI_ACTION_INVALID":
            return { ...e, reason: "差し替えた理由" };
          default:
            return e;
        }
      }),
    }));
    expect(extractObservedHands(swapped, query(AKI, "s1"))).toEqual(
      extractObservedHands(sources, query(AKI, "s1")),
    );
  });

  it("保存された visibility が public でも、Engine が種類から決める Visibility が public でない Event は通さない", () => {
    const store = standardStore();
    const sources = loadObservationSources(store, query(AKI, "s1"));
    const forged = sources.map((s) => ({
      ...s,
      events: s.events.map((e): HandEvent => ({
        ...e,
        visibility: { type: "public" },
      })),
    }));
    for (const hand of extractObservedHands(forged, query(AKI, "s1"))) {
      expect(
        hand.events.filter((e) =>
          ["HOLE_CARD_DEALT", "DECK_SHUFFLED", "USER_READ_RECORDED"].includes(
            e.event.type,
          ),
        ),
      ).toEqual([]);
    }
  });

  it("Observer 自身の Event は Subject の Observation にしない（Subject は Hero と他の CPU だけ）", () => {
    const store = standardStore();
    const observations = observationsOf(
      extractObservedHandsFromStore(store, query(AKI, "s1")),
    );
    const subjects = new Set(
      observations.map((o) => JSON.stringify(o.subject)),
    );
    expect(subjects).toEqual(
      new Set([JSON.stringify({ kind: "hero" }), JSON.stringify(BEN)]),
    );
  });
});

describe("Observation の抽出: provenance", () => {
  it("Observer・Subject・hand_id・seq・ord・Visibility・context を持ち、Subject は席でなく参加者で引く", () => {
    const store = standardStore();
    const hands = extractObservedHandsFromStore(store, query(AKI, "s1"));
    const h2 = hands.find((h) => h.handId === "h2") as ObservedHand;
    expect(h2.observerPlayerId).toBe("cpu1");
    expect(h2.sessionId).toBe("s1");
    expect(h2.ord).toBe(store.savedOrder("h2"));
    expect(h2.context).toBe("cash");
    expect(h2.seats).toEqual([
      { playerId: "cpu1", participant: AKI },
      { playerId: "cpu2", participant: BEN },
      { playerId: HERO, participant: { kind: "hero" } },
    ]);
    const observations = observationsOf(hands);
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) {
      expect(o.observer).toEqual(AKI);
      expect(o.visibility).toBe("public");
      expect(o.context).toBe("cash");
      expect(o.ord).toBe(store.savedOrder(o.handId));
      // seq は保存した Event の seq と同じ（Event Log の行へ戻れる）。
      const stored = store.read(o.handId).find((s) => s.event.seq === o.seq);
      expect(stored?.event).toEqual(o.event);
      const actor = "playerId" in o.event ? o.event.playerId : null;
      expect(actor).not.toBeNull();
      expect(o.subject).toEqual(actor === HERO ? { kind: "hero" } : BEN);
    }
    // Showdown で表にされた札も Subject の Observation になる。
    expect(observations.some((o) => o.event.type === "CARDS_TABLED")).toBe(
      true,
    );
  });

  it("同じ Fixed CPU が別の Session で別の席に座っても、同じ Observer・Subject として引く", () => {
    const store = new InMemoryEventStore({ ordinals: createOrdinalCounter() });
    saveSession(
      store,
      "s1",
      [{ handId: "h1", seats: [HERO, "cpu1", "cpu2"] }],
      [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
    );
    saveSession(
      store,
      "s2",
      [{ handId: "h2", seats: [HERO, "cpu1", "cpu2"] }],
      [fixed("cpu1", "fixed_ben"), fixed("cpu2", "fixed_aki")],
    );
    const hands = extractObservedHandsFromStore(store, query(AKI, "s2"));
    expect(hands.map((h) => [h.handId, h.observerPlayerId])).toEqual([
      ["h1", "cpu1"],
      ["h2", "cpu2"],
    ]);
    const benActs = observationsOf(hands)
      .filter((o) => o.subject.kind === "cpu_profile")
      .map((o) => [o.handId, "playerId" in o.event ? o.event.playerId : null]);
    // Ben の行動は h1 では cpu2、h2 では cpu1 の席の Event（どちらの Hand にも 1 つ以上ある）。
    expect(new Set(benActs.map(([h, p]) => `${h}:${p}`))).toEqual(
      new Set(["h1:cpu2", "h2:cpu1"]),
    );
  });
});

describe("Observation の抽出: 観察しない Hand", () => {
  it("Observer が座っていない Hand（Bust の後）と、Observer が参加者にいない Session の Hand は観察しない", () => {
    const store = new InMemoryEventStore({ ordinals: createOrdinalCounter() });
    saveSession(
      store,
      "s1",
      [
        { handId: "h1", seats: [HERO, "cpu1", "cpu2"] },
        { handId: "h2", seats: [HERO, "cpu2"] },
      ],
      [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
    );
    saveSession(
      store,
      "s2",
      [{ handId: "h3", seats: [HERO, "cpu1"] }],
      [fixed("cpu1", "fixed_ben")],
    );
    const aki = extractObservedHandsFromStore(store, query(AKI, "s2"));
    expect(aki.map((h) => h.handId)).toEqual(["h1"]);
    // 座っていない Hand の Event は 1 つも入らない。
    expect(observationsOf(aki).every((o) => o.handId === "h1")).toBe(true);
    const ben = extractObservedHandsFromStore(store, query(BEN, "s2"));
    expect(ben.map((h) => h.handId)).toEqual(["h1", "h2", "h3"]);
  });

  it("v10 より前の Session（参加者の行が無い）は観察の対象にしない（推測で Identity を作らない）", () => {
    const store = new InMemoryEventStore({ ordinals: createOrdinalCounter() });
    saveSession(store, "legacy", [
      { handId: "h0", seats: [HERO, "cpu1", "cpu2"] },
    ]);
    saveSession(
      store,
      "s1",
      [{ handId: "h1", seats: [HERO, "cpu1", "cpu2"] }],
      [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
    );
    expect(store.sessionParticipants("legacy")).toEqual([]);
    for (const observer of [AKI, BEN]) {
      const hands = extractObservedHandsFromStore(store, query(observer, "s1"));
      expect(hands.map((h) => h.handId)).toEqual(["h1"]);
    }
  });

  it("Guest は Observer でも Subject でも、次の Session では読まない", () => {
    const store = new InMemoryEventStore({ ordinals: createOrdinalCounter() });
    const g = guest("s1", "cpu2");
    saveSession(
      store,
      "s1",
      [{ handId: "h1", seats: [HERO, "cpu1", "cpu2"] }],
      [fixed("cpu1", "fixed_aki"), g],
    );
    saveSession(
      store,
      "s2",
      [{ handId: "h2", seats: [HERO, "cpu1", "cpu2"] }],
      [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
    );
    const guestRef = { kind: "guest", guestId: g.guestId } as const;

    // 同じ Session の間は、Guest も Observer として観察し、Subject として引ける。
    expect(
      extractObservedHandsFromStore(store, query(guestRef, "s1")).map(
        (h) => h.handId,
      ),
    ).toEqual(["h1"]);
    const during = observationsOf(
      extractObservedHandsFromStore(store, query(AKI, "s1")),
    );
    expect(during.some((o) => o.subject.kind === "guest")).toBe(true);

    // 次の Session では、Guest の Observer は何も読まず、Guest の Subject は誰か引けない席（null）になる。
    expect(extractObservedHandsFromStore(store, query(guestRef, "s2"))).toEqual(
      [],
    );
    const next = extractObservedHandsFromStore(store, query(AKI, "s2"));
    expect(next.map((h) => h.handId)).toEqual(["h1", "h2"]);
    const h1 = next[0] as ObservedHand;
    expect(h1.seats.find((s) => s.playerId === "cpu2")?.participant).toBeNull();
    expect(
      h1.events
        .filter((e) => "playerId" in e.event && e.event.playerId === "cpu2")
        .every((e) => e.subject === null),
    ).toBe(true);
    const after = observationsOf(next);
    expect(after.some((o) => o.subject.kind === "guest")).toBe(false);
    expect(after.some((o) => o.handId === "h1")).toBe(true);
  });
});

describe("Observation の抽出: 決定論と論理順序", () => {
  it("同じ Event Log から同じ結果になり、入力の並びに依らない", () => {
    const store = standardStore();
    const q = query(AKI, "s1");
    const sources = loadObservationSources(store, q);
    const first = extractObservedHands(sources, q);
    expect(extractObservedHands(sources, q)).toEqual(first);
    const shuffled = [...sources].reverse().map((s) => ({
      ...s,
      events: [...s.events].reverse(),
    }));
    expect(extractObservedHands(shuffled, q)).toEqual(first);
    expect(extractObservedHandsFromStore(standardStore(), q)).toEqual(first);
  });

  it("論理順序の番号が重複した入力は拒否する（順序を決められない）", () => {
    const store = standardStore();
    const q = query(AKI, "s1");
    const sources = loadObservationSources(store, q);
    const dup = sources.map((s) => ({ ...s, ord: 1 }));
    expect(() => extractObservedHands(dup, q)).toThrow(RangeError);
  });

  /** 呼ぶたびに 1 時間ずつ戻る時計。 */
  function backwardsClock(): () => Date {
    let t = Date.parse("2026-10-08T12:00:00.000Z");
    return () => {
      t -= 60 * 60 * 1000;
      return new Date(t);
    };
  }

  function saveBackwards(store: EventStore): void {
    saveSession(
      store,
      "s1",
      [
        { handId: "h1", seats: [HERO, "cpu1", "cpu2"] },
        { handId: "h2", seats: ["cpu1", "cpu2", HERO] },
        { handId: "h3", seats: ["cpu2", HERO, "cpu1"] },
      ],
      [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
    );
  }

  function assertSaveOrder(store: EventStore): void {
    expect(store.sessionIdOfHand("h1")).toBe("s1");
    expect(store.sessionIdOfHand("unknown")).toBeNull();
    // 記録時刻は保存の順と逆に並んでいる（時計が戻った）。
    const times = ["h1", "h2", "h3"].map(
      (h) => store.read(h)[0]?.recordedAt ?? "",
    );
    expect([...times].sort().reverse()).toEqual(times);
    const hands = extractObservedHandsFromStore(store, query(AKI, "s1"));
    expect(hands.map((h) => h.handId)).toEqual(["h1", "h2", "h3"]);
    expect(hands.map((h) => h.ord)).toEqual(
      ["h1", "h2", "h3"].map((h) => store.savedOrder(h)),
    );
    for (const h of hands) {
      const seqs = h.events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  }

  it("時計が後ろへ戻った記録でも、Hand の順は保存の順（ord）・Hand の中は seq のまま（メモリ内の Store）", () => {
    const store = new InMemoryEventStore({
      now: backwardsClock(),
      ordinals: createOrdinalCounter(),
    });
    saveBackwards(store);
    assertSaveOrder(store);
  });

  it("時計が後ろへ戻った記録でも、Hand の順は保存の順（ord）・Hand の中は seq のまま（SQLite の Store）", () => {
    const store = SqliteEventStore.open(":memory:", { now: backwardsClock() });
    try {
      saveBackwards(store);
      assertSaveOrder(store);
    } finally {
      store.close();
    }
  });
});
