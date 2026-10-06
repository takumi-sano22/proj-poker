import { describe, expect, it } from "vitest";
import { cardToString, createDeck, parseCards } from "./card.js";
import type { SeatInit } from "./hand-events.js";
import { applyAction, startHand, type StartHandInput } from "./hand-engine.js";
import { getLegalActions } from "./legal-actions.js";
import { createShuffledDeck } from "./rng.js";
import {
  PHASE1_CASH_PRESET,
  type OddChipRule,
  type ReopenRule,
} from "./table-config.js";

const seats = (n: number, stack = 200): SeatInit[] =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, stack }));

const input = (overrides: Partial<StartHandInput> = {}): StartHandInput => ({
  handId: "h1",
  seats: seats(6),
  buttonPlayerId: "p0",
  config: PHASE1_CASH_PRESET,
  deal: { seed: 42 },
  ...overrides,
});

describe("startHand", () => {
  it("Blind・配布を Event として発行し、Visibility を種別ごとに付ける", () => {
    const result = startHand(input());
    if (!result.ok) throw new Error(result.error.message);
    const { events, state } = result.value;
    expect(events.map((e) => e.type)).toEqual([
      "HAND_STARTED",
      "DECK_SHUFFLED",
      "BLIND_POSTED",
      "BLIND_POSTED",
      ...Array<string>(6).fill("HOLE_CARD_DEALT"),
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Deck（未来の Card）は engine、Hole Cards は本人だけ、それ以外は public。
    for (const e of events) {
      if (e.type === "DECK_SHUFFLED")
        expect(e.visibility).toEqual({ type: "engine" });
      else if (e.type === "HOLE_CARD_DEALT")
        expect(e.visibility).toEqual({ type: "private", playerId: e.playerId });
      else expect(e.visibility).toEqual({ type: "public" });
    }
    // 6 人卓: Button p0 → SB p1・BB p2、Preflop の先手は p3（UTG）
    expect(state.players.map((p) => p.stack)).toEqual([
      200, 199, 198, 200, 200, 200,
    ]);
    expect(state.pot).toBe(3);
    expect(getLegalActions(state)?.playerId).toBe("p3");
  });

  it("8 人卓（上限）: Hole Cards は 8 人分 16 枚で重複せず、Button の左が SB・その次が BB・先手は BB の左（UTG）", () => {
    const result = startHand(input({ seats: seats(8) }));
    if (!result.ok) throw new Error(result.error.message);
    const { events, state } = result.value;
    const dealt = events.filter((e) => e.type === "HOLE_CARD_DEALT");
    expect(dealt).toHaveLength(8); // 1 Event に 2 枚
    const cards = state.players.flatMap((p) =>
      (p.holeCards ?? []).map(cardToString),
    );
    expect(new Set(cards).size).toBe(16);
    expect(state.players.map((p) => p.stack)).toEqual([
      200, 199, 198, 200, 200, 200, 200, 200,
    ]);
    expect(state.pot).toBe(3);
    expect(getLegalActions(state)?.playerId).toBe("p3");
  });

  it("2 人卓（Heads-Up）: Button が SB、先手は Button（Preflop）", () => {
    const result = startHand(input({ seats: seats(2) }));
    if (!result.ok) throw new Error(result.error.message);
    const { state } = result.value;
    expect(state.players.map((p) => p.stack)).toEqual([199, 198]);
    expect(getLegalActions(state)?.playerId).toBe("p0");
  });

  it("seed が同じなら同じ Deck を使い、DECK_SHUFFLED に seed を残す", () => {
    const a = startHand(input());
    const b = startHand(input());
    if (!a.ok || !b.ok) throw new Error("開始できない");
    expect(b.value.events).toEqual(a.value.events);
    const shuffled = a.value.events.find((e) => e.type === "DECK_SHUFFLED");
    expect(shuffled).toMatchObject({ seed: 42, deck: createShuffledDeck(42) });
  });

  it("Hole Cards は Button の左から 1 枚ずつ 2 周で配る", () => {
    const deck = createDeck();
    const result = startHand(input({ seats: seats(3), deal: { deck } }));
    if (!result.ok) throw new Error(result.error.message);
    const hole = (id: string) =>
      result.value.state.players
        .find((p) => p.playerId === id)
        ?.holeCards?.map(cardToString);
    // 新品 Deck は 2c 3c 4c 5c 6c 7c ...。配布順は p1, p2, p0。
    expect(hole("p1")).toEqual(["2c", "5c"]);
    expect(hole("p2")).toEqual(["3c", "6c"]);
    expect(hole("p0")).toEqual(["4c", "7c"]);
  });

  it.each([
    ["人数が 1", { seats: seats(1) }],
    ["人数が 9", { seats: seats(9) }],
    [
      "playerId の重複",
      { seats: [...seats(2), { playerId: "p0", stack: 200 }] },
    ],
    ["Button が卓にいない", { buttonPlayerId: "nobody" }],
    ["Stack が 0", { seats: [...seats(2), { playerId: "x", stack: 0 }] }],
    ["Stack が小数", { seats: [...seats(2), { playerId: "x", stack: 1.5 }] }],
    [
      "BB < SB",
      {
        config: {
          ruleProfile: "x",
          smallBlind: 2,
          bigBlind: 1,
          oddChipRule: "first_left_of_button",
          reopenRule: "cumulative_full_raise",
          buttonRule: "simple_moving",
          chipDenominations: PHASE1_CASH_PRESET.chipDenominations,
          ruling: PHASE1_CASH_PRESET.ruling,
        },
      },
    ],
    [
      "Blind が小数",
      {
        config: {
          ruleProfile: "x",
          smallBlind: 0.5,
          bigBlind: 1,
          oddChipRule: "first_left_of_button",
          reopenRule: "cumulative_full_raise",
          buttonRule: "simple_moving",
          chipDenominations: PHASE1_CASH_PRESET.chipDenominations,
          ruling: PHASE1_CASH_PRESET.ruling,
        },
      },
    ],
    [
      "未知の oddChipRule",
      {
        config: {
          ...PHASE1_CASH_PRESET,
          oddChipRule: "random" as string as OddChipRule,
        },
      },
    ],
    [
      "未知の reopenRule",
      {
        config: {
          ...PHASE1_CASH_PRESET,
          reopenRule: "never" as string as ReopenRule,
        },
      },
    ],
    ["seed が小数", { deal: { seed: 1.5 } }],
    ["Deck が 51 枚", { deal: { deck: createDeck().slice(1) } }],
    [
      "Deck に重複",
      { deal: { deck: [...createDeck().slice(1), ...parseCards("As")] } },
    ],
    ["handId が空", { handId: "" }],
  ] as const)("不正な入力は invalid_input で拒否する: %s", (_, overrides) => {
    const result = startHand(input(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_input");
  });

  it("Heads-Up で Button（SB）の Stack が SB に満たなければ、Blind で All-in して行動なしで Showdown まで進む", () => {
    // p0（Button = SB）は Stack 1 で All-in。BB の p1 の 2 のうち 1 は誰も Call できないので返す。
    const result = startHand(
      input({
        seats: [
          { playerId: "p0", stack: 1 },
          { playerId: "p1", stack: 200 },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    const { events, state } = result.value;
    expect(state.status).toBe("complete");
    expect(state.pot).toBe(0);
    expect(events.filter((e) => e.type === "UNCALLED_BET_RETURNED")).toEqual([
      expect.objectContaining({ playerId: "p1", amount: 1 }),
    ]);
    // Pot は 1 + 1 = 2 の 1 つだけ。Chip 総量は 201 のまま。
    expect(events.filter((e) => e.type === "POT_AWARDED")).toEqual([
      expect.objectContaining({
        potIndex: 0,
        potTotal: 2,
        eligible: ["p1", "p0"],
      }),
    ]);
    expect(state.players.reduce((sum, p) => sum + p.stack, 0)).toBe(201);
  });
});

describe("applyAction", () => {
  it("終わった Hand への Action は hand_complete で拒否する", () => {
    const started = startHand(input({ seats: seats(2) }));
    if (!started.ok) throw new Error(started.error.message);
    const folded = applyAction(started.value.state, "p0", { type: "fold" });
    if (!folded.ok) throw new Error(folded.error.message);
    expect(folded.value.state.status).toBe("complete");
    const again = applyAction(folded.value.state, "p1", { type: "check" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.kind).toBe("hand_complete");
  });

  it.each([
    ["額が小数", { type: "raise", amount: 4.5 }],
    ["額が NaN", { type: "raise", amount: Number.NaN }],
    ["Stack 超過", { type: "raise", amount: 201 }],
    ["Bet が無い局面の Check", { type: "check" }],
    ["Preflop の bet（Raise と呼ぶ局面）", { type: "bet", amount: 4 }],
  ] as const)(
    "不正な Action は illegal_action で拒否し State を変えない: %s",
    (_, action) => {
      const started = startHand(input());
      if (!started.ok) throw new Error(started.error.message);
      const before = started.value.state;
      const result = applyAction(before, "p3", action);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("illegal_action");
      expect(started.value.state).toBe(before);
    },
  );
});
