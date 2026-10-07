// Drill の変形の選び方（#117・docs/07 §7・D105・D110）。
// - 同じ元の判断・同じ seed からは同じ Drill（変形・Spot・相手の Persona）
// - 候補は種類の順 → 値の順で seed から決まり、Engine の Validation を通る最初の候補を使う。通る候補が無ければ出さない
// - 入力は判断時点の Hero Information Set・seed・卓の設定だけ（ユーザーの弱点は受け取らない）
import {
  heroInformationSets,
  PHASE1_CASH_PRESET,
  type HeroInformationSet,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { LEARNING_HANDS, LEARNING_HERO } from "../testing/learning-fixtures.js";
import { playScriptedHand } from "../testing/review-eval/hands.js";
import {
  buildDrillPlan,
  DEFAULT_DRILL_POLICY,
  orderedDrillCandidates,
  planDrill,
} from "./drill-plan.js";

/** BTN_VS_UTG の Hero の判断（d0 Preflop の Call・d1 Flop で Bet に Call・d2 Turn の Check・d3 River で Bet に Call）。 */
function setOf(index: number): HeroInformationSet {
  const set = heroInformationSets(
    playScriptedHand(LEARNING_HANDS.btn),
    LEARNING_HERO,
  )[index];
  if (set === undefined) throw new Error(`判断 ${index} が無い`);
  return set;
}

describe("planDrill", () => {
  it("同じ元の判断・同じ seed からは同じ Drill になる", () => {
    for (const seed of [1, 2, 3, 42, 2 ** 31]) {
      const a = planDrill(setOf(1), seed, PHASE1_CASH_PRESET);
      const b = planDrill(setOf(1), seed, PHASE1_CASH_PRESET);
      expect(a).not.toBeNull();
      expect(b).toEqual(a);
    }
  });

  it("候補の順は seed で決まり、種類ごとに値がまとまる（どの種類も選ばれうる）", () => {
    const kinds = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const order = orderedDrillCandidates(DEFAULT_DRILL_POLICY, seed);
      expect(order).toHaveLength(2 + 3 + 6);
      // 種類は 3 つの塊で並ぶ（種類が切り替わるのは 2 回だけ）。
      const switches = order.filter(
        (v, i) => i > 0 && v.kind !== order[i - 1]?.kind,
      ).length;
      expect(switches).toBe(2);
      kinds.add(order[0]?.kind ?? "");
    }
    expect(kinds).toEqual(
      new Set(["effective_stack", "bet_size", "opponent_tendency"]),
    );
  });

  it("当てはまらない変形（Bet に直面していない判断の bet_size）は飛ばして、通る変形を使う", () => {
    for (let seed = 0; seed < 20; seed++) {
      const plan = planDrill(setOf(2), seed, PHASE1_CASH_PRESET);
      expect(plan?.variant.kind).not.toBe("bet_size");
    }
    expect(
      buildDrillPlan(
        setOf(2),
        { kind: "bet_size", potFraction: 0.75 },
        1,
        PHASE1_CASH_PRESET,
      ),
    ).toBeNull();
  });

  it("opponent_tendency は Spot を変えず、相手の RuleBot の Persona だけを Drill の設定にする", () => {
    const plan = buildDrillPlan(
      setOf(1),
      { kind: "opponent_tendency", presetId: "calling_station" },
      5,
      PHASE1_CASH_PRESET,
    );
    expect(plan?.persona).toBe("calling_station");
    expect(plan?.spot.delta).toEqual({ kind: "unchanged" });
    const stack = buildDrillPlan(
      setOf(1),
      { kind: "effective_stack", factor: 2 },
      5,
      PHASE1_CASH_PRESET,
    );
    expect(stack?.persona).toBeNull();
  });

  it("Engine の Validation を通る候補が無ければ Drill を出さない（Rule Profile が違う卓）", () => {
    expect(
      planDrill(setOf(1), 1, {
        ...PHASE1_CASH_PRESET,
        ruleProfile: "another_profile",
      }),
    ).toBeNull();
  });
});
