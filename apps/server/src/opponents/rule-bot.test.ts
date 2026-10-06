import {
  PHASE1_CASH_PRESET,
  getLegalActions,
  projectKnowledgeState,
  startHand,
  type PlayerAction,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import {
  PERSONA_PRESETS,
  PERSONA_PRESET_IDS,
  type Persona,
  type PersonaPresetId,
} from "./persona.js";
import { RuleBot, tuningFromPersona } from "./rule-bot.js";

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

describe("RuleBot と Persona（#51）", () => {
  /** 最初の Actor（Preflop・BB に直面）の判断を seed 1〜n で集める。Bot は入力ごとに作り直し、乱数の消費の差を混ぜない。 */
  const decisions = (persona: Persona | undefined, n = 400): PlayerAction[] =>
    Array.from({ length: n }, (_, i) =>
      new RuleBot(1000 + i, persona).choose(firstDecisionInput(i + 1)),
    );
  const rate = (actions: PlayerAction[], types: PlayerAction["type"][]) =>
    actions.filter((a) => types.includes(a.type)).length / actions.length;

  it("全軸が平均（0.5）の Persona は、Persona なしと同じしきい値・同じ判断になる（既定の挙動は変えない）", () => {
    const neutral: Persona = {
      ...PERSONA_PRESETS.tag_regular,
      traits: Object.fromEntries(
        Object.keys(PERSONA_PRESETS.tag_regular.traits).map((k) => [k, 0.5]),
      ) as unknown as Persona["traits"],
    };
    expect(tuningFromPersona(neutral)).toEqual({
      strongAggression: 0.6,
      mediumBetFrequency: 0.25,
      mediumRaiseFrequency: 0,
      mediumLooseCall: 0.3,
      weakBluffFrequency: 0.1,
      weakLimpFrequency: 0.3,
      preflopRange: "standard",
    });
    expect(decisions(neutral)).toEqual(decisions(undefined));
  });

  it.each(PERSONA_PRESET_IDS)(
    "%s でも、選ぶ Action は常に Legal Action の中（額も範囲内の整数）",
    (id: PersonaPresetId) => {
      for (let seed = 1; seed <= 200; seed++) {
        const input = firstDecisionInput(seed);
        const action = new RuleBot(seed, PERSONA_PRESETS[id]).choose(input);
        const option = input.legal.actions.find((a) => a.type === action.type);
        expect(option).toBeDefined();
        if (
          (action.type === "bet" || action.type === "raise") &&
          (option?.type === "bet" || option?.type === "raise")
        ) {
          expect(Number.isSafeInteger(action.amount)).toBe(true);
          expect(action.amount).toBeGreaterThanOrEqual(option.min);
          expect(action.amount).toBeLessThanOrEqual(option.max);
        }
      }
    },
  );

  it("Persona で参加 Range と Aggression が変わる: Maniac・Calling Station は Nit より広く参加し、Maniac は Calling Station より Raise が多い", () => {
    const maniac = decisions(PERSONA_PRESETS.maniac);
    const station = decisions(PERSONA_PRESETS.calling_station);
    const nit = decisions(PERSONA_PRESETS.nit);
    const none = decisions(undefined);
    const vpip = (a: PlayerAction[]) => rate(a, ["call", "raise", "bet"]);
    expect(vpip(maniac)).toBeGreaterThan(vpip(none));
    expect(vpip(station)).toBeGreaterThan(vpip(none));
    expect(vpip(nit)).toBeLessThan(vpip(none));
    expect(rate(maniac, ["raise"])).toBeGreaterThan(rate(station, ["raise"]));
    expect(rate(station, ["call"])).toBeGreaterThan(rate(nit, ["call"]));
  });

  it("同じ seed・同じ Persona なら同じ判断列を返す（再現性）", () => {
    expect(decisions(PERSONA_PRESETS.lag, 50)).toEqual(
      decisions(PERSONA_PRESETS.lag, 50),
    );
  });
});
