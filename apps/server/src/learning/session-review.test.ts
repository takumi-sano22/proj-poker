// Session Review（#116・docs/07 §6・D49・D111・D115・D116）のテスト。
// - Decision Quality Summary と Score は Pass A の Review 済みの判断だけで計算し、M 件中 N 件を必ず返す（D115）
// - Strength / Leak・Important Hands・Recommended Drill の候補は段階評価と判断時点の情報だけで選び、収支（結果）を見ない
// - Stats は Hero の行だけ、Pass B・Persona・他者の札を応答に入れない
// - Drill の Hand（excludeHandIds）は Hands・M・Stats のどれにも入れない（D116）
import type { HandEvent } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { InMemoryReviewStore } from "../review/review-store.js";
import type { Assessment, ReviewDraft } from "../review/types.js";
import { collectCards, forbiddenKeys } from "../testing/leaks.js";
import {
  LEARNING_HANDS,
  LEARNING_HERO as HERO,
  loadLearningFixtures,
  type PlayedHand as FixtureHand,
} from "../testing/learning-fixtures.js";
import {
  computeSessionReview,
  PHASE6_SESSION_REVIEW_V1,
  type SessionHandRecord,
} from "./session-review.js";

const fixtures = await loadLearningFixtures();

type PlayedHand = FixtureHand & SessionHandRecord;

/** Scripted Hand を最後まで進め、Session の i 番目（2i 分に始まり 1 分で終わる）の Hand にする。 */
function play(
  hand: (typeof LEARNING_HANDS)[keyof typeof LEARNING_HANDS],
  i: number,
): PlayedHand {
  return {
    ...fixtures.play(hand, i),
    startedAt: new Date(Date.UTC(2026, 9, 7, 0, i * 2)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 9, 7, 0, i * 2 + 1)).toISOString(),
  };
}

function review(
  hand: PlayedHand,
  decisionIndex: number,
  assessment: Assessment,
): ReviewDraft {
  return fixtures.review(hand, decisionIndex, assessment);
}

/** Hero の収支（実額）を Event から数え直す（期待値）。 */
function heroNet(events: readonly HandEvent[]): number {
  const started = events.find((e) => e.type === "HAND_STARTED");
  const finished = events.find((e) => e.type === "HAND_FINISHED");
  if (started?.type !== "HAND_STARTED" || finished?.type !== "HAND_FINISHED") {
    return 0;
  }
  const before = started.seats.find((s) => s.playerId === HERO)?.stack ?? 0;
  const after = finished.stacks.find((s) => s.playerId === HERO)?.amount ?? 0;
  return after - before;
}

// Hero の判断の数: BTN_VS_UTG 4・SB_VS_BTN 5・MULTIWAY_FLOP 4 = 13。
const hands = [LEARNING_HANDS.btn, LEARNING_HANDS.sb, LEARNING_HANDS.multi].map(
  (h, i) => play(h, i),
);
const [btn, sb, multi] = hands as [PlayedHand, PlayedHand, PlayedHand];

