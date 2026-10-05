import type { LegalActionSet } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { checkOpponentOutput } from "./opponent-output.js";

// Check できる手番（Bet 100〜1000）と、Call が要る手番（Raise 400〜1000）。
const checkOrBet: LegalActionSet = {
  playerId: "cpu1",
  toCall: 0,
  actions: [
    { type: "fold" },
    { type: "check" },
    { type: "bet", min: 100, max: 1000 },
    { type: "all_in", amount: 1000 },
  ],
};
const facingBet: LegalActionSet = {
  playerId: "cpu1",
  toCall: 200,
  actions: [
    { type: "fold" },
    { type: "call", amount: 200 },
    { type: "raise", min: 400, max: 1000 },
    { type: "all_in", amount: 1000 },
  ],
};

describe("checkOpponentOutput（Schema → Legal Action → Amount Range）", () => {
  it("正常な出力を PlayerAction にし、rationale は任意で受け取る", () => {
    expect(checkOpponentOutput({ action: "check" }, checkOrBet)).toEqual({
      ok: true,
      action: { type: "check" },
      rationale: null,
    });
    expect(
      checkOpponentOutput(
        { action: "raise", amount: 400, rationale: "value" },
        facingBet,
      ),
    ).toEqual({
      ok: true,
      action: { type: "raise", amount: 400 },
      rationale: "value",
    });
    expect(
      checkOpponentOutput({ action: "bet", amount: 1000 }, checkOrBet),
    ).toMatchObject({ ok: true, action: { type: "bet", amount: 1000 } });
    expect(checkOpponentOutput({ action: "all_in" }, facingBet)).toMatchObject({
      ok: true,
      action: { type: "all_in" },
    });
  });

  it.each([
    ["オブジェクトでない", "check"],
    ["null", null],
    ["配列", [{ action: "check" }]],
    ["知らない項目", { action: "check", confidence: 0.9 }],
    ["知らない action", { action: "shove" }],
    ["action が無い", {}],
    ["bet に amount が無い", { action: "bet" }],
    ["amount が整数でない", { action: "bet", amount: 150.5 }],
    ["amount が文字列", { action: "bet", amount: "150" }],
    ["check に amount", { action: "check", amount: 0 }],
    ["rationale が文字列でない", { action: "check", rationale: 1 }],
  ])("Schema 違反: %s", (_label, raw) => {
    expect(checkOpponentOutput(raw, checkOrBet)).toMatchObject({
      ok: false,
      stage: "schema",
    });
  });

  it("Schema は満たすが今の手番で選べない種類は Legal Action 違反", () => {
    expect(checkOpponentOutput({ action: "call" }, checkOrBet)).toMatchObject({
      ok: false,
      stage: "legal_action",
    });
    expect(
      checkOpponentOutput({ action: "bet", amount: 400 }, facingBet),
    ).toMatchObject({ ok: false, stage: "legal_action" });
    expect(checkOpponentOutput({ action: "check" }, facingBet)).toMatchObject({
      ok: false,
      stage: "legal_action",
    });
  });

  it("範囲外の額は Amount Range 違反（Legal Action の min〜max を両端含む）", () => {
    for (const amount of [399, 1001, -1, 0]) {
      expect(
        checkOpponentOutput({ action: "raise", amount }, facingBet),
      ).toMatchObject({ ok: false, stage: "amount_range" });
    }
    for (const amount of [400, 1000]) {
      expect(
        checkOpponentOutput({ action: "raise", amount }, facingBet),
      ).toMatchObject({ ok: true });
    }
  });

  it("複数の段に当たる出力は、先の段（Schema）で止める", () => {
    // 知らない項目（Schema）と Check できない（Legal Action）の両方に当たる。
    expect(
      checkOpponentOutput({ action: "check", extra: true }, facingBet),
    ).toMatchObject({ ok: false, stage: "schema" });
  });
});
