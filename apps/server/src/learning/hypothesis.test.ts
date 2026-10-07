// Weakness Hypothesis と HypothesisPolicy phase6_hypothesis_v1 のテスト（docs/07 §5・docs/04 §7・D104・D113・D115・D116）。
import { describe, expect, it } from "vitest";
import { InMemoryReviewStore } from "../review/review-store.js";
import type { Assessment } from "../review/types.js";
import {
  LEARNING_HANDS,
  LEARNING_HERO,
  loadLearningFixtures,
  type PlayedHand,
} from "../testing/learning-fixtures.js";
import { buildHypotheses, hypothesisStatus } from "./hypothesis.js";
import {
  HYPOTHESIS_POLICIES,
  PHASE6_HYPOTHESIS_V1,
  type HypothesisStatus,
} from "./hypothesis-policy.js";
import type { DecisionFeatures } from "./scoring-policy.js";

const fx = await loadLearningFixtures();

/** BTN_VS_UTG の d1（Flop で Bet に Call。postflop_facing_bet）を、Assessment の列の数だけ別の Hand で繰り返す。 */
function facingBetSeries(assessments: readonly Assessment[]) {
  const hands: PlayedHand[] = assessments.map((_, i) =>
    fx.play(LEARNING_HANDS.btn, i),
  );
  const reviews = new InMemoryReviewStore();
  assessments.forEach((a, i) => {
    reviews.append(fx.review(hands[i] as PlayedHand, 1, a));
  });
  return { hands: hands.map((h) => h.events), reviews, heroId: LEARNING_HERO };
}

function statusOf(assessments: readonly Assessment[]): HypothesisStatus {
  const found = buildHypotheses(facingBetSeries(assessments)).find(
    (h) => h.type === "postflop_facing_bet",
  );
  if (found === undefined) throw new Error("Hypothesis が無い");
  return found.status;
}

const features = (patch: Partial<DecisionFeatures>): DecisionFeatures => ({
  street: "flop",
  action: "check",
  callAmount: 0,
  aggressive: false,
  preflopUnraised: false,
  rulingNotes: [],
  ...patch,
});

describe("HypothesisPolicy phase6_hypothesis_v1", () => {
  it("判断を判断時点の特徴だけから type に分ける（額を引き上げた判断は bet_raise にも入る）", () => {
    const classify = (f: DecisionFeatures) => PHASE6_HYPOTHESIS_V1.classify(f);
    expect(
      classify(
        features({
          street: "preflop",
          preflopUnraised: true,
          aggressive: true,
        }),
      ),
    ).toEqual(["preflop_unraised", "bet_raise"]);
    expect(classify(features({ street: "preflop", callAmount: 30 }))).toEqual([
      "preflop_facing_raise",
    ]);
    expect(classify(features({ street: "river", callAmount: 50 }))).toEqual([
      "postflop_facing_bet",
    ]);
    expect(classify(features({ street: "turn" }))).toEqual(["postflop_unbet"]);
    expect(HYPOTHESIS_POLICIES[PHASE6_HYPOTHESIS_V1.version]).toBe(
      PHASE6_HYPOTHESIS_V1,
    );
  });

  it("状態は Supporting / Counter の数と割合・直近の窓で決まる（暫定のしきい値）", () => {
    const status = (pattern: string) =>
      hypothesisStatus(
        [...pattern].map((c) => c === "L"),
        PHASE6_HYPOTHESIS_V1,
      );
    expect(status("LL")).toBe("insufficient_data");
    expect(status("LCC")).toBe("suspected");
    expect(status("LLC")).toBe("supported");
    expect(status("LLLL")).toBe("strong");
    // 割合が strong に届かなければ supported。
    expect(status("LLLLCCC")).toBe("supported");
    // 窓（直近 5 件）より古い Evidence があり、直近の Supporting が 1 件以下なら improving、0 件なら resolved。
    expect(status("LLCCCLCLC")).toBe("supported");
    expect(status("LLLCLCCCC")).toBe("improving");
    expect(status("LLLCCCCCC")).toBe("resolved");
    // suspected は improving にしない（もともと弱い疑い）。
    expect(status("LCCCCCL")).toBe("suspected");
  });
});

