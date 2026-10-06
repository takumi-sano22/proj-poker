// Ruling Engine の Unit Test。Rule Profile（TableConfig.ruling）の規則ごとに、物理的な操作 → 裁定を確かめる。
// 期待値は手計算（コメントに計算過程）。Hand を通した固定 Scenario は hand-scenarios.test.ts（SCN-ruling-*）。
import { describe, expect, it } from "vitest";
import type { SeatInit } from "./hand-events.js";
import { applyAction, startHand } from "./hand-engine.js";
import type { HandState } from "./hand-state.js";
import type { PlayerAction } from "./legal-actions.js";
import {
  resolveOutOfTurn,
  rulePhysicalActions,
  type Declaration,
  type PhysicalAction,
  type RulingResult,
} from "./ruling.js";
import { PHASE1_CASH_PRESET, type TableConfig } from "./table-config.js";

// Blind 5/10 にして、Full Raise 幅（50% 規則）を Chip の額面で表しやすくする。
const CONFIG: TableConfig = {
  ...PHASE1_CASH_PRESET,
  smallBlind: 5,
  bigBlind: 10,
};

const push = (...chips: number[]): PhysicalAction => ({
  type: "chip_push",
  chips,
});
const add = (...chips: number[]): PhysicalAction => ({
  type: "chip_add",
  chips,
});
const declare = (declaration: Declaration): PhysicalAction => ({
  type: "declare",
  declaration,
});

/** Hand を始めて、Canonical Action を順に適用した State。 */
function play(
  seats: readonly SeatInit[],
  button: string,
  actions: readonly (readonly [string, PlayerAction])[],
): HandState {
  const started = startHand({
    handId: "ruling",
    seats,
    buttonPlayerId: button,
    config: CONFIG,
    deal: { seed: 1 },
  });
  if (!started.ok) throw new Error(started.error.message);
  let state = started.value.state;
  for (const [player, action] of actions) {
    const r = applyAction(state, player, action);
    if (!r.ok) throw new Error(r.error.message);
    state = r.value.state;
  }
  return state;
}

// Heads-Up: cpu が Button（SB 5）、hero が BB（10）。Preflop は cpu から、Postflop は hero から。
const HU = [
  { playerId: "cpu", stack: 1000 },
  { playerId: "hero", stack: 1000 },
];
/** Preflop を Call / Check で終えた Flop（Pot 20・各 Stack 990）。hero が先に行動する。 */
const flop = (): HandState =>
  play(HU, "cpu", [
    ["cpu", { type: "call" }],
    ["hero", { type: "check" }],
  ]);
/** Flop で hero Check → cpu が amount を Bet（hero の Call 額 = amount、Full Raise 幅 = amount）。 */
const facingBet = (amount: number): HandState =>
  play(HU, "cpu", [
    ["cpu", { type: "call" }],
    ["hero", { type: "check" }],
    ["hero", { type: "check" }],
    ["cpu", { type: "bet", amount }],
  ]);

function rule(
  state: HandState,
  actions: readonly PhysicalAction[],
  config: TableConfig = CONFIG,
): RulingResult {
  const r = rulePhysicalActions(state, "hero", actions, config);
  if (!r.ok) throw new Error(r.error.message);
  // 裁定した Canonical Action は必ず合法（D40）。
  if (r.value.kind === "action") {
    expect(applyAction(state, "hero", r.value.action).ok).toBe(true);
  }
  return r.value;
}

describe("Oversized Chip（call_unless_raise_declared。D91）", () => {
  it("相手の Bet 100 に、宣言なしで 500 を 1 枚 → Call", () => {
    expect(rule(facingBet(100), [push(500)])).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: ["oversized_chip"],
    });
  });

  it("Raise を先に宣言（額なし）して 500 を 1 枚 → その Chip の額の Raise（to 500）", () => {
    expect(
      rule(facingBet(100), [declare({ kind: "raise" }), push(500)]),
    ).toEqual({
      kind: "action",
      action: { type: "raise", amount: 500 },
      notes: [],
    });
  });

  it("500 を出した後で Raise と言っても宣言は採らない → Call", () => {
    expect(
      rule(facingBet(100), [push(500), declare({ kind: "raise" })]),
    ).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: ["declaration_ignored", "oversized_chip"],
    });
  });

  it("相手の Bet が無いときに 100 を 1 枚 → 100 の Bet", () => {
    expect(rule(flop(), [push(100)])).toEqual({
      kind: "action",
      action: { type: "bet", amount: 100 },
      notes: [],
    });
  });

  it("相手の Bet が無いときに最小 Bet（10）未満の 5 を 1 枚 → 最小 Bet 10", () => {
    expect(rule(flop(), [push(5)])).toEqual({
      kind: "action",
      action: { type: "bet", amount: 10 },
      notes: ["under_min_bet"],
    });
  });

  it("Call 額ちょうどの Chip 1 枚は普通の Call（Oversized ではない）", () => {
    expect(rule(facingBet(100), [push(100)])).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: [],
    });
  });

  it("Call 額に満たない Chip → Call（足りない分を足させる）", () => {
    expect(rule(facingBet(100), [push(25)])).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: ["under_call"],
    });
  });
});

