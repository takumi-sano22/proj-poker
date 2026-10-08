import {
  PHASE1_CASH_PRESET,
  applyAction,
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
import type {
  MemoryItemSummary,
  OpponentMemorySummary,
} from "../memory/memory-summary.js";
import type { TableTendency } from "../memory/table-tendency.js";
import type { OpponentInput } from "./opponent-agent.js";
import {
  memoryAdjustedTuning,
  memoryReadingOf,
  RULEBOT_MEMORY_V1,
  RULEBOT_TABLE_TENDENCY_V1,
  RuleBot,
  tableTendencyAdjustedTuning,
  tiltedPersona,
  tuningFromPersona,
} from "./rule-bot.js";
import type { CpuTilt } from "./tilt.js";
import { PHASE7_TILT_V1 } from "./tilt-policy.js";

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

describe("RuleBot と Memory（#139・D121）", () => {
  type SubjectInput = Record<
    string,
    Partial<Record<string, [number, boolean]>>
  >;

  /** 席ごとに項目 → [割合, 十分か] を持つ Memory の要約。 */
  function memoryOf(subjects: SubjectInput): OpponentMemorySummary {
    return {
      policyVersion: "phase7_memory_v1",
      injectionVersion: "phase7_memory_injection_v1",
      context: "cash",
      subjects: Object.entries(subjects).map(([playerId, items]) => ({
        playerId,
        subject: { kind: "cpu_profile", cpuProfileId: `fixed_${playerId}` },
        handsObserved: 40,
        items: Object.entries(items).map(([item, value]) => ({
          item: item as MemoryItemSummary["item"],
          frequency: value?.[0] ?? 0,
          weightedOpportunities: 30,
          opportunities: 30,
          sufficient: value?.[1] ?? false,
          evidenceCount: 1,
          evidenceIds: ["h0#5"],
        })),
      })),
    };
  }

  /** 最初の Actor が最小額で Raise した後の、次の Actor の入力（Raise に直面している）。 */
  function facingRaise(seed = 1): OpponentInput & { aggressor: string } {
    const result = startHand({
      handId: `r${seed}`,
      seats: ["p1", "p2", "p3", "p4", "p5", "p6"].map((playerId) => ({
        playerId,
        stack: PHASE1_CASH_PRESET.startingStack,
      })),
      buttonPlayerId: "p1",
      config: PHASE1_CASH_PRESET,
      deal: { seed },
    });
    if (!result.ok) throw new Error(result.error.message);
    const first = getLegalActions(result.value.state);
    const raise = first?.actions.find((a) => a.type === "raise");
    if (first === null || raise?.type !== "raise")
      throw new Error("Raise できない");
    const raised = applyAction(result.value.state, first.playerId, {
      type: "raise",
      amount: raise.min,
    });
    if (!raised.ok) throw new Error(raised.error.message);
    const events = [...result.value.events, ...raised.value.events];
    const legal = getLegalActions(raised.value.state);
    if (legal === null) throw new Error("Actor がいない");
    return {
      knowledge: projectKnowledgeState(events, legal.playerId),
      legal,
      aggressor: first.playerId,
    };
  }

  const reading = memoryReadingOf(PERSONA_PRESETS.tag_regular);
  const base = tuningFromPersona(PERSONA_PRESETS.tag_regular);

  it("読みの強さは Skill・Adaptability・Opponent Reading Quality の平均で、Persona なしは 0（Memory を読まない）", () => {
    const t = PERSONA_PRESETS.tag_regular.traits;
    expect(reading).toBeCloseTo(
      (t.skill + t.adaptability + t.opponentReadingQuality) / 3,
      12,
    );
    expect(memoryReadingOf(undefined)).toBe(0);
    const input = facingRaise();
    const knowledge = {
      ...input.knowledge,
      memory: memoryOf({
        [input.aggressor]: { aggression_frequency: [0.9, true] },
      }),
    };
    expect(memoryAdjustedTuning(base, knowledge, 0)).toBe(base);
    expect(memoryAdjustedTuning(base, input.knowledge, reading)).toBe(base);
  });

  it("攻める相手の Raise には medium の Call を広げ、攻めない相手には狭める（ずれは maxShift × 読みの強さまで）", () => {
    const input = facingRaise();
    const tuned = (frequency: number, sufficient = true) =>
      memoryAdjustedTuning(
        base,
        {
          ...input.knowledge,
          memory: memoryOf({
            [input.aggressor]: {
              aggression_frequency: [frequency, sufficient],
            },
          }),
        },
        reading,
      );
    const max = RULEBOT_MEMORY_V1.maxShift * reading;
    expect(tuned(0.95).mediumLooseCall).toBeCloseTo(
      base.mediumLooseCall + max,
      12,
    );
    expect(tuned(0.05).mediumLooseCall).toBeLessThan(base.mediumLooseCall);
    expect(tuned(0.05).mediumLooseCall).toBeGreaterThanOrEqual(
      base.mediumLooseCall - max,
    );
    // 不十分な Sample の項目は読まない。Call 以外のしきい値は変えない。
    expect(tuned(0.95, false)).toEqual(base);
    expect({ ...tuned(0.95), mediumLooseCall: base.mediumLooseCall }).toEqual(
      base,
    );
  });

  it("同額までの All-in（Call と同じ）は Aggressor にせず、額を引き上げた相手の傾向で Call をずらす", () => {
    const input = facingRaise();
    const caller = input.knowledge.seats.find(
      (s) =>
        s.playerId !== input.aggressor &&
        s.playerId !== input.knowledge.viewerId,
    )?.playerId as string;
    const knowledge = {
      ...input.knowledge,
      actionHistory: [
        ...input.knowledge.actionHistory,
        {
          playerId: caller,
          street: input.knowledge.street,
          action: "all_in" as const,
          amount: input.knowledge.currentBet,
          toAmount: input.knowledge.currentBet,
          allIn: true,
        },
      ],
      memory: memoryOf({
        [input.aggressor]: { aggression_frequency: [0.95, true] },
        [caller]: { aggression_frequency: [0.05, true] },
      }),
    };
    expect(
      memoryAdjustedTuning(base, knowledge, reading).mediumLooseCall,
    ).toBeGreaterThan(base.mediumLooseCall);
  });

  it("Postflop の Bluff は、降りていない相手全員の fold_to_cbet_flop が十分なときだけ、一番降りない相手でずらす", () => {
    const input = facingRaise();
    const flop = {
      ...input.knowledge,
      street: "flop" as const,
      board: [
        { rank: 2, suit: "c" },
        { rank: 7, suit: "d" },
        { rank: 11, suit: "h" },
      ] as const,
      actionHistory: [],
      seats: input.knowledge.seats.map((s) => ({
        ...s,
        folded: !["p2", "p3", input.knowledge.viewerId].includes(s.playerId),
      })),
    };
    const tuned = (p2: [number, boolean], p3?: [number, boolean]) =>
      memoryAdjustedTuning(
        base,
        {
          ...flop,
          memory: memoryOf({
            p2: { fold_to_cbet_flop: p2 },
            ...(p3 === undefined ? {} : { p3: { fold_to_cbet_flop: p3 } }),
          }),
        },
        reading,
      );
    const live = ["p2", "p3"].filter((p) => p !== input.knowledge.viewerId);
    expect(live.length).toBeGreaterThan(0);
    const both = (f: [number, boolean]) => tuned(f, f);
    expect(both([0.9, true]).weakBluffFrequency).toBeGreaterThan(
      base.weakBluffFrequency,
    );
    expect(both([0.1, true]).weakBluffFrequency).toBeLessThan(
      base.weakBluffFrequency,
    );
    // 一番降りない相手で決める。誰か 1 人でも不十分なら変えない。
    if (live.length === 2) {
      expect(tuned([0.9, true], [0.1, true]).weakBluffFrequency).toBe(
        both([0.1, true]).weakBluffFrequency,
      );
      expect(tuned([0.9, true], [0.9, false])).toEqual(base);
    }
    // Preflop では Bluff をずらさない。
    expect(
      memoryAdjustedTuning(
        base,
        {
          ...input.knowledge,
          memory: memoryOf({ p2: { fold_to_cbet_flop: [0.9, true] } }),
        },
        reading,
      ).weakBluffFrequency,
    ).toBe(base.weakBluffFrequency);
  });

  it.each(PERSONA_PRESET_IDS)(
    "%s: 極端な Memory でも選ぶ Action は常に Legal Action の中で、同じ入力なら同じ判断（決定論）",
    (id: PersonaPresetId) => {
      for (let seed = 1; seed <= 100; seed++) {
        const input = facingRaise(seed);
        const memory = memoryOf(
          Object.fromEntries(
            input.knowledge.seats.map((s, i) => [
              s.playerId,
              {
                aggression_frequency: [i % 2 === 0 ? 1 : 0, true],
                fold_to_cbet_flop: [i % 2 === 0 ? 0 : 1, true],
              },
            ]),
          ),
        );
        const withMemory = {
          ...input,
          knowledge: { ...input.knowledge, memory },
        };
        const action = new RuleBot(seed, PERSONA_PRESETS[id]).choose(
          withMemory,
        );
        expect(
          new RuleBot(seed, PERSONA_PRESETS[id]).choose(withMemory),
        ).toEqual(action);
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

  it("Persona なしの RuleBot は Memory があっても判断を変えない（D71 の挙動のまま）", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = facingRaise(seed);
      const memory = memoryOf({
        [input.aggressor]: { aggression_frequency: [1, true] },
      });
      expect(
        new RuleBot(seed).choose({
          ...input,
          knowledge: { ...input.knowledge, memory },
        }),
      ).toEqual(new RuleBot(seed).choose(input));
    }
  });
});

describe("RuleBot と Tilt（#140・D107・D119）", () => {
  const tilt = (level: number): CpuTilt => ({
    level,
    maxLevel: PHASE7_TILT_V1.maxLevel,
    policyVersion: PHASE7_TILT_V1.version,
  });
  const decisions = (
    persona: Persona | undefined,
    t: CpuTilt | undefined,
    n = 400,
  ): PlayerAction[] =>
    Array.from({ length: n }, (_, i) => {
      const input = firstDecisionInput(i + 1);
      return new RuleBot(1000 + i, persona).choose(
        t === undefined
          ? input
          : { ...input, knowledge: { ...input.knowledge, tilt: t } },
      );
    });
  const rate = (actions: PlayerAction[], types: PlayerAction["type"][]) =>
    actions.filter((a) => types.includes(a.type)).length / actions.length;

  it("Preflop Looseness と Aggression だけを 1 段 0.05 ずつ上げ、上限は 3 段（+0.15）。他の軸は変えない", () => {
    const nit = PERSONA_PRESETS.nit;
    const t3 = tiltedPersona(nit, tilt(3));
    expect(t3.traits.preflopLooseness).toBeCloseTo(0.3, 10);
    expect(t3.traits.aggression).toBeCloseTo(0.5, 10);
    expect({ ...t3.traits, preflopLooseness: 0, aggression: 0 }).toEqual({
      ...nit.traits,
      preflopLooseness: 0,
      aggression: 0,
    });
    expect(t3.leaks).toEqual(nit.leaks);
    // 範囲外の段は上限で止め、軸は 1 を超えない。
    expect(tiltedPersona(nit, tilt(9))).toEqual(t3);
    expect(
      tiltedPersona(PERSONA_PRESETS.maniac, tilt(3)).traits.aggression,
    ).toBe(1);
    // 知らない Policy の Version は拒否する（黙って別の Policy で反映しない）。
    expect(() =>
      tiltedPersona(nit, { ...tilt(1), policyVersion: "unknown" }),
    ).toThrow(RangeError);
  });

  it("Tilt が上がるほど参加と Raise が増える（同じ seed で比べる）", () => {
    const calm = decisions(PERSONA_PRESETS.tag_regular, undefined);
    const tilted = decisions(PERSONA_PRESETS.tag_regular, tilt(3));
    const vpip = (a: PlayerAction[]) => rate(a, ["call", "raise", "bet"]);
    expect(vpip(tilted)).toBeGreaterThan(vpip(calm));
    expect(rate(tilted, ["raise", "bet"])).toBeGreaterThanOrEqual(
      rate(calm, ["raise", "bet"]),
    );
  });

  it.each(PERSONA_PRESET_IDS)(
    "%s が Tilt 3 でも、選ぶ Action は常に Legal Action の中（額も範囲内の整数）",
    (id: PersonaPresetId) => {
      for (let seed = 1; seed <= 200; seed++) {
        const input = firstDecisionInput(seed);
        const action = new RuleBot(seed, PERSONA_PRESETS[id]).choose({
          ...input,
          knowledge: { ...input.knowledge, tilt: tilt(3) },
        });
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

  it("Persona なしの RuleBot は Tilt があっても判断を変えない。同じ seed・同じ Tilt なら同じ判断列（再現性）", () => {
    expect(decisions(undefined, tilt(3), 100)).toEqual(
      decisions(undefined, undefined, 100),
    );
    expect(decisions(PERSONA_PRESETS.lag, tilt(2), 50)).toEqual(
      decisions(PERSONA_PRESETS.lag, tilt(2), 50),
    );
  });
});

describe("RuleBot と Table Tendency（#141）", () => {
  /** vpip と aggression_frequency の割合で Table Tendency を作る（sufficient は両方に同じ値）。 */
  const tendency = (
    vpip: number,
    aggression: number,
    sufficient = true,
  ): TableTendency => ({
    policyVersion: "phase7_table_tendency_v1",
    hands: 20,
    items: [
      { item: "vpip", rate: vpip },
      { item: "aggression_frequency", rate: aggression },
    ].map(({ item, rate }) => ({
      item: item as "vpip" | "aggression_frequency",
      policyVersion: "phase7_table_tendency_v1",
      numerator: rate * 100,
      denominator: 100,
      hands: 20,
      sufficient,
    })),
  });
  const base = tuningFromPersona(PERSONA_PRESETS.tag_regular);
  const withTendency = (t: TableTendency) => {
    const input = firstDecisionInput(1);
    return { ...input.knowledge, tableTendency: t };
  };

  it("攻める卓では medium の Call を広げ、緩い卓では weak の Bluff を減らす（ずれは maxShift × Adaptability まで）", () => {
    const wild = tableTendencyAdjustedTuning(
      base,
      withTendency(tendency(0.9, 0.9)),
      1,
    );
    expect(wild.mediumLooseCall).toBeCloseTo(
      base.mediumLooseCall + RULEBOT_TABLE_TENDENCY_V1.maxShift,
      10,
    );
    expect(wild.weakBluffFrequency).toBeCloseTo(
      Math.max(0, base.weakBluffFrequency - RULEBOT_TABLE_TENDENCY_V1.maxShift),
      10,
    );
    const tight = tableTendencyAdjustedTuning(
      base,
      withTendency(tendency(0.1, 0.1)),
      0.5,
    );
    expect(tight.mediumLooseCall).toBeLessThan(base.mediumLooseCall);
    expect(tight.weakBluffFrequency).toBeGreaterThan(base.weakBluffFrequency);
    expect(
      base.weakBluffFrequency + 0.5 * RULEBOT_TABLE_TENDENCY_V1.maxShift,
    ).toBeGreaterThanOrEqual(tight.weakBluffFrequency);
    // ほかのしきい値は変えない。
    expect({ ...wild, mediumLooseCall: 0, weakBluffFrequency: 0 }).toEqual({
      ...base,
      mediumLooseCall: 0,
      weakBluffFrequency: 0,
    });
  });

  it("Table Tendency が無い・Sample が足りない・Adaptability が 0 なら元のまま", () => {
    const input = firstDecisionInput(1);
    expect(tableTendencyAdjustedTuning(base, input.knowledge, 1)).toEqual(base);
    expect(
      tableTendencyAdjustedTuning(
        base,
        withTendency(tendency(0.9, 0.9, false)),
        1,
      ),
    ).toEqual(base);
    expect(
      tableTendencyAdjustedTuning(base, withTendency(tendency(0.9, 0.9)), 0),
    ).toEqual(base);
  });

  it("Table Tendency があっても選ぶ Action は Legal Action の中。Persona なしは判断を変えない。同じ入力なら同じ判断列", () => {
    const run = (persona: Persona | undefined, t: TableTendency | undefined) =>
      Array.from({ length: 100 }, (_, i) => {
        const input = firstDecisionInput(i + 1);
        const knowledge =
          t === undefined
            ? input.knowledge
            : { ...input.knowledge, tableTendency: t };
        const action = new RuleBot(500 + i, persona).choose({
          ...input,
          knowledge,
        });
        expect(input.legal.actions.map((a) => a.type)).toContain(action.type);
        return action;
      });
    expect(run(undefined, tendency(0.9, 0.9))).toEqual(
      run(undefined, undefined),
    );
    expect(run(PERSONA_PRESETS.lag, tendency(0.9, 0.9))).toEqual(
      run(PERSONA_PRESETS.lag, tendency(0.9, 0.9)),
    );
  });
});
