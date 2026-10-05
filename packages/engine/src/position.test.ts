// Position Engine（nextHandSeating）のテスト。
// 前半は入力の検証と Button の進め方の単体テスト、後半は実際に startHand → applyAction で Bust させ、
// 次 Hand の席・Button・Blind を確かめる複数 Hand の Scenario（docs/02 §5 Heads-Up Button/SB・3 人→Heads-Up 移行）。
// 期待値はすべて手計算（コメントに計算過程を残す）。
import { describe, expect, it } from "vitest";
import type { HandEvent, SeatInit } from "./hand-events.js";
import { applyAction, startHand } from "./hand-engine.js";
import { foldHandEvents, type HandState } from "./hand-state.js";
import { getLegalActions, type PlayerAction } from "./legal-actions.js";
import {
  nextHandSeating,
  type NextHandSeating,
  type PreviousHandResult,
} from "./position.js";
import {
  PHASE1_CASH_PRESET,
  type ButtonRule,
  type TableConfig,
} from "./table-config.js";
import { checkInvariants, initialChipTotal } from "./testing/invariants.js";
import { stackedDeck } from "./testing/stacked-deck.js";

const config: TableConfig = PHASE1_CASH_PRESET;

/** 席順と Stack（席順のまま）から前 Hand の結果を作る。 */
function previous(
  stacks: Readonly<Record<string, number>>,
  buttonPlayerId: string,
): PreviousHandResult {
  return {
    seatOrder: Object.keys(stacks),
    stacks: Object.entries(stacks).map(([playerId, amount]) => ({
      playerId,
      amount,
    })),
    buttonPlayerId,
  };
}