describe("String Bet（first_motion_only。D91）", () => {
  it("相手の Bet 100 に、100 を出してから 300 を足す → 最初の 100 で Call", () => {
    expect(rule(facingBet(100), [push(100), add(100, 100, 100)])).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: ["string_bet"],
    });
  });

  it("相手の Bet が無いときに 25 + 25 を出してから 100 を足す → 50 の Bet", () => {
    expect(rule(flop(), [push(25, 25), add(100)])).toEqual({
      kind: "action",
      action: { type: "bet", amount: 50 },
      notes: ["string_bet"],
    });
  });

  it("Raise を宣言してから Call 額ちょうど → 続く 1 回まで数える（100 + 100 = to 200）", () => {
    expect(
      rule(facingBet(100), [declare({ kind: "raise" }), push(100), add(100)]),
    ).toEqual({
      kind: "action",
      action: { type: "raise", amount: 200 },
      notes: [],
    });
  });

  it("Raise を宣言しても 3 回目の Chip は数えない（to 200）", () => {
    expect(
      rule(facingBet(100), [
        declare({ kind: "raise" }),
        push(100),
        add(100),
        add(100),
      ]),
    ).toEqual({
      kind: "action",
      action: { type: "raise", amount: 200 },
      notes: ["string_bet"],
    });
  });

  it("Raise を宣言して Call 額を超える 1 回目の後に足した Chip は数えない（to 300）", () => {
    // 1 回目 300 は Call 額 100 と違うので、続く 1 回は数えない。
    expect(
      rule(facingBet(100), [
        declare({ kind: "raise" }),
        push(100, 100, 100),
        add(100),
      ]),
    ).toEqual({
      kind: "action",
      action: { type: "raise", amount: 300 },
      notes: ["string_bet"],
    });
  });
});

describe("Multiple Chip（tda_every_chip_and_half_raise）", () => {
  it("全部の Chip が Call に要る → Call（Bet 120 に 100 + 25：25 を除くと 100 < 120）", () => {
    expect(rule(facingBet(120), [push(100, 25)])).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: ["every_chip_needed"],
    });
  });

  it("上乗せが Full Raise 幅以上 → 出した額の Raise（Bet 100 に 100 + 100 → to 200）", () => {
    expect(rule(facingBet(100), [push(100, 100)])).toEqual({
      kind: "action",
      action: { type: "raise", amount: 200 },
      notes: [],
    });
  });

  it("上乗せが Full Raise 幅の 50% 以上 → 最小 Raise（Bet 100 に 150：上乗せ 50 >= 50 → to 200）", () => {
    expect(rule(facingBet(100), [push(100, 25, 25)])).toEqual({
      kind: "action",
      action: { type: "raise", amount: 200 },
      notes: ["half_raise_completed"],
    });
  });

  it("上乗せが Full Raise 幅の 50% 未満 → Call（Bet 100 に 125：上乗せ 25 < 50）", () => {
    expect(rule(facingBet(100), [push(100, 25)])).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: ["under_half_raise"],
    });
  });

  it("BB の Option（Call 額 0）で 500 を 1 枚 → 出した後の額の Raise（10 + 500 = to 510）", () => {
    const bbOption = play(HU, "cpu", [["cpu", { type: "call" }]]);
    expect(rule(bbOption, [push(500)])).toEqual({
      kind: "action",
      action: { type: "raise", amount: 510 },
      notes: [],
    });
  });

  it("BB の Option で 5 を 1 枚（上乗せ 5 >= 10 の 50%）→ 最小 Raise to 20", () => {
    const bbOption = play(HU, "cpu", [["cpu", { type: "call" }]]);
    expect(rule(bbOption, [push(5)])).toEqual({
      kind: "action",
      action: { type: "raise", amount: 20 },
      notes: ["half_raise_completed"],
    });
  });

  it("BB の Option で 1 を 1 枚（上乗せ 1 < 5）→ Check", () => {
    const bbOption = play(HU, "cpu", [["cpu", { type: "call" }]]);
    expect(rule(bbOption, [push(1)])).toEqual({
      kind: "action",
      action: { type: "check" },
      notes: ["under_half_raise"],
    });
  });

  it("Stack の全部を出したら All-in", () => {
    // hero の Stack 990 = 500 + 100×4 + 25×3 + 5×3。
    const chips = [500, 100, 100, 100, 100, 25, 25, 25, 5, 5, 5];
    expect(rule(facingBet(100), [push(...chips)])).toEqual({
      kind: "action",
      action: { type: "all_in" },
      notes: [],
    });
  });
});

