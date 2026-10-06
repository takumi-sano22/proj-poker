// Range Model の席の名前と Preflop の Action 列の分類のテスト（公開された Action の履歴だけを入力にする）。
import { describe, expect, it } from "vitest";
import type { PublicActionRecord } from "./projection.js";
import { classifyPreflop, positionName } from "./range-model.js";

describe("positionName", () => {
  it.each([
    // 6-max: Button から BTN・SB・BB・UTG・HJ・CO。
    [6, ["BTN", "SB", "BB", "UTG", "HJ", "CO"]],
    // Heads-Up: Button（= SB）は BTN、相手は BB。
    [2, ["BTN", "BB"]],
    [3, ["BTN", "SB", "BB"]],
    [4, ["BTN", "SB", "BB", "CO"]],
    [5, ["BTN", "SB", "BB", "HJ", "CO"]],
    // 8 人: BB の後の 3 席は Early Position として UTG にまとめる。
    [8, ["BTN", "SB", "BB", "UTG", "UTG", "UTG", "HJ", "CO"]],
  ])("%i 人の卓", (count, names) => {
    expect(
      Array.from({ length: count }, (_, i) => positionName(i, count)),
    ).toEqual(names);
  });
});

/** Preflop の公開 Action（toAmount は Street の累計）。 */
const pre = (
  playerId: string,
  action: PublicActionRecord["action"],
  toAmount = 0,
): PublicActionRecord => ({
  playerId,
  street: "preflop",
  action,
  amount: toAmount,
  toAmount,
  allIn: action === "all_in",
});

describe("classifyPreflop", () => {
  const BB = 2;

  it("最初の Raise は open、それへの Call は call_open、Raise は three_bet", () => {
    const history = [
      pre("utg", "fold"),
      pre("co", "raise", 6),
      pre("btn", "call", 6),
      pre("sb", "raise", 20),
    ];
    expect(classifyPreflop(history, "co", BB)).toBe("open");
    expect(classifyPreflop(history, "btn", BB)).toBe("call_open");
    expect(classifyPreflop(history, "sb", BB)).toBe("three_bet");
    expect(classifyPreflop(history, "bb", BB)).toBe("not_acted");
  });

  it("3-Bet への Call は call_three_bet、Raise は four_bet_plus（最後の Action で決める）", () => {
    const history = [
      pre("co", "raise", 6),
      pre("btn", "raise", 18),
      pre("bb", "call", 18),
      pre("co", "raise", 45),
    ];
    expect(classifyPreflop(history, "bb", BB)).toBe("call_three_bet");
    expect(classifyPreflop(history, "co", BB)).toBe("four_bet_plus");
    expect(classifyPreflop(history, "btn", BB)).toBe("three_bet");
  });

  it("Raise の無い Pot の Call は limp、BB の Check は check_option、Limp への Raise は open", () => {
    expect(
      classifyPreflop(
        [pre("utg", "call", 2), pre("bb", "check", 2)],
        "utg",
        BB,
      ),
    ).toBe("limp");
    expect(
      classifyPreflop([pre("utg", "call", 2), pre("bb", "check", 2)], "bb", BB),
    ).toBe("check_option");
    expect(
      classifyPreflop(
        [pre("utg", "call", 2), pre("bb", "raise", 10)],
        "bb",
        BB,
      ),
    ).toBe("open");
  });

  it("All-in は最高額を超えれば Raise、届かなければ Call として数える", () => {
    // 最高額 6 に対する 5 の All-in（Short）は Call 扱い、30 の All-in は 3-Bet。
    const history = [
      pre("co", "raise", 6),
      pre("btn", "all_in", 5),
      pre("sb", "all_in", 30),
    ];
    expect(classifyPreflop(history, "btn", BB)).toBe("call_open");
    expect(classifyPreflop(history, "sb", BB)).toBe("three_bet");
  });

  it("Postflop の Action は Preflop の分類に使わない", () => {
    const history: PublicActionRecord[] = [
      pre("co", "raise", 6),
      pre("btn", "call", 6),
      { ...pre("btn", "bet", 8), street: "flop" },
    ];
    expect(classifyPreflop(history, "btn", BB)).toBe("call_open");
  });
});
