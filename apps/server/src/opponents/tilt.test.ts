// CPU の Tilt（#140・D107・D119）のテスト。Policy の暫定値（phase7_tilt_v1）・1 Hand の結果（Trigger の定義）・State Machine の
// 上がり / 下がり / 上限・論理順序での畳み込み（入力の並び・壁時計に依らない）・Session ごとの Reset（SESSION_ENDED の無い Session も
// 持ち越さない）・席ごとの Isolation・CPU に見えない Event を読まないこと・時計が後ろへ戻った記録でも結果が変わらないこと（D117）を確かめる。
import {
  parseCards,
  visibilityOf,
  type HandEvent,
  type HandEventBody,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { InMemoryEventStore, type EventStore } from "../event-store.js";
import { createOrdinalCounter } from "../logical-order.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { PERSONA_PRESETS } from "./persona.js";
import {
  buildTiltsFromStore,
  foldTilt,
  INITIAL_TILT_STATE,
  loadTiltSources,
  stepTilt,
  tiltHandOutcome,
  type TiltSeat,
  type TiltSourceHand,
} from "./tilt.js";
import { DEFAULT_TILT_POLICY, PHASE7_TILT_V1 } from "./tilt-policy.js";

const BB = 2;
const TAG = PERSONA_PRESETS.tag_regular.traits;
const MANIAC = PERSONA_PRESETS.maniac.traits;

/** Event の中身の列に seq と Visibility（Engine が種類から決める値）を付ける。 */
function events(bodies: readonly HandEventBody[]): HandEvent[] {
  return bodies.map((body, seq) => ({
    ...body,
    seq,
    visibility: visibilityOf(body),
  }));
}

interface ShowdownSpec {
  readonly winner: string;
  readonly loser: string;
  /** Preflop で 2 人が出す額（Raise と Call）。Pot は 2 × (each + River の Bet)。 */
  readonly each: number;
  /** River の Bet（by が Bet し、相手が Call する）。 */
  readonly riverBet?: { readonly by: string; readonly amount: number };
  readonly loserCards?: string;
  /** Preflop で Fold する席。 */
  readonly folders?: readonly string[];
  /** 他者の Hole Cards・Deck を差し替える（見えない Event を読まないことの検査）。 */
  readonly hidden?: { readonly winnerCards: string; readonly deck: string };
}

/** 2 人が Showdown まで残る 1 Hand。Board は 2c 7d 9h Js Kc（役の無い Board）、勝つ側は As Ad。 */
function showdownHand(handId: string, o: ShowdownSpec): HandEvent[] {
  const seats = [o.winner, o.loser, ...(o.folders ?? [])];
  // 表にする札は常に As Ad。hidden は配った札（その席宛ての private）だけを差し替える。
  const winnerCards = "As Ad";
  const winnerDealt = o.hidden?.winnerCards ?? winnerCards;
  const loserCards = o.loserCards ?? "3s 4s";
  const bet = o.riverBet?.amount ?? 0;
  const pot = 2 * (o.each + bet);
  const bodies: HandEventBody[] = [
    {
      type: "HAND_STARTED",
      handId,
      ruleProfile: "test",
      smallBlind: 1,
      bigBlind: BB,
      oddChipRule: "first_left_of_button",
      reopenRule: "cumulative_full_raise",
      seats: seats.map((playerId) => ({ playerId, stack: 1000 })),
      buttonPlayerId: o.winner,
    },
    {
      type: "DECK_SHUFFLED",
      seed: null,
      deck: parseCards(o.hidden?.deck ?? "Qh Qd"),
    },
    {
      type: "HOLE_CARD_DEALT",
      playerId: o.winner,
      cards: parseCards(winnerDealt),
    },
    {
      type: "HOLE_CARD_DEALT",
      playerId: o.loser,
      cards: parseCards(loserCards),
    },
    ...(o.folders ?? []).map((playerId): HandEventBody => ({
      type: "ACTION_TAKEN",
      playerId,
      street: "preflop",
      action: "fold",
      amount: 0,
      toAmount: 0,
      allIn: false,
    })),
    {
      type: "ACTION_TAKEN",
      playerId: o.winner,
      street: "preflop",
      action: "raise",
      amount: o.each,
      toAmount: o.each,
      allIn: false,
    },
    {
      type: "ACTION_TAKEN",
      playerId: o.loser,
      street: "preflop",
      action: "call",
      amount: o.each,
      toAmount: o.each,
      allIn: false,
    },
    { type: "BOARD_DEALT", street: "flop", cards: parseCards("2c 7d 9h") },
    { type: "BOARD_DEALT", street: "turn", cards: parseCards("Js") },
    { type: "BOARD_DEALT", street: "river", cards: parseCards("Kc") },
  ];
  if (o.riverBet !== undefined) {
    const caller = o.riverBet.by === o.winner ? o.loser : o.winner;
    bodies.push(
      {
        type: "ACTION_TAKEN",
        playerId: o.riverBet.by,
        street: "river",
        action: "bet",
        amount: bet,
        toAmount: bet,
        allIn: false,
      },
      {
        type: "ACTION_TAKEN",
        playerId: caller,
        street: "river",
        action: "call",
        amount: bet,
        toAmount: bet,
        allIn: false,
      },
    );
  }
  bodies.push(
    {
      type: "CARDS_TABLED",
      playerId: o.winner,
      cards: parseCards(winnerCards),
    },
    { type: "CARDS_TABLED", playerId: o.loser, cards: parseCards(loserCards) },
    {
      type: "POT_AWARDED",
      potIndex: 0,
      potTotal: pot,
      eligible: [o.winner, o.loser],
      awards: [{ playerId: o.winner, amount: pot }],
      showdown: true,
    },
    {
      type: "HAND_FINISHED",
      stacks: seats.map((playerId) => ({
        playerId,
        amount:
          playerId === o.winner
            ? 1000 + pot / 2
            : playerId === o.loser
              ? 1000 - pot / 2
              : 1000,
      })),
    },
  );
  return events(bodies);
}

/** 1 Hand の source（ord は呼び出し側が決める）。 */
function source(
  handId: string,
  ord: number,
  evs: readonly HandEvent[],
): TiltSourceHand {
  return { handId, ord, events: evs };
}

/** cpu1 が小さい Pot（10BB）を Showdown で負ける Hand。 */
const smallLoss = (handId: string) =>
  showdownHand(handId, { winner: "hero", loser: "cpu1", each: 10 });
/** cpu1 が小さい Pot を勝つ Hand。 */
const smallWin = (handId: string) =>
  showdownHand(handId, {
    winner: "cpu1",
    loser: "hero",
    each: 10,
    loserCards: "Ks Qh",
  });
/** cpu1 が Preflop で Fold する Hand（Trigger の無い Hand）。 */
const fold = (handId: string) =>
  showdownHand(handId, {
    winner: "hero",
    loser: "cpu2",
    each: 10,
    folders: ["cpu1"],
  });

describe("phase7_tilt_v1（OI-011 の暫定値）", () => {
  it("上がり幅は ceil(Trigger の数 × tiltSusceptibility × 2)。Tilt しやすい Persona ほど速く上がる", () => {
    const p = PHASE7_TILT_V1;
    expect(p.version).toBe("phase7_tilt_v1");
    expect(p.maxLevel).toBe(3);
    expect(p.bigPotBigBlinds).toBe(40);
    expect(p.lossStreak).toBe(3);
    // TAG（0.25）は Trigger 1・2 つで 1 段、3 つで 2 段。Maniac（0.7）は 1 つで 2 段、2 つで 3 段。
    expect([1, 2, 3].map((n) => p.rise(n, TAG.tiltSusceptibility))).toEqual([
      1, 1, 2,
    ]);
    expect([1, 2].map((n) => p.rise(n, MANIAC.tiltSusceptibility))).toEqual([
      2, 3,
    ]);
    expect(p.rise(0, 1)).toBe(0);
    expect(p.rise(3, 0)).toBe(0);
    // 浮動小数の端数で段が増えない（0.2 × 5 × 2 = 2 ちょうど）。
    expect(p.rise(5, 0.2)).toBe(2);
    expect(() => p.rise(-1, 0.5)).toThrow(RangeError);
    expect(() => p.rise(1, 1.5)).toThrow(RangeError);
  });

  it("下がり方は Trigger の無い Hand が round(10 − 8 × recoverySpeed) 回で 1 段", () => {
    const p = PHASE7_TILT_V1;
    expect(
      Object.values(PERSONA_PRESETS).map((persona) =>
        p.calmHandsPerStep(persona.traits.recoverySpeed),
      ),
    ).toEqual([4, 5, 6, 5, 8, 6]);
    expect(p.calmHandsPerStep(0)).toBe(10);
    expect(p.calmHandsPerStep(1)).toBe(2);
    expect(() => p.calmHandsPerStep(Number.NaN)).toThrow(RangeError);
  });
});

describe("tiltHandOutcome（1 Hand の結果と Trigger の定義）", () => {
  it("40BB 以上の Pot を Showdown で負けたら bigPotLost、勝った側は bigWin（収支がプラス）", () => {
    // Pot 80（40BB）。
    const big = showdownHand("h", { winner: "cpu2", loser: "cpu1", each: 40 });
    expect(tiltHandOutcome(big, "cpu1")).toEqual({
      lostShowdown: true,
      wonPot: false,
      bigPotLost: true,
      bluffCaught: false,
      bigWin: false,
    });
    expect(tiltHandOutcome(big, "cpu2")).toEqual({
      lostShowdown: false,
      wonPot: true,
      bigPotLost: false,
      bluffCaught: false,
      bigWin: true,
    });
    // Pot 78（39BB）はしきい値の下。
    const below = showdownHand("h", {
      winner: "cpu2",
      loser: "cpu1",
      each: 39,
    });
    expect(tiltHandOutcome(below, "cpu1")?.bigPotLost).toBe(false);
    expect(tiltHandOutcome(below, "cpu1")?.lostShowdown).toBe(true);
    expect(tiltHandOutcome(below, "cpu2")?.bigWin).toBe(false);
  });

  it("最後に額を上げたのが自分で、自分の 2 枚で役が上がっていない手で Showdown に負けたら bluffCaught", () => {
    const bluff = showdownHand("h", {
      winner: "cpu2",
      loser: "cpu1",
      each: 5,
      riverBet: { by: "cpu1", amount: 10 },
    });
    expect(tiltHandOutcome(bluff, "cpu1")?.bluffCaught).toBe(true);
    // 自分の札で Pair ができていれば（Value のつもりの Bet）Bluff ではない。
    const value = showdownHand("h", {
      winner: "cpu2",
      loser: "cpu1",
      each: 5,
      riverBet: { by: "cpu1", amount: 10 },
      loserCards: "Ks Qh",
    });
    expect(tiltHandOutcome(value, "cpu1")?.bluffCaught).toBe(false);
    // 最後に額を上げたのが相手なら、自分の Bluff は見つかっていない。
    const called = showdownHand("h", {
      winner: "cpu2",
      loser: "cpu1",
      each: 5,
      riverBet: { by: "cpu2", amount: 10 },
    });
    expect(tiltHandOutcome(called, "cpu1")?.bluffCaught).toBe(false);
  });

  it("Fold した Hand は勝ち負けにならず、座っていない Hand・打ち切った Hand は null", () => {
    expect(tiltHandOutcome(fold("h"), "cpu1")).toEqual({
      lostShowdown: false,
      wonPot: false,
      bigPotLost: false,
      bluffCaught: false,
      bigWin: false,
    });
    expect(tiltHandOutcome(smallLoss("h"), "cpu9")).toBeNull();
    const aborted = smallLoss("h").filter((e) => e.type !== "HAND_FINISHED");
    expect(tiltHandOutcome(aborted, "cpu1")).toBeNull();
  });

  it("CPU に見えない Event（他者の Hole Cards・Deck）を差し替えても結果は同じ。並びが seq 順でなくても同じ", () => {
    const spec: ShowdownSpec = {
      winner: "cpu2",
      loser: "cpu1",
      each: 40,
      riverBet: { by: "cpu1", amount: 10 },
    };
    const base = tiltHandOutcome(showdownHand("h", spec), "cpu1");
    const swapped = tiltHandOutcome(
      showdownHand("h", {
        ...spec,
        hidden: { winnerCards: "Kh Kd", deck: "8c 8d 8h" },
      }),
      "cpu1",
    );
    expect(swapped).toEqual(base);
    expect(
      tiltHandOutcome([...showdownHand("h", spec)].reverse(), "cpu1"),
    ).toEqual(base);
  });
});

describe("foldTilt（State Machine の畳み込み）", () => {
  const seat = (traits = TAG): TiltSeat => ({ playerId: "cpu1", traits });

  it("Showdown の 3 連敗で上がり、Fold した Hand は連敗を切らず、Pot を受け取った Hand で連敗が切れる", () => {
    const hands = [
      smallLoss("h1"),
      fold("h2"),
      smallLoss("h3"),
      smallLoss("h4"),
    ].map((e, i) => source(`h${i + 1}`, i + 1, e));
    expect(foldTilt(hands, seat())).toEqual({
      level: 1,
      calmHands: 0,
      lossStreak: 0,
    });
    const broken = [
      smallLoss("h1"),
      smallLoss("h2"),
      smallWin("h3"),
      smallLoss("h4"),
    ].map((e, i) => source(`h${i + 1}`, i + 1, e));
    expect(foldTilt(broken, seat())).toEqual({
      level: 0,
      calmHands: 0,
      lossStreak: 1,
    });
  });

  it("Trigger の無い Hand が recoverySpeed で決まる数だけ続くと 1 段下がる（TAG は 4 Hand）", () => {
    const losses = [smallLoss("a"), smallLoss("b"), smallLoss("c")];
    const withCalm = (n: number) =>
      [...losses, ...Array.from({ length: n }, (_, i) => fold(`f${i}`))].map(
        (e, i) => source(`h${i + 1}`, i + 1, e),
      );
    expect(foldTilt(withCalm(3), seat()).level).toBe(1);
    expect(foldTilt(withCalm(3), seat()).calmHands).toBe(3);
    expect(foldTilt(withCalm(4), seat()).level).toBe(0);
    // 0 の間は数えない。
    expect(foldTilt(withCalm(9), seat())).toEqual(INITIAL_TILT_STATE);
  });

  it("複数の Trigger は 1 Hand でまとめて数え、上限 3 で止まる。tiltSusceptibility が 0 なら上がらない", () => {
    // 40BB 以上の Pot で Bluff が見つかる（Trigger 2 つ）。Maniac は 1 Hand で 3 段。
    const bigBluff = showdownHand("h", {
      winner: "cpu2",
      loser: "cpu1",
      each: 40,
      riverBet: { by: "cpu1", amount: 20 },
    });
    expect(
      stepTilt(INITIAL_TILT_STATE, tiltHandOutcome(bigBluff, "cpu1"), MANIAC)
        .level,
    ).toBe(3);
    const many = Array.from({ length: 5 }, (_, i) =>
      source(`h${i}`, i + 1, bigBluff),
    );
    expect(foldTilt(many, seat(MANIAC)).level).toBe(3);
    expect(foldTilt(many, seat({ ...TAG, tiltSusceptibility: 0 })).level).toBe(
      0,
    );
    // 大勝ち（Overconfidence）でも上がる。
    const bigWin = showdownHand("h", {
      winner: "cpu1",
      loser: "cpu2",
      each: 40,
    });
    expect(foldTilt([source("w", 1, bigWin)], seat()).level).toBe(1);
  });

  it("並びは ord の小さい順で、入力の並びに依らない。ord の重複・不正は拒否する", () => {
    // ord の順: 4 Hand の Fold → 3 連敗（1 段）。逆に読むと 3 連敗 → 4 Hand で 0 に戻る。
    const hands = [
      ...Array.from({ length: 4 }, (_, i) => fold(`f${i}`)),
      smallLoss("a"),
      smallLoss("b"),
      smallLoss("c"),
    ].map((e, i) => source(`h${i + 1}`, (i + 1) * 10, e));
    const expected = foldTilt(hands, seat());
    expect(expected.level).toBe(1);
    expect(foldTilt([...hands].reverse(), seat())).toEqual(expected);
    expect(() =>
      foldTilt(
        hands.map((h) => ({ ...h, ord: 1 })),
        seat(),
      ),
    ).toThrow(RangeError);
    expect(() =>
      foldTilt([{ ...(hands[0] as TiltSourceHand), ord: 1.5 }], seat()),
    ).toThrow(RangeError);
  });
});

describe("buildTiltsFromStore（Event Store から・Session ごとの Reset・席ごとの Isolation）", () => {
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

  function save(
    store: EventStore,
    sessionId: string,
    hands: readonly (readonly [string, HandEvent[]])[],
  ): void {
    for (const [handId, evs] of hands) {
      store.append(handId, evs, { sessionId });
    }
  }

  /**
   * s1: cpu1 は 3 連敗（1 段）、cpu2 は勝ち続ける（0）。SESSION_ENDED を置かずに放置する。
   * s2: 今の Session。まだ 1 Hand（cpu1 の小さい負け）。
   */
  function build(sqlite: boolean, now?: Clock): EventStore {
    const store = open(sqlite, now);
    const lossTo2 = (h: string) =>
      showdownHand(h, { winner: "cpu2", loser: "cpu1", each: 10 });
    save(store, "s1", [
      ["s1h1", lossTo2("s1h1")],
      ["s1h2", lossTo2("s1h2")],
      ["s1h3", lossTo2("s1h3")],
    ]);
    save(store, "s2", [["s2h1", lossTo2("s2h1")]]);
    return store;
  }

  const seats: TiltSeat[] = [
    { playerId: "cpu1", traits: TAG },
    { playerId: "cpu2", traits: MANIAC },
  ];

  it.each([false, true])(
    "今の Session の Hand だけを畳み込み、前の Session（SESSION_ENDED が無くても）を持ち越さない。1 以上の席だけを返す（sqlite=%s）",
    (sqlite) => {
      const store = build(sqlite);
      const s1 = buildTiltsFromStore(store, { sessionId: "s1", seats });
      expect([...s1.entries()]).toEqual([
        [
          "cpu1",
          {
            level: 1,
            maxLevel: 3,
            policyVersion: DEFAULT_TILT_POLICY.version,
          },
        ],
      ]);
      // s2 は 0 から（cpu1 は 1 敗だけ）。他の席の Tilt は混ざらない。
      expect(buildTiltsFromStore(store, { sessionId: "s2", seats }).size).toBe(
        0,
      );
      expect(loadTiltSources(store, "s2").map((h) => h.handId)).toEqual([
        "s2h1",
      ]);
      // 同じ Store からは同じ結果（Resume で同じ Session の Hand から同じ値になる）。
      expect([
        ...buildTiltsFromStore(store, { sessionId: "s1", seats }).entries(),
      ]).toEqual([...s1.entries()]);
    },
  );

  it.each([false, true])(
    "時計が後ろへ戻った記録でも、畳み込みは保存の順（ord）で決まる（sqlite=%s）",
    (sqlite) => {
      // ord の順: 4 Hand の Fold → 3 連敗（TAG は 1 段）。記録時刻の順（逆）に読むと 3 連敗 → 4 Hand で 0 に戻る。
      const hands: [string, HandEvent[]][] = [
        ...Array.from({ length: 4 }, (_, i): [string, HandEvent[]] => [
          `f${i}`,
          fold(`f${i}`),
        ]),
        ...["l1", "l2", "l3"].map((h): [string, HandEvent[]] => [
          h,
          smallLoss(h),
        ]),
      ];
      const store = open(sqlite, backwardsClock());
      save(store, "s1", hands);
      const forward = open(sqlite);
      save(forward, "s1", hands);
      const times = hands.map(([h]) => store.read(h)[0]?.recordedAt ?? "");
      // 記録時刻は保存の順と逆に並んでいる（時計が戻った）。
      expect([...times].sort().reverse()).toEqual(times);
      const tilts = buildTiltsFromStore(store, {
        sessionId: "s1",
        seats: [{ playerId: "cpu1", traits: TAG }],
      });
      expect(tilts.get("cpu1")?.level).toBe(1);
      expect([...tilts.entries()]).toEqual([
        ...buildTiltsFromStore(forward, {
          sessionId: "s1",
          seats: [{ playerId: "cpu1", traits: TAG }],
        }).entries(),
      ]);
      if (sqlite) {
        (store as SqliteEventStore).close();
        (forward as SqliteEventStore).close();
      }
    },
  );
});
