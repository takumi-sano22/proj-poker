// CPU の Private Hypothesis（#138・D106・D119）のテスト。recency decay（論理順序の Hand の数）・十分な Sample と Persona の Skill・
// Evidence の provenance・Isolation（Observer ごと・Guest・Cash / Tournament）・決定論・時計が後ろへ戻った記録でも結果が
// 変わらないこと（#129・#130 の再発防止。D117）を確かめる。
import {
  applyAction,
  getLegalActions,
  PHASE1_CASH_PRESET,
  recordSessionEvent,
  startHand,
  type HandEvent,
  type HandState,
  type PlayerAction,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { InMemoryEventStore, type EventStore } from "../event-store.js";
import { createOrdinalCounter } from "../logical-order.js";
import type { SessionParticipant } from "../opponents/cpu-pool.js";
import { PERSONA_PRESETS } from "../opponents/persona.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { DEFAULT_MEMORY_POLICY, PHASE7_MEMORY_V1 } from "./memory-policy.js";
import {
  extractObservedHandsFromStore,
  type ObservationQuery,
  type ObservedHand,
  type ObserverRef,
} from "./observation.js";
import {
  buildOpponentHypotheses,
  buildOpponentHypothesesFromStore,
  type OpponentHypothesis,
  type TendencyEstimate,
} from "./opponent-hypothesis.js";

const HERO = "hero";
const POOL = "phase7_pool_v1";
const AKI = { kind: "cpu_profile", cpuProfileId: "fixed_aki" } as const;
const BEN = { kind: "cpu_profile", cpuProfileId: "fixed_ben" } as const;
const CHIKA = { kind: "cpu_profile", cpuProfileId: "fixed_chika" } as const;

function fixed(playerId: string, cpuProfileId: string): SessionParticipant {
  return { playerId, kind: "fixed", cpuProfileId, poolVersion: POOL };
}

function act(state: HandState, playerId: string, action: PlayerAction) {
  const result = applyAction(state, playerId, action);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/**
 * 1 Hand を終わりまで進めた Event。folds の席は Preflop の最初の手番で Fold し、それ以外は Call / Check で Showdown まで進む。
 * 席は [Button, SB, BB] の順なので、3 人卓では先頭の席が Preflop で最初に Action する（VPIP の機会になる）。
 */
function playHand(input: {
  readonly handId: string;
  readonly seats: readonly string[];
  readonly folds?: ReadonlySet<string>;
  /** Preflop の最初の手番で最小額の Raise をする席。 */
  readonly raises?: ReadonlySet<string>;
  readonly sessionStartedId?: string;
}): HandEvent[] {
  const started = startHand({
    handId: input.handId,
    seats: input.seats.map((playerId) => ({ playerId, stack: 200 })),
    buttonPlayerId: input.seats[0] as string,
    config: PHASE1_CASH_PRESET,
    deal: { seed: 7 },
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
  const raised = new Set<string>();
  for (let step = 0; state.status !== "complete"; step++) {
    const legal = getLegalActions(state);
    if (legal === null || step > 60) throw new Error("Hand が進まない");
    const types = legal.actions.map((a) => a.type);
    const raise = legal.actions.find((a) => a.type === "raise");
    const raiseFirst =
      input.raises?.has(legal.playerId) === true &&
      !raised.has(legal.playerId) &&
      raise !== undefined;
    if (raiseFirst) raised.add(legal.playerId);
    const action: PlayerAction =
      raiseFirst && raise.type === "raise"
        ? { type: "raise", amount: raise.min }
        : input.folds?.has(legal.playerId) === true && types.includes("fold")
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

/** Session を 1 つ保存する。hands の folds は、その Hand で Preflop に Fold する席。 */
function saveSession(
  store: EventStore,
  sessionId: string,
  hands: readonly {
    readonly handId: string;
    readonly seats: readonly string[];
    readonly folds?: readonly string[];
  }[],
  participants: readonly SessionParticipant[],
): void {
  hands.forEach((h, i) => {
    const events = playHand({
      handId: h.handId,
      seats: h.seats,
      folds: new Set(h.folds ?? []),
      ...(i === 0 ? { sessionStartedId: sessionId } : {}),
    });
    store.append(h.handId, events, { sessionId, participants });
  });
}

function query(
  observer: ObserverRef,
  currentSessionId: string,
): ObservationQuery {
  return { observer, heroPlayerId: HERO, currentSessionId };
}

/** Ben（cpu2）が Button で最初に Action する卓。vpip[i] が false の Hand は Ben が Preflop で Fold する。 */
function benStore(
  vpip: readonly boolean[],
  options: { readonly now?: () => Date; readonly sqlite?: boolean } = {},
): EventStore {
  const store = options.sqlite
    ? SqliteEventStore.open(":memory:", options.now ? { now: options.now } : {})
    : new InMemoryEventStore({
        ordinals: createOrdinalCounter(),
        ...(options.now ? { now: options.now } : {}),
      });
  saveSession(
    store,
    "s1",
    vpip.map((v, i) => ({
      handId: `h${i + 1}`,
      seats: ["cpu2", HERO, "cpu1"],
      folds: v ? [] : ["cpu2"],
    })),
    [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
  );
  return store;
}

function hypothesisOf(
  hypotheses: readonly OpponentHypothesis[],
  subject: OpponentHypothesis["subject"],
  context: OpponentHypothesis["context"] = "cash",
): OpponentHypothesis {
  const found = hypotheses.find(
    (h) =>
      JSON.stringify(h.subject) === JSON.stringify(subject) &&
      h.context === context,
  );
  if (found === undefined) throw new Error("Hypothesis が無い");
  return found;
}

function tendency(h: OpponentHypothesis, item: string): TendencyEstimate {
  const found = h.tendencies.find((t) => t.item === item);
  if (found === undefined) throw new Error(`項目 ${item} が無い`);
  return found;
}

const SKILL = 0.5;

describe("phase7_memory_v1（OI-011 の暫定値）", () => {
  it("recency は半減期 150 Hand の指数減衰", () => {
    const p = PHASE7_MEMORY_V1;
    expect(p.recencyWeight(0)).toBe(1);
    expect(p.recencyWeight(150)).toBeCloseTo(0.5, 12);
    expect(p.recencyWeight(300)).toBeCloseTo(0.25, 12);
    expect(() => p.recencyWeight(-1)).toThrow(RangeError);
    expect(() => p.recencyWeight(1.5)).toThrow(RangeError);
  });

  it("十分な Sample は機会数 15 を Skill で 0.5〜1.5 倍にした数", () => {
    const p = PHASE7_MEMORY_V1;
    expect(p.sufficientOpportunities(0)).toBe(7.5);
    expect(p.sufficientOpportunities(0.5)).toBe(15);
    expect(p.sufficientOpportunities(1)).toBe(22.5);
    expect(() => p.sufficientOpportunities(1.1)).toThrow(RangeError);
    expect(() => p.sufficientOpportunities(Number.NaN)).toThrow(RangeError);
  });

  it("既定の Policy は phase7_memory_v1", () => {
    expect(DEFAULT_MEMORY_POLICY.version).toBe("phase7_memory_v1");
  });
});

describe("Private Hypothesis: 集計と recency decay", () => {
  it("Observer がその Subject を見た Hand の数で減衰し、最新の Hand の重みが 1", () => {
    // h1 で Fold・h2 で Call。新しい h2 が重み 1、h1 は 1 Hand 分古い。
    const store = benStore([false, true]);
    const hs = buildOpponentHypothesesFromStore(store, query(AKI, "s1"), {
      observerSkill: SKILL,
    });
    const ben = hypothesisOf(hs, BEN);
    expect(ben.handsObserved).toBe(2);
    expect(ben.lastOrd).toBe(store.savedOrder("h2"));
    expect(ben.policyVersion).toBe("phase7_memory_v1");
    const vpip = tendency(ben, "vpip");
    expect(vpip.numerator).toBe(1);
    expect(vpip.denominator).toBe(PHASE7_MEMORY_V1.recencyWeight(1) + 1);
    expect(vpip.opportunities).toBe(2);
    expect(vpip.policyVersion).toBe("phase7_memory_v1");
  });

  it("Evidence は Subject の Action の hand_id・seq・ord で、古い Evidence も消さない", () => {
    const store = benStore([false, true]);
    const ben = hypothesisOf(
      buildOpponentHypothesesFromStore(store, query(AKI, "s1"), {
        observerSkill: SKILL,
      }),
      BEN,
    );
    const vpip = tendency(ben, "vpip");
    const expected = ["h1", "h2"].flatMap((handId) =>
      store
        .read(handId)
        .map((s) => s.event)
        .filter(
          (e) =>
            e.type === "ACTION_TAKEN" &&
            e.playerId === "cpu2" &&
            e.street === "preflop",
        )
        .map((e) => ({ handId, seq: e.seq, ord: store.savedOrder(handId) })),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(vpip.evidence).toEqual(expected);
  });

  it("Evidence は寄与を決めた Action だけで、同じ Street の別の Action を入れない", () => {
    // Ben（Button）が Call → Hero（SB）が Raise → Ben が Call。VPIP は最初の Call、3-bet の機会は Raise に直面した 2 回目の Call。
    const store = new InMemoryEventStore({ ordinals: createOrdinalCounter() });
    const events = playHand({
      handId: "h1",
      seats: ["cpu2", HERO, "cpu1"],
      raises: new Set([HERO]),
      sessionStartedId: "s1",
    });
    store.append("h1", events, {
      sessionId: "s1",
      participants: [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
    });
    const benPreflop = events
      .filter(
        (e) =>
          e.type === "ACTION_TAKEN" &&
          e.playerId === "cpu2" &&
          e.street === "preflop",
      )
      .map((e) => e.seq);
    expect(benPreflop).toHaveLength(2);
    const ben = hypothesisOf(
      buildOpponentHypothesesFromStore(store, query(AKI, "s1"), {
        observerSkill: SKILL,
      }),
      BEN,
    );
    const ord = store.savedOrder("h1");
    const vpip = tendency(ben, "vpip");
    expect(vpip.numerator).toBe(1);
    expect(vpip.evidence).toEqual([{ handId: "h1", seq: benPreflop[0], ord }]);
    const threeBet = tendency(ben, "three_bet");
    expect(threeBet).toMatchObject({ numerator: 0, opportunities: 1 });
    expect(threeBet.evidence).toEqual([
      { handId: "h1", seq: benPreflop[1], ord },
    ]);
    // Postflop の Check は Aggression Frequency の機会ではないので Evidence にも入らない。
    expect(tendency(ben, "aggression_frequency").evidence).toEqual([]);
  });

  it("Subject は Hero と他の CPU で、Observer 自身は入らない。項目は Policy の順", () => {
    const hs = buildOpponentHypothesesFromStore(
      benStore([true]),
      query(AKI, "s1"),
      { observerSkill: SKILL },
    );
    // 並びは Subject の鍵の順（["cpu_profile", …] が ["hero"] より前）。
    expect(hs.map((h) => h.subject)).toEqual([BEN, { kind: "hero" }]);
    for (const h of hs) {
      expect(h.tendencies.map((t) => t.item)).toEqual(PHASE7_MEMORY_V1.items);
    }
  });

  it("Persona の Skill で十分な Sample の基準が変わる（弱い CPU は早合点し、強い CPU は保留する）", () => {
    // 13 Hand: 重み付きの機会数は 13 よりわずかに小さい。
    const store = benStore(Array.from({ length: 13 }, () => true));
    const weak = PERSONA_PRESETS.calling_station.traits.skill; // 0.3 → 12
    const strong = PERSONA_PRESETS.tag_regular.traits.skill; // 0.75 → 18.75
    const vpipOf = (skill: number) =>
      tendency(
        hypothesisOf(
          buildOpponentHypothesesFromStore(store, query(AKI, "s1"), {
            observerSkill: skill,
          }),
          BEN,
        ),
        "vpip",
      );
    const w = vpipOf(weak);
    const s = vpipOf(strong);
    expect(w.denominator).toBeGreaterThan(12);
    expect(w.denominator).toBeLessThan(13);
    expect(w.sufficient).toBe(true);
    expect(s.sufficient).toBe(false);
    // 基準が変わるだけで、数えた値は同じ。
    expect({ ...w, sufficient: null }).toEqual({ ...s, sufficient: null });
  });

  it("機会の無い項目は 0 / 0 で不十分", () => {
    const ben = hypothesisOf(
      buildOpponentHypothesesFromStore(benStore([true]), query(AKI, "s1"), {
        observerSkill: 0,
      }),
      BEN,
    );
    const threeBet = tendency(ben, "three_bet");
    expect(threeBet).toMatchObject({
      numerator: 0,
      denominator: 0,
      opportunities: 0,
      sufficient: false,
      evidence: [],
    });
  });
});

describe("Private Hypothesis: Isolation", () => {
  it("A の B への Hypothesis は A の観察だけから作り、A が座っていない Hand（C の観察）を使わない", () => {
    const store = benStore([false, true]);
    const before = buildOpponentHypothesesFromStore(store, query(AKI, "s1"), {
      observerSkill: SKILL,
    });
    // Aki のいない Session で Ben と Chika が打つ（Chika は Ben を観察するが、Aki は見ていない）。
    saveSession(
      store,
      "s2",
      [
        { handId: "x1", seats: ["cpu2", HERO, "cpu1"] },
        { handId: "x2", seats: ["cpu2", HERO, "cpu1"] },
      ],
      [fixed("cpu1", "fixed_chika"), fixed("cpu2", "fixed_ben")],
    );
    const after = buildOpponentHypothesesFromStore(store, query(AKI, "s2"), {
      observerSkill: SKILL,
    });
    expect(after).toEqual(before);
    // Chika の Ben への Hypothesis は別に作られる（Aki の観察は入らない）。
    const chika = buildOpponentHypothesesFromStore(store, query(CHIKA, "s2"), {
      observerSkill: SKILL,
    });
    expect(hypothesisOf(chika, BEN).handsObserved).toBe(2);
    expect(
      tendency(hypothesisOf(chika, BEN), "vpip").evidence.every((e) =>
        ["x1", "x2"].includes(e.handId),
      ),
    ).toBe(true);
  });

  it("別の Observer の観察を混ぜた入力は拒否する", () => {
    const store = benStore([true]);
    saveSession(
      store,
      "s2",
      [{ handId: "x1", seats: ["cpu2", HERO, "cpu1"] }],
      [fixed("cpu1", "fixed_chika"), fixed("cpu2", "fixed_ben")],
    );
    const aki = extractObservedHandsFromStore(store, query(AKI, "s2"));
    const chika = extractObservedHandsFromStore(store, query(CHIKA, "s2"));
    expect(() =>
      buildOpponentHypotheses([...aki, ...chika], {
        observer: AKI,
        observerSkill: SKILL,
      }),
    ).toThrow(RangeError);
  });

  it("Guest の Hypothesis は次の Session に持ち越さない（Observer としても Subject としても）", () => {
    const store = new InMemoryEventStore({ ordinals: createOrdinalCounter() });
    const g = {
      playerId: "cpu2",
      kind: "guest",
      guestId: "guest/s1/cpu2",
      poolVersion: POOL,
    } as const;
    saveSession(
      store,
      "s1",
      [{ handId: "h1", seats: ["cpu2", HERO, "cpu1"] }],
      [fixed("cpu1", "fixed_aki"), g],
    );
    saveSession(
      store,
      "s2",
      [{ handId: "h2", seats: ["cpu2", HERO, "cpu1"] }],
      [fixed("cpu1", "fixed_aki"), fixed("cpu2", "fixed_ben")],
    );
    const guestRef = { kind: "guest", guestId: g.guestId } as const;

    // 同じ Session の間は、Guest について・Guest が持つ Hypothesis がある。
    const during = buildOpponentHypothesesFromStore(store, query(AKI, "s1"), {
      observerSkill: SKILL,
    });
    expect(during.some((h) => h.subject.kind === "guest")).toBe(true);
    expect(
      buildOpponentHypothesesFromStore(store, query(guestRef, "s1"), {
        observerSkill: SKILL,
      }).length,
    ).toBeGreaterThan(0);

    // 次の Session では、Guest についての Hypothesis も、Guest が持っていた Hypothesis も無い。
    const next = buildOpponentHypothesesFromStore(store, query(AKI, "s2"), {
      observerSkill: SKILL,
    });
    expect(next.some((h) => h.subject.kind === "guest")).toBe(false);
    expect(hypothesisOf(next, { kind: "hero" }).handsObserved).toBe(2);
    expect(
      buildOpponentHypothesesFromStore(store, query(guestRef, "s2"), {
        observerSkill: SKILL,
      }),
    ).toEqual([]);
  });

  it("Cash と Tournament の Hypothesis は混ざらない（Raw Observation は共通・Hypothesis は context ごと）", () => {
    const store = benStore([true, false, true, false]);
    const hands = extractObservedHandsFromStore(store, query(AKI, "s1"));
    // h2・h4 を Tournament の Hand とみなす（Tournament は Phase 8 で使う枠）。
    const tagged: ObservedHand[] = hands.map((h, i) =>
      i % 2 === 1 ? { ...h, context: "tournament" } : h,
    );
    const options = { observer: AKI, observerSkill: SKILL } as const;
    const mixed = buildOpponentHypotheses(tagged, options);
    const cashOnly = buildOpponentHypotheses(
      tagged.filter((h) => h.context === "cash"),
      options,
    );
    const tournamentOnly = buildOpponentHypotheses(
      tagged.filter((h) => h.context === "tournament"),
      options,
    );
    expect(mixed.filter((h) => h.context === "cash")).toEqual(cashOnly);
    expect(mixed.filter((h) => h.context === "tournament")).toEqual(
      tournamentOnly,
    );
    const cash = tendency(hypothesisOf(mixed, BEN, "cash"), "vpip");
    const tour = tendency(hypothesisOf(mixed, BEN, "tournament"), "vpip");
    // Cash は h1・h3（どちらも Call）、Tournament は h2・h4（どちらも Fold）。
    expect(cash.numerator).toBe(cash.denominator);
    expect(tour.numerator).toBe(0);
    expect(hypothesisOf(mixed, BEN, "cash").handsObserved).toBe(2);
  });
});

describe("Private Hypothesis: 決定論と論理順序", () => {
  it("同じ入力から同じ結果になり、入力の並びに依らず、入力を変えない", () => {
    const store = benStore([true, false, true]);
    const hands = extractObservedHandsFromStore(store, query(AKI, "s1"));
    const snapshot = structuredClone(hands);
    const options = { observer: AKI, observerSkill: SKILL } as const;
    const first = buildOpponentHypotheses(hands, options);
    expect(buildOpponentHypotheses(hands, options)).toEqual(first);
    expect(buildOpponentHypotheses([...hands].reverse(), options)).toEqual(
      first,
    );
    expect(hands).toEqual(snapshot);
  });

  it("論理順序の番号が重複した入力は拒否する", () => {
    const hands = extractObservedHandsFromStore(
      benStore([true, false]),
      query(AKI, "s1"),
    );
    expect(() =>
      buildOpponentHypotheses(
        hands.map((h) => ({ ...h, ord: 1 })),
        { observer: AKI, observerSkill: SKILL },
      ),
    ).toThrow(RangeError);
  });

  /** 呼ぶたびに 1 時間ずつ戻る時計。 */
  function backwardsClock(): () => Date {
    let t = Date.parse("2026-10-08T12:00:00.000Z");
    return () => {
      t -= 60 * 60 * 1000;
      return new Date(t);
    };
  }

  // h1 は Fold、h2・h3 は Call。最新の Hand（保存の順で最後の h3）の重みが 1 のまま。
  const VPIP = [false, true, true] as const;

  /** 時計が戻った Store と、同じ種類の時計が進む Store を比べる（ord の振り方を揃えるため同じ種類の Store にする）。 */
  function assertByOrd(store: EventStore, forward: EventStore): void {
    const times = ["h1", "h2", "h3"].map(
      (h) => store.read(h)[0]?.recordedAt ?? "",
    );
    // 記録時刻は保存の順と逆に並んでいる（時計が戻った）。
    expect([...times].sort().reverse()).toEqual(times);
    const build = (s: EventStore) =>
      buildOpponentHypothesesFromStore(s, query(AKI, "s1"), {
        observerSkill: SKILL,
      });
    const ben = hypothesisOf(build(store), BEN);
    expect(ben.lastOrd).toBe(store.savedOrder("h3"));
    const vpip = tendency(ben, "vpip");
    const w = (age: number) => PHASE7_MEMORY_V1.recencyWeight(age);
    expect(vpip.numerator).toBe(w(1) + w(0));
    expect(vpip.denominator).toBe(w(2) + w(1) + w(0));
    // 時計が進む Store と同じ結果。
    expect(build(store)).toEqual(build(forward));
  }

  it("時計が後ろへ戻った記録でも、decay は保存の順（ord）で決まる（メモリ内の Store）", () => {
    assertByOrd(benStore(VPIP, { now: backwardsClock() }), benStore(VPIP));
  });

  it("時計が後ろへ戻った記録でも、decay は保存の順（ord）で決まる（SQLite の Store）", () => {
    const store = benStore(VPIP, { now: backwardsClock(), sqlite: true });
    const forward = benStore(VPIP, { sqlite: true });
    try {
      assertByOrd(store, forward);
    } finally {
      (store as SqliteEventStore).close();
      (forward as SqliteEventStore).close();
    }
  });
});