describe("宣言（declaration_first_nearest_legal）", () => {
  it("最小 Raise 未満の額の Raise → 最小 Raise（Bet 100 に to 150 → to 200）", () => {
    expect(
      rule(facingBet(100), [declare({ kind: "raise", amount: 150 })]),
    ).toEqual({
      kind: "action",
      action: { type: "raise", amount: 200 },
      notes: ["declaration_adjusted"],
    });
  });

  it("Stack を超える額の Raise → All-in", () => {
    expect(
      rule(facingBet(100), [declare({ kind: "raise", amount: 5000 })]),
    ).toEqual({
      kind: "action",
      action: { type: "all_in" },
      notes: ["declaration_adjusted"],
    });
  });

  it("宣言の額が Chip と食い違っても宣言どおり（to 300 と言って 100 を 1 枚）", () => {
    expect(
      rule(facingBet(100), [
        declare({ kind: "raise", amount: 300 }),
        push(100),
      ]),
    ).toEqual({
      kind: "action",
      action: { type: "raise", amount: 300 },
      notes: [],
    });
  });

  it("相手の Bet に Bet と言い違えた → 同じ額の Raise", () => {
    expect(
      rule(facingBet(100), [declare({ kind: "bet", amount: 300 })]),
    ).toEqual({
      kind: "action",
      action: { type: "raise", amount: 300 },
      notes: ["declaration_adjusted"],
    });
  });

  it("Bet が無いときの Raise の宣言 → Bet", () => {
    expect(rule(flop(), [declare({ kind: "raise", amount: 50 })])).toEqual({
      kind: "action",
      action: { type: "bet", amount: 50 },
      notes: ["declaration_adjusted"],
    });
  });

  it("Call 額 0 の Call の宣言 → Check", () => {
    expect(rule(flop(), [declare({ kind: "call" })])).toEqual({
      kind: "action",
      action: { type: "check" },
      notes: ["declaration_adjusted"],
    });
  });

  it("相手の Bet があるときの Check の宣言は採らず、Action を決めない", () => {
    expect(rule(facingBet(100), [declare({ kind: "check" })])).toEqual({
      kind: "no_action",
      notes: ["check_facing_bet"],
    });
  });

  it("最初の宣言が拘束する（Fold → Raise と言っても Fold）", () => {
    expect(
      rule(facingBet(100), [
        declare({ kind: "fold" }),
        declare({ kind: "raise", amount: 300 }),
      ]),
    ).toEqual({
      kind: "action",
      action: { type: "fold" },
      notes: ["declaration_ignored"],
    });
  });

  it("額なしの Raise の宣言で Chip が最小額に満たない → 最小 Raise まで足させる", () => {
    expect(
      rule(facingBet(100), [declare({ kind: "raise" }), push(100, 25)]),
    ).toEqual({
      kind: "action",
      action: { type: "raise", amount: 200 },
      notes: ["declaration_adjusted"],
    });
  });

  it("Call の宣言で Chip が多すぎても Call", () => {
    expect(
      rule(facingBet(100), [declare({ kind: "call" }), push(500)]),
    ).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: [],
    });
  });
});

describe("Raise できない局面", () => {
  // cpu の Stack 300。Flop で cpu が All-in 290 → hero から見て相手は全員 All-in なので Raise できない。
  const shortCpu = (): HandState =>
    play(
      [
        { playerId: "cpu", stack: 300 },
        { playerId: "hero", stack: 1000 },
      ],
      "cpu",
      [
        ["cpu", { type: "call" }],
        ["hero", { type: "check" }],
        ["hero", { type: "check" }],
        ["cpu", { type: "all_in" }],
      ],
    );

  it("宣言なしで Raise の額の Chip → Call", () => {
    expect(rule(shortCpu(), [push(500, 100)])).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: ["raise_not_allowed"],
    });
  });

  it("All-in の宣言 → Call", () => {
    expect(rule(shortCpu(), [declare({ kind: "all_in" })])).toEqual({
      kind: "action",
      action: { type: "call" },
      notes: ["raise_not_allowed"],
    });
  });
});

