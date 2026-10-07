// Player Profile（docs/07 §4・D104・D111・D115・D116）のテスト。Structured Profile が正本で、自然言語は決定論のテンプレート文。
import { describe, expect, it } from "vitest";
import { InMemoryReviewStore } from "../review/review-store.js";
import {
  LEARNING_HANDS,
  LEARNING_HERO,
  loadLearningFixtures,
  type PlayedHand,
} from "../testing/learning-fixtures.js";
import { buildHypotheses } from "./hypothesis.js";
import {
  DEFAULT_PROFILE_POLICY,
  computePlayerProfile,
  renderProfileText,
  type ProfilePolicy,
} from "./profile.js";
import { computeScoreReport } from "./score.js";

const fx = await loadLearningFixtures();

/**
 * BTN_VS_UTG を 4 回: 古い 2 Hand の d1（Flop で Bet に Call）は major_leak、新しい 2 Hand の d1 は strong。
 * Hero の判断は Hand ごとに 4 つ（M = 16）、Review 済みは 4（N = 4）。
 */
function input() {
  const hands: PlayedHand[] = [0, 1, 2, 3].map((r) =>
    fx.play(LEARNING_HANDS.btn, r),
  );
  const reviews = new InMemoryReviewStore();
  hands.forEach((h, i) => {
    reviews.append(fx.review(h, 1, i < 2 ? "major_leak" : "strong"));
  });
  return { hands: hands.map((h) => h.events), reviews, heroId: LEARNING_HERO };
}

const recentTwo: ProfilePolicy = {
  ...DEFAULT_PROFILE_POLICY,
  version: "test_recent_2",
  recentDecisions: 2,
};

describe("Player Profile", () => {
  it("Recent は直近 100 の有効 Decision（Config の暫定値）", () => {
    expect(DEFAULT_PROFILE_POLICY.recentDecisions).toBe(100);
    const profile = computePlayerProfile(input());
    expect(profile).toMatchObject({
      policyVersion: "phase6_profile_v1",
      hypothesisPolicyVersion: "phase6_hypothesis_v1",
      scoringPolicyVersion: "phase6_provisional_v1",
      heroId: LEARNING_HERO,
      decisions: { total: 16, reviewed: 4 },
      recent: { window: 100, reviewed: 4 },
      longTerm: { reviewed: 4 },
    });
    // 有効 Decision が窓より少なければ、Recent と Long-term は同じ集計。
    expect(profile.recent.overall).toEqual(profile.longTerm.overall);
  });

  it("Recent（直近の有効 Decision）と Long-term（全有効 Evidence）を分けて集計する", () => {
    const profile = computePlayerProfile(input(), { policy: recentTwo });
    expect(profile.recent).toMatchObject({
      window: 2,
      reviewed: 2,
      overall: { score: 100, sampleSize: 2 },
    });
    expect(profile.longTerm).toMatchObject({
      reviewed: 4,
      overall: { score: 50, sampleSize: 4 },
    });
    // Long-term の集計は #113 の Score と同じ。
    const report = computeScoreReport(input());
    expect(profile.longTerm.overall).toEqual(report.overall);
    expect(profile.longTerm.abilities).toEqual(report.abilities);
  });

  it("Hypothesis は同じ Evidence から作る（Snapshot と同じ関数）", () => {
    const profile = computePlayerProfile(input());
    expect(profile.hypotheses).toEqual(buildHypotheses(input()));
    expect(profile.hypotheses.map((h) => [h.type, h.status])).toEqual([
      ["postflop_facing_bet", "supported"],
    ]);
  });

  it("同じ Evidence からは同じ Profile と同じ文になる", () => {
    const a = computePlayerProfile(input());
    const b = computePlayerProfile(input());
    expect(b).toEqual(a);
    expect(renderProfileText(b)).toBe(renderProfileText(a));
  });

  it("自然言語の Profile は Structured Profile だけから作るテンプレート文（LLM を呼ばない）", () => {
    const profile = computePlayerProfile(input(), { policy: recentTwo });
    expect(renderProfileText(profile)).toBe(
      [
        "Review 済みの判断 4 件（対象の判断 16 件中）から作った Profile です。",
        "直近 2 件の Overall: 100 点（Confidence low・2 件）",
        "全期間の Overall: 50 点（Confidence low・4 件）",
        "未解決の弱点の仮説: Flop 以降で Bet に直面した場面（裏付けあり・支持 2 件 / 反証 2 件）",
      ].join("\n"),
    );
    // Structured Profile は文を持たない（過去の自然言語を次の計算の入力にしない）。
    expect(Object.keys(profile)).not.toContain("text");
  });

  it("Review の無い Hero の Profile は数えられる判断が無いことを示す", () => {
    const hands = [fx.play(LEARNING_HANDS.btn, 0)];
    const profile = computePlayerProfile({
      hands: hands.map((h) => h.events),
      reviews: new InMemoryReviewStore(),
      heroId: LEARNING_HERO,
    });
    expect(profile.decisions).toEqual({ total: 4, reviewed: 0 });
    expect(profile.hypotheses).toEqual([]);
    expect(renderProfileText(profile)).toContain(
      "直近 0 件の Overall: まだ数えられる判断がありません",
    );
  });

  it("除外した Hand（Drill。D116）は M・N・Profile に入れない", () => {
    const profile = computePlayerProfile(input(), {
      excludeHandIds: new Set(["review-btn_vs_utg_0", "review-btn_vs_utg_1"]),
    });
    expect(profile.decisions).toEqual({ total: 8, reviewed: 2 });
    expect(profile.longTerm.overall.score).toBe(100);
    expect(profile.hypotheses).toEqual([]);
  });
});