describe("Weakness Hypothesis", () => {
  it("Counter Evidence が増えると状態が弱くなる（strong → supported → improving → resolved）", () => {
    const leaks: Assessment[] = [
      "major_leak",
      "improvement_suggested",
      "major_leak",
      "improvement_suggested",
    ];
    const statuses: HypothesisStatus[] = [];
    for (let counters = 0; counters <= 5; counters++) {
      statuses.push(
        statusOf([...leaks, ...Array<Assessment>(counters).fill("reasonable")]),
      );
    }
    expect(statuses).toEqual([
      "strong",
      "strong",
      "strong",
      "supported",
      "improving",
      "resolved",
    ]);
    // 弱さの順（strong が最も強い疑い）で、Counter Evidence を足して強くなることはない。
    const rank: Record<HypothesisStatus, number> = {
      strong: 4,
      supported: 3,
      suspected: 2,
      improving: 1,
      resolved: 0,
      insufficient_data: -1,
    };
    for (let i = 1; i < statuses.length; i++) {
      expect(rank[statuses[i] as HypothesisStatus]).toBeLessThanOrEqual(
        rank[statuses[i - 1] as HypothesisStatus],
      );
    }
  });

  it("Supporting / Counter Evidence を Ability Evidence の ID で持ち、Policy の Version を残す", () => {
    const source = facingBetSeries([
      "major_leak",
      "strong",
      "mixed_marginal",
      "insufficient_evidence",
      "improvement_suggested",
    ]);
    const [hypothesis] = buildHypotheses(source);
    const id = (round: number) => `review-btn_vs_utg_${round}/d1/v1`;
    expect(hypothesis).toEqual({
      hypothesisId: "phase6_hypothesis_v1/postflop_facing_bet",
      type: "postflop_facing_bet",
      status: "supported",
      // mixed_marginal はどちらにも数えず、insufficient_evidence（点が無い）は数えない。
      supportingEvidenceIds: [id(0), id(4)],
      counterEvidenceIds: [id(1)],
      policyVersion: "phase6_hypothesis_v1",
    });
  });

  it("Supporting Evidence の無い type は Hypothesis にしない", () => {
    const source = facingBetSeries(["strong", "reasonable", "mixed_marginal"]);
    expect(buildHypotheses(source)).toEqual([]);
  });

  it("同じ Evidence からは同じ Hypothesis になる（Review を足した順に依らない）", () => {
    const hands = [0, 1, 2].map((r) => fx.play(LEARNING_HANDS.btn, r));
    const sb = fx.play(LEARNING_HANDS.sb, 0);
    const drafts = [
      fx.review(hands[0] as PlayedHand, 1, "major_leak"),
      fx.review(hands[1] as PlayedHand, 0, "major_leak"),
      fx.review(hands[1] as PlayedHand, 1, "improvement_suggested"),
      fx.review(hands[2] as PlayedHand, 1, "reasonable"),
      fx.review(sb, 2, "major_leak"),
    ];
    const source = (order: typeof drafts) => {
      const reviews = new InMemoryReviewStore();
      for (const d of order) reviews.append(d);
      return {
        hands: [...hands.map((h) => h.events), sb.events],
        reviews,
        heroId: LEARNING_HERO,
      };
    };
    const first = buildHypotheses(source(drafts));
    expect(buildHypotheses(source([...drafts].reverse()))).toEqual(first);
    // Policy の type の順に返す。
    expect(first.map((h) => [h.type, h.status])).toEqual([
      ["preflop_facing_raise", "insufficient_data"],
      ["postflop_facing_bet", "supported"],
      ["postflop_unbet", "insufficient_data"],
      ["bet_raise", "insufficient_data"],
    ]);
  });

  it("同じ判断に複数の Version があれば最新だけを使う（D115）", () => {
    const hand = fx.play(LEARNING_HANDS.btn, 0);
    const reviews = new InMemoryReviewStore();
    reviews.append(fx.review(hand, 1, "major_leak"));
    reviews.append(fx.review(hand, 1, "strong"));
    const [h] = [
      ...buildHypotheses({
        hands: [hand.events],
        reviews,
        heroId: LEARNING_HERO,
      }),
    ];
    // 最新（v2）が strong なので、Supporting が無く Hypothesis にならない。
    expect(h).toBeUndefined();
  });

  it("除外した Hand（Drill。D116）の Evidence は入れない", () => {
    const source = facingBetSeries([
      "major_leak",
      "major_leak",
      "major_leak",
      "reasonable",
    ]);
    const all = buildHypotheses(source);
    expect(all[0]?.supportingEvidenceIds).toHaveLength(3);
    const excluded = buildHypotheses(source, {
      excludeHandIds: new Set(["review-btn_vs_utg_0", "review-btn_vs_utg_1"]),
    });
    expect(excluded[0]).toMatchObject({
      status: "insufficient_data",
      supportingEvidenceIds: ["review-btn_vs_utg_2/d1/v1"],
      counterEvidenceIds: ["review-btn_vs_utg_3/d1/v1"],
    });
  });
});
