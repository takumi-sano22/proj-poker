// Ability Evidence と ScoringPolicy phase6_provisional_v1 の Score のテスト（docs/07 §2・D103・D48・D115・D116・D111）。
import {
  heroInformationSets,
  type HandEvent,
  type RulingCode,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { loadKb } from "../kb/index.js";
import { buildReviewEvidence, evidenceIdsOf } from "../review/evidence.js";
import { InMemoryRevealReviewStore } from "../review/reveal-store.js";
import { InMemoryReviewStore } from "../review/review-store.js";
import type {
  Assessment,
  Confidence,
  ReviewDepth,
  ReviewDraft,
  ReviewEvidence,
} from "../review/types.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import {
  BTN_VS_UTG,
  MULTIWAY_FLOP,
  SB_VS_BTN,
  playScriptedHand,
  type ScriptedHand,
} from "../testing/review-eval/hands.js";
import { computeScoreReport, type ScoreReport } from "./score.js";
import {
  PHASE6_PROVISIONAL_V1,
  SCORING_POLICIES,
  type DecisionFeatures,
  type ScoringPolicy,
} from "./scoring-policy.js";

const HERO = "hero";
const BASE_HANDS = [BTN_VS_UTG, SB_VS_BTN, MULTIWAY_FLOP];

const deps = {
  kb: loadKb(),
  solver: createAmaster97Adapter({
    install: { installed: false, detail: "テスト" },
    timeoutMs: 1,
    maxConcurrency: 1,
    iterations: 1,
  }),
};

// 判断時点の Evidence は Scripted Hand ごとに 1 回だけ作り、同じ Hand を別の handId で繰り返すときは使い回す。
const evidenceByHand = new Map<string, ReviewEvidence[]>();
for (const hand of BASE_HANDS) {
  const sets = heroInformationSets(playScriptedHand(hand), HERO);
  evidenceByHand.set(
    hand.id,
    await Promise.all(sets.map((s) => buildReviewEvidence(s, [], deps))),
  );
}

interface PlayedHand {
  readonly handId: string;
  readonly events: HandEvent[];
  readonly evidence: readonly ReviewEvidence[];
}

/** Scripted Hand を、handId を変えて（round 回目として）最後まで進める。 */
function play(hand: ScriptedHand, round = 0): PlayedHand {
  const events = playScriptedHand({ ...hand, id: `${hand.id}_${round}` });
  const started = events[0];
  if (started?.type !== "HAND_STARTED") throw new Error("HAND_STARTED が無い");
  return {
    handId: started.handId,
    events,
    evidence: evidenceByHand.get(hand.id) ?? [],
  };
}

interface ReviewPatch {
  readonly assessment?: Assessment;
  readonly confidence?: Confidence;
  readonly depth?: ReviewDepth;
  readonly rulingNotes?: readonly RulingCode[];
}

function review(
  hand: PlayedHand,
  decisionIndex: number,
  patch: ReviewPatch = {},
): ReviewDraft {
  const base = hand.evidence[decisionIndex];
  if (base === undefined) throw new Error(`判断 ${decisionIndex} が無い`);
  const evidence: ReviewEvidence = {
    ...base,
    handId: hand.handId,
    context: {
      ...base.context,
      rulingNotes: patch.rulingNotes ?? base.context.rulingNotes,
    },
  };
  const depth = patch.depth ?? "standard";
  return {
    handId: hand.handId,
    decisionIndex,
    actionSeq: 0,
    pass: "decision",
    depth,
    modelRole: depth === "deep" ? "review_deep" : "review_standard",
    concreteModel: "test-model",
    kbVersion: evidence.knowledge.kbVersion,
    solverVersion: null,
    generatedBy: "review_ai",
    assessment: patch.assessment ?? "reasonable",
    confidence: patch.confidence ?? "high",
    assumptions: [],
    evidenceIds: evidenceIdsOf(evidence, [evidence.math.id]),
    explanation: {
      practical: "",
      theory: { basis: "none", text: "" },
      exploit: { basis: "none", text: "" },
      conclusionChangers: [],
    },
    evidence,
    failure: null,
  };
}

function ability(report: ScoreReport, name: string) {
  const found = report.abilities.find((a) => a.ability === name);
  if (found === undefined) throw new Error(`${name} が無い`);
  return found;
}