function seat(result: ReturnType<typeof nextHandSeating>): NextHandSeating {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("nextHandSeating: Button の進め方（simple_moving。D80・OI-008 の暫定値）", () => {
  it("誰も Bust しなければ席はそのままで、Button は時計回りに 1 席進む", () => {
    expect(
      seat(nextHandSeating(previous({ a: 200, b: 190, c: 210 }, "a"), config)),
    ).toEqual({
      kind: "next_hand",
      seats: [
        { playerId: "a", stack: 200 },
        { playerId: "b", stack: 190 },
        { playerId: "c", stack: 210 },
      ],
      buttonPlayerId: "b",
    });
  });

  it("最後の席の Button は先頭の席へ戻る", () => {
    expect(
      seat(nextHandSeating(previous({ a: 200, b: 200, c: 200 }, "c"), config)),
    ).toMatchObject({ kind: "next_hand", buttonPlayerId: "a" });
  });

  it("Bust した Player を除き、残りの席順は保つ", () => {
    expect(
      seat(
        nextHandSeating(
          previous({ a: 100, b: 0, c: 300, d: 0, e: 200 }, "e"),
          config,
        ),
      ),
    ).toEqual({
      kind: "next_hand",
      seats: [
        { playerId: "a", stack: 100 },
        { playerId: "c", stack: 300 },
        { playerId: "e", stack: 200 },
      ],
      buttonPlayerId: "a",
    });
  });

  it("次の席が Bust していれば飛ばす（Dead Button なし）", () => {
    // a の次の b は Bust。時計回りで最初に座っている c が Button。
    expect(
      seat(
        nextHandSeating(
          previous({ a: 200, b: 0, c: 300, d: 100 }, "a"),
          config,
        ),
      ),
    ).toMatchObject({ buttonPlayerId: "c" });
  });

  it("前 Button 本人が Bust しても、その次の生存席へ進める", () => {
    expect(
      seat(
        nextHandSeating(
          previous({ a: 0, b: 200, c: 300, d: 100 }, "a"),
          config,
        ),
      ),
    ).toMatchObject({ buttonPlayerId: "b" });
  });

  it("前 Button と次の席が続けて Bust しても、その先の生存席へ進める", () => {
    expect(
      seat(
        nextHandSeating(
          previous({ a: 0, b: 0, c: 0, d: 600, e: 1 }, "b"),
          config,
        ),
      ),
    ).toMatchObject({ buttonPlayerId: "d" });
  });

  it("残りが 1 人なら次 Hand は無い（残った Player を返す）", () => {
    expect(
      seat(nextHandSeating(previous({ a: 0, b: 600, c: 0 }, "a"), config)),
    ).toEqual({
      kind: "no_next_hand",
      remaining: [{ playerId: "b", stack: 600 }],
    });
  });

  it("残りが 0 人でも次 Hand は無い", () => {
    expect(
      seat(nextHandSeating(previous({ a: 0, b: 0 }, "a"), config)),
    ).toEqual({ kind: "no_next_hand", remaining: [] });
  });

  it.each([
    ["人数が 1", previous({ a: 200 }, "a")],
    [
      "人数が 9",
      previous(Object.fromEntries(range(9).map((i) => [`p${i}`, 1])), "p0"),
    ],
    [
      "席の playerId が重複",
      { ...previous({ a: 200, b: 200 }, "a"), seatOrder: ["a", "a"] },
    ],
    ["Button が卓にいない", previous({ a: 200, b: 200 }, "x")],
    [
      "stacks に席の Player が欠けている",
      {
        ...previous({ a: 200, b: 200 }, "a"),
        stacks: [{ playerId: "a", amount: 400 }],
      },
    ],
    [
      "stacks に卓にいない Player がいる",
      {
        ...previous({ a: 200, b: 200 }, "a"),
        stacks: [
          { playerId: "a", amount: 200 },
          { playerId: "x", amount: 200 },
        ],
      },
    ],
    ["Stack が負", previous({ a: -1, b: 200 }, "a")],
    ["Stack が小数", previous({ a: 1.5, b: 200 }, "a")],
  ])("不正な入力を拒否する: %s", (_, input) => {
    const result = nextHandSeating(input, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_input");
  });

  it("未知の buttonRule を拒否する", () => {
    const result = nextHandSeating(previous({ a: 200, b: 200 }, "a"), {
      buttonRule: "dead_button" as string as ButtonRule,
    });
    expect(result.ok).toBe(false);
  });
});

// ---- 複数 Hand の Scenario（実際に Bust させてから次 Hand を始める） ----

const fold = { type: "fold" } as const;
const check = { type: "check" } as const;
const call = { type: "call" } as const;
const allIn = { type: "all_in" } as const;

interface HandPlay {
  readonly id: string;
  readonly seats: readonly SeatInit[];
  readonly button: string;
  readonly holes: Readonly<Record<string, string>>;
  readonly board: string;
  readonly steps: readonly (readonly [string, PlayerAction])[];
}

interface PlayedHand {
  readonly state: HandState;
  readonly events: readonly HandEvent[];
}

/** Hand を積んだ Deck で始めて Step を順に適用する。各 Step で Invariant と「Event の畳み込み = State」を確かめる。 */
function play(h: HandPlay): PlayedHand {
  const started = startHand({
    handId: h.id,
    seats: h.seats,
    buttonPlayerId: h.button,
    config,
    deal: { deck: stackedDeck(h.seats, h.button, h.holes, h.board) },
  });
  if (!started.ok) throw new Error(started.error.message);
  const total = initialChipTotal(h.seats);
  let state = started.value.state;
  const events: HandEvent[] = [...started.value.events];
  for (const [player, action] of h.steps) {
    const result = applyAction(state, player, action);
    if (!result.ok) {
      throw new Error(`${h.id} ${player} ${action.type}: ${result.error.kind}`);
    }
    state = result.value.state;
    events.push(...result.value.events);
    expect(checkInvariants(state, total)).toEqual([]);
    expect(foldHandEvents(events)).toEqual(state);
  }
  return { state, events };
}

/** Event Log から前 Hand の結果を作る（HAND_STARTED の席順・Button と HAND_FINISHED の stacks）。 */
function resultOf(events: readonly HandEvent[]): PreviousHandResult {
  const started = events.find((e) => e.type === "HAND_STARTED");
  const finished = events.find((e) => e.type === "HAND_FINISHED");
  if (started?.type !== "HAND_STARTED" || finished?.type !== "HAND_FINISHED") {
    throw new Error("Hand が終わっていない");
  }
  return {
    seatOrder: started.seats.map((s) => s.playerId),
    stacks: finished.stacks,
    buttonPlayerId: started.buttonPlayerId,
  };
}

/** 次 Hand が始まる前提で席を取り出す。 */
function nextHand(played: PlayedHand) {
  const next = seat(nextHandSeating(resultOf(played.events), config));
  if (next.kind !== "next_hand") throw new Error("次 Hand が無い");
  return next;
}

/** Blind を誰がいくら出したか（発行順）。 */
function blindsOf(events: readonly HandEvent[]) {
  return events.flatMap((e) =>
    e.type === "BLIND_POSTED"
      ? [{ playerId: e.playerId, blind: e.blind, amount: e.amount }]
      : [],
  );
}

function stacksOf(state: HandState): Record<string, number> {
  return Object.fromEntries(state.players.map((p) => [p.playerId, p.stack]));
}

function actor(state: HandState): string | undefined {
  return getLegalActions(state)?.playerId;
}

describe("Scenario: 次 Hand の席・Button・Blind", () => {
  it("SCN-position-3to2-001: 3 人→Heads-Up 移行。Bust した BB を外し、Heads-Up では Button = SB（docs/02 §5・§7）", () => {
    // Hand 1: Button a・SB b・BB c（Stack 50）。3 人なので Preflop は Button の a が先手。
    const hand1 = play({
      id: "h1",
      seats: [
        { playerId: "a", stack: 200 },
        { playerId: "b", stack: 200 },
        { playerId: "c", stack: 50 },
      ],
      button: "a",
      holes: { b: "As Ad", c: "Kc Kd" },
      board: "2h 7s 9d Jc 3h",
      steps: [
        ["a", fold],
        ["b", allIn],
        ["c", allIn],
      ],
    });
    // b は 200 まで、c は 50 まで出す。誰も Call していない 150 は b へ返す。Pot = 50 + 50 = 100 → b の AA。
    // a 200 / b 200 − 50 + 100 = 250 / c 0（計 450）
    expect(hand1.state.status).toBe("complete");
    expect(stacksOf(hand1.state)).toEqual({ a: 200, b: 250, c: 0 });

    // 次 Hand: c を外して [a, b]。Button は a の次で座っている b。
    const next = nextHand(hand1);
    expect(next).toEqual({
      kind: "next_hand",
      seats: [
        { playerId: "a", stack: 200 },
        { playerId: "b", stack: 250 },
      ],
      buttonPlayerId: "b",
    });

    // Hand 2（Heads-Up）: Button b が SB 1、a が BB 2。Preflop は Button が先手、Postflop は Button が後手。
    const h2 = startHand({
      handId: "h2",
      seats: next.seats,
      buttonPlayerId: next.buttonPlayerId,
      config,
      deal: { seed: 1 },
    });
    if (!h2.ok) throw new Error(h2.error.message);
    expect(blindsOf(h2.value.events)).toEqual([
      { playerId: "b", blind: "small", amount: 1 },
      { playerId: "a", blind: "big", amount: 2 },
    ]);
    let state = h2.value.state;
    expect(actor(state)).toBe("b");
    for (const [player, action] of [
      ["b", call],
      ["a", check],
    ] as const) {
      const r = applyAction(state, player, action);
      if (!r.ok) throw new Error(r.error.kind);
      state = r.value.state;
    }
    expect(state.street).toBe("flop");
    expect(actor(state)).toBe("a");
    const r = applyAction(state, "a", check);
    if (!r.ok) throw new Error(r.error.kind);
    expect(actor(r.value.state)).toBe("b");
  });

  it("SCN-position-button-bust-001: Button 本人が Bust したら、その次の生存席が Button（Dead Button なし。D80）", () => {
    // Hand 1: Button a（Stack 50）・SB b・BB c・UTG d。
    const hand1 = play({
      id: "h1",
      seats: [
        { playerId: "a", stack: 50 },
        { playerId: "b", stack: 200 },
        { playerId: "c", stack: 200 },
        { playerId: "d", stack: 200 },
      ],
      button: "a",
      holes: { a: "Qs Qd", c: "Kc Kd" },
      board: "2h 7s 9d Jc 3h",
      steps: [
        ["d", fold],
        ["a", allIn],
        ["b", fold],
        ["c", call],
      ],
    });
    // Pot = a 50 + b 1 + c 50 = 101 → c の KK。a 0 / b 199 / c 200 − 50 + 101 = 251 / d 200（計 650）
    expect(stacksOf(hand1.state)).toEqual({ a: 0, b: 199, c: 251, d: 200 });

    // 次 Hand: a を外して [b, c, d]。Button は a の次で座っている b。
    const next = nextHand(hand1);
    expect(next).toEqual({
      kind: "next_hand",
      seats: [
        { playerId: "b", stack: 199 },
        { playerId: "c", stack: 251 },
        { playerId: "d", stack: 200 },
      ],
      buttonPlayerId: "b",
    });
    // Hand 2（3 人）: Button b・SB c・BB d。Preflop は Button の b が先手。
    const h2 = startHand({
      handId: "h2",
      seats: next.seats,
      buttonPlayerId: next.buttonPlayerId,
      config,
      deal: { seed: 2 },
    });
    if (!h2.ok) throw new Error(h2.error.message);
    expect(blindsOf(h2.value.events)).toEqual([
      { playerId: "c", blind: "small", amount: 1 },
      { playerId: "d", blind: "big", amount: 2 },
    ]);
    expect(actor(h2.value.state)).toBe("b");
  });

  it("SCN-position-consecutive-bust-001: 同じ Hand で 2 人が Bust し、次の Hand でもう 1 人 Bust して卓が終わる", () => {
    // Hand 1: Button a・SB b（Stack 30）・BB c（Stack 30）・UTG d。
    const hand1 = play({
      id: "h1",
      seats: [
        { playerId: "a", stack: 200 },
        { playerId: "b", stack: 30 },
        { playerId: "c", stack: 30 },
        { playerId: "d", stack: 200 },
      ],
      button: "a",
      holes: { b: "Qs Qd", c: "Kc Kd", d: "As Ad" },
      board: "2h 7s 9d Jc 3h",
      steps: [
        ["d", allIn],
        ["a", fold],
        ["b", allIn],
        ["c", allIn],
      ],
    });
    // d は 200 まで、b・c は 30 まで出す。誰も Call していない 170 は d へ返す。
    // Pot = 30 × 3 = 90 → d の AA。a 200 / b 0 / c 0 / d 200 − 30 + 90 = 260（計 460）
    expect(stacksOf(hand1.state)).toEqual({ a: 200, b: 0, c: 0, d: 260 });

    // 次 Hand: b・c を外して [a, d]。Button は a の次の b・c（Bust）を飛ばして d。Heads-Up なので d が SB。
    const next = nextHand(hand1);
    expect(next).toEqual({
      kind: "next_hand",
      seats: [
        { playerId: "a", stack: 200 },
        { playerId: "d", stack: 260 },
      ],
      buttonPlayerId: "d",
    });

    // Hand 2（Heads-Up）: Button d = SB 1・a が BB 2。d が先手で All-in、a が Call して負ける。
    const hand2 = play({
      id: "h2",
      seats: next.seats,
      button: next.buttonPlayerId,
      holes: { a: "Qh Qc", d: "Ah Ac" },
      board: "2d 7c 9h Js 3d",
      steps: [
        ["d", allIn],
        ["a", call],
      ],
    });
    expect(blindsOf(hand2.events)).toEqual([
      { playerId: "d", blind: "small", amount: 1 },
      { playerId: "a", blind: "big", amount: 2 },
    ]);
    // d は 260 まで、a は 200 まで出す。誰も Call していない 60 は d へ返す。Pot = 400 → d の AA。
    // a 0 / d 260 − 200 + 400 = 460（計 460）
    expect(stacksOf(hand2.state)).toEqual({ a: 0, d: 460 });

    // 残りは d だけなので次 Hand は無い。
    expect(seat(nextHandSeating(resultOf(hand2.events), config))).toEqual({
      kind: "no_next_hand",
      remaining: [{ playerId: "d", stack: 460 }],
    });
  });
});

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
