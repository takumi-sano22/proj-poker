import {
  PHASE1_CASH_PRESET,
  getLegalActions,
  projectKnowledgeState,
  startHand,
  type PlayerAction,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { RuleBot } from "./rule-bot.js";

/** 6 人卓を seed で開始し、最初の Actor の入力を作る。 */
function firstDecisionInput(seed: number) {
  const result = startHand({
    handId: `h${seed}`,
    seats: ["p1", "p2", "p3", "p4", "p5", "p6"].map((playerId) => ({
      playerId,
      stack: PHASE1_CASH_PRESET.startingStack,
    })),
    buttonPlayerId: "p1",
    config: PHASE1_CASH_PRESET,
    deal: { seed },
  });
  if (!result.ok) throw new Error(result.error.message);
  const legal = getLegalActions(result.value.state);
  if (legal === null) throw new Error("Actor がいない");
  return {
    knowledge: projectKnowledgeState(result.value.events, legal.playerId),
    legal,
  };
}

describe("RuleBot", () => {
  it("同じ seed・同じ入力なら同じ判断列を返す（再現性）", () => {
    const decide = (botSeed: number): PlayerAction[] => {
      const bot = new RuleBot(botSeed);
      return Array.from({ length: 30 }, (_, i) =>
        bot.choose(firstDecisionInput(i + 1)),
      );
    };
    expect(decide(7)).toEqual(decide(7));
  });

  it("選ぶ Action の種類は常に Legal Action に含まれる", () => {
    const bot = new RuleBot(3);
    for (let seed = 1; seed <= 200; seed++) {
      const input = firstDecisionInput(seed);
      const action = bot.choose(input);
      const option = input.legal.actions.find((a) => a.type === action.type);
      expect(option).toBeDefined();
      if (
        (action.type === "bet" || action.type === "raise") &&
        (option?.type === "bet" || option?.type === "raise")
      ) {
        expect(action.amount).toBeGreaterThanOrEqual(option.min);
        expect(action.amount).toBeLessThanOrEqual(option.max);
        expect(Number.isSafeInteger(action.amount)).toBe(true);
      }
    }
  });

  it("decide は choose と同じ判断を OpponentOutput の形（action・bet / raise だけ amount）で返す", async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = firstDecisionInput(seed);
      const expected = new RuleBot(seed).choose(input);
      const output = await new RuleBot(seed).decide(input);
      expect(output).toEqual(
        "amount" in expected
          ? { action: expected.type, amount: expected.amount }
          : { action: expected.type },
      );
    }
  });
});