describe("Ability Evidence と Score（phase6_provisional_v1）", () => {
  // Hero の判断の数: BTN_VS_UTG 4・SB_VS_BTN 5・MULTIWAY_FLOP 4 = 13。
  const hands = BASE_HANDS.map((h) => play(h));
  const [btn, sb, multi] = hands as [PlayedHand, PlayedHand, PlayedHand];
  const allEvents = hands.map((h) => h.events);

  it("Review の無い判断は M にだけ数え、Score は null で insufficient", () => {
    const report = computeScoreReport({
      hands: allEvents,
      reviews: new InMemoryReviewStore(),
      heroId: HERO,
    });
    expect(report.policyVersion).toBe("phase6_provisional_v1");
    expect(report.decisions).toEqual({
      total: 13,
      reviewed: 0,
      scored: 0,
      insufficientEvidence: 0,
    });
    expect(report.overall.score).toBeNull();
    expect(report.overall.confidence).toBe("insufficient");
    expect(report.abilities.map((a) => a.ability)).toEqual(
      PHASE6_PROVISIONAL_V1.abilities,
    );
    expect(report.abilities.every((a) => a.score === null)).toBe(true);
  });

  it("M 件中 N 件を返し、insufficient_evidence は 0 点として数えない", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(review(btn, 0, { assessment: "strong" }));
    reviews.append(review(sb, 2, { assessment: "insufficient_evidence" }));
    const report = computeScoreReport({
      hands: allEvents,
      reviews,
      heroId: HERO,
    });
    expect(report.decisions).toEqual({
      total: 13,
      reviewed: 2,
      scored: 1,
      insufficientEvidence: 1,
    });
    expect(report.overall).toMatchObject({
      score: 100,
      sampleSize: 1,
      confidence: "low",
      evidenceIds: [`${btn.handId}/d0/v1`],
    });
  });

  it("Assessment の暫定点を使い、Confidence は点数を変えず Weight にだけ使う", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(
      review(btn, 0, { assessment: "strong", confidence: "high" }),
    );
    reviews.append(
      review(btn, 1, { assessment: "major_leak", confidence: "low" }),
    );
    reviews.append(
      review(sb, 0, { assessment: "mixed_marginal", confidence: "medium" }),
    );
    const report = computeScoreReport({
      hands: allEvents,
      reviews,
      heroId: HERO,
    });
    expect(report.evidence.map((e) => e.points)).toEqual([100, 0, 60]);
    // (100×1 + 0×0.4 + 60×0.7) / (1 + 0.4 + 0.7) = 142 / 2.1 = 67.6
    expect(report.overall.score).toBe(67.6);
  });

  it("同じ判断に複数の Version があれば最新を使う（Depth で優先しない）", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(review(btn, 3, { assessment: "strong", depth: "deep" }));
    reviews.append(
      review(btn, 3, {
        assessment: "improvement_suggested",
        depth: "standard",
      }),
    );
    const report = computeScoreReport({
      hands: allEvents,
      reviews,
      heroId: HERO,
    });
    expect(report.decisions.reviewed).toBe(1);
    expect(report.evidence).toHaveLength(1);
    expect(report.evidence[0]).toMatchObject({
      id: `${btn.handId}/d3/v2`,
      reviewVersion: 2,
      depth: "standard",
      points: 35,
    });
  });

  it("1 つの判断を複数の Ability に決定論で割り当てる", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(review(btn, 0)); // Preflop で Open に Call
    reviews.append(review(btn, 1)); // Flop で Bet に Call
    reviews.append(review(sb, 2)); // Turn で最初に Bet
    reviews.append(review(multi, 3)); // River で Check
    const report = computeScoreReport({
      hands: allEvents,
      reviews,
      heroId: HERO,
    });
    expect(report.evidence.map((e) => e.abilities)).toEqual([
      [
        { ability: "preflop", weight: 1 },
        { ability: "pot_equity_math", weight: 0.5 },
      ],
      [
        { ability: "postflop", weight: 1 },
        { ability: "pot_equity_math", weight: 0.5 },
        { ability: "range_reading", weight: 0.5 },
      ],
      [
        { ability: "postflop", weight: 1 },
        { ability: "bet_sizing", weight: 0.5 },
      ],
      [{ ability: "postflop", weight: 1 }],
    ]);
    expect(ability(report, "postflop").sampleSize).toBe(3);
    expect(ability(report, "bet_sizing").evidenceIds).toEqual([
      `${sb.handId}/d2/v1`,
    ]);
    // Hero の Observation の Evidence がまだ無いので、Opponent Adaptation は割り当てない。
    expect(ability(report, "opponent_adaptation").score).toBeNull();
  });

  it("Position は Preflop で誰も Raise していない判断に割り当てる", () => {
    const features: DecisionFeatures = {
      street: "preflop",
      action: "raise",
      callAmount: 0,
      aggressive: true,
      preflopUnraised: true,
      rulingNotes: [],
    };
    expect(PHASE6_PROVISIONAL_V1.assignAbilities(features)).toEqual([
      { ability: "preflop", weight: 1 },
      { ability: "bet_sizing", weight: 0.5 },
      { ability: "position", weight: 0.5 },
    ]);
  });

  it("Live Mechanics は裁定から決める別の Score で、Overall に入れない", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(
      review(btn, 0, { assessment: "strong", rulingNotes: ["oversized_chip"] }),
    );
    reviews.append(review(btn, 1, { assessment: "insufficient_evidence" }));
    const report = computeScoreReport({
      hands: allEvents,
      reviews,
      heroId: HERO,
    });
    // Poker Decision は裁定に左右されない。
    expect(report.overall).toMatchObject({ score: 100, sampleSize: 1 });
    // Live Mechanics は Assessment を使わないので insufficient_evidence の判断も数える。
    expect(ability(report, "live_mechanics")).toMatchObject({
      score: 50,
      sampleSize: 2,
      evidenceIds: [`${btn.handId}/d0/v1`, `${btn.handId}/d1/v1`],
    });
    expect(report.evidence[0]?.liveMechanics).toEqual({
      points: 0,
      rulingNotes: ["oversized_chip"],
    });
  });

  it("除外した Hand（Drill）は M・N・Score に入れない", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(review(btn, 0, { assessment: "major_leak" }));
    reviews.append(review(sb, 0, { assessment: "strong" }));
    const report = computeScoreReport(
      { hands: allEvents, reviews, heroId: HERO },
      { excludeHandIds: new Set([btn.handId]) },
    );
    expect(report.decisions).toMatchObject({ total: 9, reviewed: 1 });
    expect(report.overall).toMatchObject({
      score: 100,
      evidenceIds: [`${sb.handId}/d0/v1`],
    });
  });

  it("終わっていない Hand の判断は M に数えない", () => {
    const unfinished = btn.events.filter((e) => e.type !== "HAND_FINISHED");
    const report = computeScoreReport({
      hands: [unfinished, sb.events],
      reviews: new InMemoryReviewStore(),
      heroId: HERO,
    });
    expect(report.decisions.total).toBe(5);
  });

  it("Policy の Version を変えると、同じ Evidence から計算し直せる", () => {
    const reviews = new InMemoryReviewStore();
    reviews.append(review(btn, 0, { assessment: "reasonable" }));
    reviews.append(review(sb, 2, { assessment: "major_leak" }));
    const source = { hands: allEvents, reviews, heroId: HERO };
    const variant: ScoringPolicy = {
      ...PHASE6_PROVISIONAL_V1,
      version: "test_variant",
      assessmentPoints: {
        ...PHASE6_PROVISIONAL_V1.assessmentPoints,
        reasonable: 70,
        major_leak: 10,
      },
    };

    const v1 = computeScoreReport(source);
    const again = computeScoreReport(source, {
      policy: SCORING_POLICIES["phase6_provisional_v1"],
    });
    const changed = computeScoreReport(source, { policy: variant });

    expect(again).toEqual(v1);
    expect(v1.policyVersion).toBe("phase6_provisional_v1");
    expect(v1.overall.score).toBe(40);
    expect(changed.policyVersion).toBe("test_variant");
    expect(changed.overall.score).toBe(40);
    expect(ability(changed, "preflop").score).toBe(70);
    expect(ability(changed, "bet_sizing").score).toBe(10);
    expect(ability(v1, "preflop").score).toBe(80);
  });

  it("Trend は直近 window 件とその前の window 件で比べる", () => {
    // 同じ 3 Hand を 2 回繰り返して 26 の判断を作る（古い順）。
    const played = [0, 1].flatMap((round) =>
      BASE_HANDS.map((h) => play(h, round)),
    );
    const reviews = new InMemoryReviewStore();
    let i = 0;
    for (const hand of played) {
      hand.evidence.forEach((_, decisionIndex) => {
        // 後ろの 10 件だけ strong、それより前は major_leak。
        const assessment: Assessment = i >= 16 ? "strong" : "major_leak";
        reviews.append(review(hand, decisionIndex, { assessment }));
        i++;
      });
    }
    const source = {
      hands: played.map((h) => h.events),
      reviews,
      heroId: HERO,
    };
    const report = computeScoreReport(source);
    expect(report.decisions).toMatchObject({ total: 26, reviewed: 26 });
    expect(report.overall.trend).toEqual({
      direction: "improving",
      recentScore: 100,
      previousScore: 0,
      window: 10,
    });
    expect(report.overall.confidence).toBe("medium");

    // 件数が 2 × window に満たなければ Trend は出さない。
    const short = computeScoreReport(source, {
      excludeHandIds: new Set([played[0]?.handId ?? ""]),
    });
    expect(short.overall.sampleSize).toBe(22);
    expect(ability(short, "preflop").trend.direction).toBe("insufficient");
  });

  it("Score の Confidence は件数の段階で決める（暫定値）", () => {
    const c = (n: number) => PHASE6_PROVISIONAL_V1.scoreConfidence(n);
    expect([0, 1, 9, 10, 29, 30].map(c)).toEqual([
      "insufficient",
      "low",
      "low",
      "medium",
      "medium",
      "high",
    ]);
  });

  it("Pass B（reveal_reviews）の Store は入力に渡せない", () => {
    computeScoreReport({
      hands: allEvents,
      // @ts-expect-error Pass B の Store は Pass A の Review を返さないので型が合わない（Hindsight を混ぜない）。
      reviews: new InMemoryRevealReviewStore(),
      heroId: HERO,
    });
  });
});