describe("Out-of-Turn（bind_unless_action_changes。D91）", () => {
  // 3 人: btn が Button、sb、hero が BB。Flop は sb → hero → btn。
  const THREE = [
    { playerId: "btn", stack: 1000 },
    { playerId: "sb", stack: 1000 },
    { playerId: "hero", stack: 1000 },
  ];
  const flop3 = (): HandState =>
    play(THREE, "btn", [
      ["btn", { type: "call" }],
      ["sb", { type: "call" }],
      ["hero", { type: "check" }],
    ]);

  it("手番でない操作は保留して警告する（State は変えない）", () => {
    const state = flop3();
    expect(rule(state, [push(100)])).toEqual({
      kind: "out_of_turn",
      pending: {
        playerId: "hero",
        street: "flop",
        currentBet: 0,
        actions: [push(100)],
      },
      notes: ["out_of_turn"],
    });
  });

  it("間の Player が Check だけなら、保留した Bet 100 を拘束する", () => {
    const state = flop3();
    const oot = rule(state, [push(100)]);
    if (oot.kind !== "out_of_turn") throw new Error("保留されていない");
    const r = applyAction(state, "sb", { type: "check" });
    if (!r.ok) throw new Error(r.error.message);
    expect(resolveOutOfTurn(r.value.state, oot.pending, CONFIG)).toEqual({
      ok: true,
      value: {
        kind: "action",
        action: { type: "bet", amount: 100 },
        notes: ["out_of_turn_binding"],
      },
    });
  });

  it("間の Player が Bet したら撤回でき、Hero が選び直す", () => {
    const state = flop3();
    const oot = rule(state, [declare({ kind: "check" })]);
    if (oot.kind !== "out_of_turn") throw new Error("保留されていない");
    const r = applyAction(state, "sb", { type: "bet", amount: 50 });
    if (!r.ok) throw new Error(r.error.message);
    expect(resolveOutOfTurn(r.value.state, oot.pending, CONFIG)).toEqual({
      ok: true,
      value: { kind: "no_action", notes: ["out_of_turn_released"] },
    });
  });

  it("Hero の手番が来る前に resolve すると not_actor", () => {
    const state = flop3();
    const oot = rule(state, [push(100)]);
    if (oot.kind !== "out_of_turn") throw new Error("保留されていない");
    const r = resolveOutOfTurn(state, oot.pending, CONFIG);
    expect(r.ok ? null : r.error.kind).toBe("not_actor");
  });
});

describe("入力の検証", () => {
  const kindOf = (
    state: HandState,
    actions: readonly PhysicalAction[],
    config: TableConfig = CONFIG,
    playerId = "hero",
  ) => {
    const r = rulePhysicalActions(state, playerId, actions, config);
    return r.ok ? null : r.error.kind;
  };

  it.each([
    ["操作が空", []],
    ["額面に無い Chip", [push(50)]],
    ["Chip が空", [push()]],
    ["chip_add から始まる", [add(100)]],
    ["chip_push が 2 回", [push(100), push(100)]],
    ["Stack を超える Chip", [push(500, 500)]],
    ["宣言の額が負", [declare({ kind: "raise", amount: -1 })]],
    ["宣言の額が小数", [declare({ kind: "bet", amount: 1.5 })]],
  ] as const)("%s は invalid_input", (_, actions) => {
    expect(kindOf(facingBet(100), actions)).toBe("invalid_input");
  });

  it("卓にいない Player・Fold 済みの Player は invalid_input", () => {
    expect(kindOf(flop(), [push(100)], CONFIG, "nobody")).toBe("invalid_input");
    // 3 人で btn が Fold した後（Hand は続く）。
    const folded = play(
      [
        { playerId: "btn", stack: 1000 },
        { playerId: "sb", stack: 1000 },
        { playerId: "hero", stack: 1000 },
      ],
      "btn",
      [["btn", { type: "fold" }]],
    );
    expect(kindOf(folded, [push(100)], CONFIG, "btn")).toBe("invalid_input");
  });

  it("終わった Hand は hand_complete", () => {
    const done = play(HU, "cpu", [["cpu", { type: "fold" }]]);
    expect(kindOf(done, [push(100)])).toBe("hand_complete");
  });

  it("未対応の規則は invalid_input", () => {
    const config = {
      ...CONFIG,
      ruling: { ...CONFIG.ruling, stringBet: "x" },
    } as unknown as TableConfig;
    expect(kindOf(flop(), [push(100)], config)).toBe("invalid_input");
  });
});