describe("Session Review（phase6_session_review_v1）", () => {
  it("Review の無い Session は M だけを数え、Score は null で insufficient。Review を作らない（D115）", () => {
    const reviews = new InMemoryReviewStore();
    const result = computeSessionReview(hands, reviews, HERO);
    expect(result.policyVersion).toBe(PHASE6_SESSION_REVIEW_V1.version);
    expect(result.scoringPolicyVersion).toBe("phase6_provisional_v1");
    expect(result.hands).toBe(3);
    expect(result.decisionQuality).toMatchObject({
      total: 13,
      reviewed: 0,
      scored: 0,
      insufficientEvidence: 0,
    });
    expect(result.decisionQuality.overall.score).toBeNull();
    expect(result.decisionQuality.overall.confidence).toBe("insufficient");
    expect(result.strengths).toEqual([]);
    expect(result.leaks).toEqual([]);
    expect(result.recommendedDrill).toEqual({
      available: false,
      candidate: null,
    });
    // 読むだけで、Review を作らない。
    expect(reviews.list(btn.handId, 0, "decision")).toEqual([]);
  });

  it("Hands・Duration・実額の収支・BB を Session の Hand から作る", () => {
    const result = computeSessionReview(hands, new InMemoryReviewStore(), HERO);
    expect(result.startedAt).toBe(btn.startedAt);
    expect(result.endedAt).toBe(multi.endedAt);
    // 0 分に始まり、2 つ目の Hand の 5 分に終わる。
    expect(result.durationMs).toBe(5 * 60 * 1000);
    expect(result.bigBlind).toBe(2);
    expect(result.heroNet).toBe(
      hands.reduce((sum, h) => sum + heroNet(h.events), 0),
    );
  });

  it("M 件中 N 件・段階評価の内訳・Strength / Leak・Drill の候補を Pass A の段階評価から作る", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(review(btn, 0, "strong"));
    reviews.append(review(btn, 1, "improvement_suggested"));
    reviews.append(review(sb, 2, "major_leak"));
    reviews.append(review(sb, 3, "insufficient_evidence"));
    reviews.append(review(multi, 0, "reasonable"));
    const result = computeSessionReview(hands, reviews, HERO);

    expect(result.decisionQuality).toMatchObject({
      total: 13,
      reviewed: 5,
      scored: 4,
      insufficientEvidence: 1,
      assessments: {
        strong: 1,
        reasonable: 1,
        mixed_marginal: 0,
        improvement_suggested: 1,
        major_leak: 1,
        insufficient_evidence: 1,
      },
    });
    // (100 + 35 + 0 + 80) / 4 = 53.8（Confidence は全て high で Weight 1）
    expect(result.decisionQuality.overall).toMatchObject({
      score: 53.8,
      sampleSize: 4,
      confidence: "low",
    });
    expect(
      result.strengths.map((s) => [s.handNumber, s.decisionIndex]),
    ).toEqual([[1, 0]]);
    // Leak は重い段階評価（major_leak）を先に。
    expect(
      result.leaks.map((s) => [s.handNumber, s.decisionIndex, s.assessment]),
    ).toEqual([
      [2, 2, "major_leak"],
      [1, 1, "improvement_suggested"],
    ]);
    expect(result.recommendedDrill).toEqual({
      available: false,
      candidate: result.leaks[0],
    });
    // Leak のある Hand が Important Hands の先頭に来る（同じ数なら Important Spot の多い Hand、Hand の順）。
    expect(result.importantHands[0]).toMatchObject({
      leakCount: 1,
      decisions: { reviewed: expect.any(Number) as number },
    });
    expect(result.importantHands.length).toBeLessThanOrEqual(
      PHASE6_SESSION_REVIEW_V1.maxImportantHands,
    );
  });

  it("Important Hands は収支を見ずに選ぶ（Review の無い Hand も Important Spot があれば入る）", () => {
    const result = computeSessionReview(hands, new InMemoryReviewStore(), HERO);
    for (const h of result.importantHands) {
      expect(h.importantSpotCount).toBeGreaterThan(0);
      expect(h.reasons.length).toBeGreaterThan(0);
      expect(h.heroHoleCards).toHaveLength(2);
      expect(h).not.toHaveProperty("heroNet");
    }
  });

  it("Stats は Hero の行だけを返し、他者の札・Persona・system の記録を応答に入れない", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(review(btn, 0, "strong"));
    const result = computeSessionReview(hands, reviews, HERO);
    expect(result.heroStats.hands).toBe(3);
    expect(result.heroStats.overall?.vpip.opportunities).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('"cpu');
    expect(forbiddenKeys(result)).toEqual([]);
    // 札は Hero 自身の札だけ（Showdown で公開された他者の札も出さない）。
    expect(result.importantHands.length).toBeGreaterThan(0);
    for (const h of result.importantHands) {
      const events = hands.find((p) => p.handId === h.handId)?.events ?? [];
      const own = events.find(
        (e) => e.type === "HOLE_CARD_DEALT" && e.playerId === HERO,
      );
      expect(own?.type === "HOLE_CARD_DEALT" ? own.cards : null).toEqual(
        h.heroHoleCards,
      );
    }
    expect(collectCards(result).length).toBe(result.importantHands.length * 2);
  });

  it("Drill の Hand（excludeHandIds）は Hands・M・Stats・Important Hands のどれにも入れない（D116）", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(review(sb, 2, "major_leak"));
    const result = computeSessionReview(hands, reviews, HERO, {
      excludeHandIds: new Set([sb.handId]),
    });
    expect(result.hands).toBe(2);
    expect(result.decisionQuality).toMatchObject({ total: 8, reviewed: 0 });
    expect(result.heroStats.hands).toBe(2);
    expect(result.leaks).toEqual([]);
    expect(result.importantHands.map((h) => h.handId)).not.toContain(sb.handId);
    // 番号は除いた後の Hand の順（BTN_VS_UTG が 1 つ目、MULTIWAY_FLOP が 2 つ目）。
    for (const h of result.importantHands) {
      expect(h.handNumber).toBe(
        [btn.handId, multi.handId].indexOf(h.handId) + 1,
      );
    }
  });

  it("Hand の無い Session は空の結果を返す", () => {
    const result = computeSessionReview([], new InMemoryReviewStore(), HERO);
    expect(result).toMatchObject({
      hands: 0,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      bigBlind: null,
      heroNet: 0,
      heroStats: { hands: 0, overall: null },
    });
  });
});
