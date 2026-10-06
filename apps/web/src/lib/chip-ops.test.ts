import { DEFAULT_CHIP_DENOMINATIONS } from "@proj-poker/engine";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  MAX_CHIPS_PER_MOTION,
  MAX_OPERATIONS,
  completesTurn,
  countChips,
  declarationOf,
  declare,
  handTotal,
  pickChip,
  pushChip,
  pushHand,
  pushedMotions,
  pushedTotal,
  remainingStack,
  returnHand,
  type TurnDraft,
} from "./chip-ops.js";

/** 手順を順に当てる（Click の列を再現する）。 */
function run(...steps: ((d: TurnDraft) => TurnDraft)[]): TurnDraft {
  return steps.reduce((d, step) => step(d), EMPTY_DRAFT);
}

describe("chip-ops（Hero の 1 回の手番の PhysicalAction を組む）", () => {
  const stack = 200;
  const pick = (v: number) => (d: TurnDraft) => pickChip(d, stack, v);

  it("Click だけで Bet / Raise が完結する: Chip を手に取り（回数が枚数）、Betting Area へ出す → chip_push 1 回", () => {
    const d = run(pick(25), pick(5), pick(5), pushHand);
    expect(d.ops).toEqual([{ type: "chip_push", chips: [25, 5, 5] }]);
    expect(d.hand).toEqual([]);
    expect(pushedTotal(d)).toBe(35);
  });

  it("2 回目以降の動作は chip_add にする（String Bet の判定は裁定に任せ、ここでは止めない）", () => {
    const d = run(
      pick(5),
      pushHand,
      (x) => pushChip(x, stack, 25),
      pick(1),
      pushHand,
    );
    expect(d.ops).toEqual([
      { type: "chip_push", chips: [5] },
      { type: "chip_add", chips: [25] },
      { type: "chip_add", chips: [1] },
    ]);
    expect(pushedMotions(d)).toEqual([[5], [25], [1]]);
  });

  it("宣言なしで大きい Chip を 1 枚出す操作（Oversized Chip）もそのまま組む", () => {
    expect(run((x) => pushChip(x, stack, 100)).ops).toEqual([
      { type: "chip_push", chips: [100] },
    ]);
  });

  it("持っている額を超える Chip は手に取れない・出せない（物理的に出せない操作だけを止める）", () => {
    const d = run(pick(100), pick(100));
    expect(remainingStack(stack, d)).toBe(0);
    expect(pickChip(d, stack, 1)).toBe(d);
    expect(pushChip(d, stack, 1)).toBe(d);
    // 出した分も Stack から引く
    const pushed = pushHand(run(pick(100)));
    expect(remainingStack(stack, pushed)).toBe(100);
    expect(pickChip(pushed, stack, 500)).toBe(pushed);
  });

  it("手に取った Chip は出す前なら戻せる。手が空なら出しても操作を足さない", () => {
    const d = run(pick(25), pick(5), returnHand);
    expect(d).toEqual(EMPTY_DRAFT);
    expect(handTotal(d)).toBe(0);
    expect(pushHand(EMPTY_DRAFT).ops).toEqual([]);
  });

  it("Fold / Check / Call / All-in は宣言で手番が終わり、Bet / Raise は続けて Chip を出す", () => {
    expect(
      (["fold", "check", "call", "all_in"] as const).every(completesTurn),
    ).toBe(true);
    expect(completesTurn("bet")).toBe(false);
    expect(completesTurn("raise")).toBe(false);
  });

  it("Bet / Raise は手に持った Chip があればその額を to 額として宣言し、無ければ額なしで宣言する", () => {
    const holding = run(pick(25), pick(5));
    // この Street に 2 出し済みなら、to 額は 2 + 30
    expect(declarationOf("raise", 2, holding)).toEqual({
      kind: "raise",
      amount: 32,
    });
    expect(declarationOf("bet", 0, EMPTY_DRAFT)).toEqual({ kind: "bet" });
    expect(declarationOf("call", 2, holding)).toEqual({ kind: "call" });
  });

  it("宣言は Chip の前後どちらでも、した順に足す（Chip の後の宣言・2 つ目の宣言も裁定に任せる）", () => {
    const d = run(
      (x) => declare(x, { kind: "raise" }),
      pick(25),
      pushHand,
      (x) => declare(x, { kind: "call" }),
    );
    expect(d.ops).toEqual([
      { type: "declare", declaration: { kind: "raise" } },
      { type: "chip_push", chips: [25] },
      { type: "declare", declaration: { kind: "call" } },
    ]);
  });

  it("サーバーの入力の上限（1 手番 20 操作・1 動作 100 枚）を超える操作は組まない", () => {
    let d = EMPTY_DRAFT;
    for (let i = 0; i < 25; i++) d = pickChip(d, 1000, 1);
    expect(d.hand).toHaveLength(25);
    for (let i = 0; i < 80; i++) d = pickChip(d, 1000, 1);
    expect(d.hand).toHaveLength(MAX_CHIPS_PER_MOTION);
    let ops = EMPTY_DRAFT;
    for (let i = 0; i < 15; i++) ops = pushChip(ops, 1000, 1);
    for (let i = 0; i < 10; i++) ops = declare(ops, { kind: "raise" });
    expect(ops.ops).toHaveLength(MAX_OPERATIONS);
  });

  it("上限の値はサーバーの入力の形（heroPhysicalActionBodySchema の maxItems）と同じ", () => {
    const schema = readFileSync(
      new URL("../../../server/src/routes/hands.ts", import.meta.url),
      "utf8",
    );
    const body = schema.slice(
      schema.indexOf("const heroPhysicalActionBodySchema"),
      schema.indexOf("const outageChoiceBodySchema"),
    );
    expect(
      [...body.matchAll(/maxItems: (\d+)/g)].map((m) => Number(m[1])),
    ).toEqual([MAX_OPERATIONS, MAX_CHIPS_PER_MOTION]);
  });

  it("countChips: 額面ごとの枚数に、大きい額面から並べる（額から組み直さない）", () => {
    expect(
      countChips([5, 500, 5, 1], DEFAULT_CHIP_DENOMINATIONS).map((c) => [
        c.denomination.value,
        c.count,
      ]),
    ).toEqual([
      [500, 1],
      [5, 2],
      [1, 1],
    ]);
  });
});
