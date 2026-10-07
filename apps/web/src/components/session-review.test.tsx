// Session Review / Learning の画面の静的な描画（#116）。DOM 環境を足さず、react-dom/server の文字列で見る。
// - 判断の質（Decision Quality）を収支より先に出し、「M 件中 N 件を Review 済み」を必ず出す（D115）
// - 点数だけを出さず、確度と件数を添える。数えられる判断が無ければ点数を出さない
// - 収支は実額が正本で、BB は補助（設定で消せる。D49）
// - 未 Review の判断をまとめて Review する Button は無い。Drill は候補があるときだけ始められる（#117）
// - Drill の結果は通常の Score と別の欄に、練習した判断の M 件中 N 件と一緒に出す（D105）
// - Stats は分子 / 分母を出す。Persona・他 Player の名前は出さない
import type { StatTable, StatValue } from "@proj-poker/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  AbilityScore,
  ProfileResponse,
  ScoreValue,
  SessionReview,
} from "../lib/learning-api.js";
import {
  durationText,
  netText,
  sampleCaveat,
  statText,
} from "../lib/learning.js";
import { BbDisplayProvider } from "./BbDisplay.js";
import type { DrillResults } from "../lib/drill-api.js";
import {
  DrillResultsBody,
  ProfileBody,
  SessionReviewBody,
} from "./SessionReviewScreen.js";

const noop = () => undefined;

function score(
  value: number | null,
  sampleSize: number,
  confidence: ScoreValue["confidence"] = "low",
): ScoreValue {
  return {
    score: value,
    confidence: value === null ? "insufficient" : confidence,
    sampleSize,
    trend: { direction: "insufficient" },
  };
}

const ABILITIES: readonly AbilityScore[] = [
  { ability: "preflop", ...score(90, 2) },
  { ability: "postflop", ...score(35, 2) },
  { ability: "live_mechanics", ...score(100, 5) },
];

function stat(numerator: number, denominator: number): StatValue {
  return { numerator, denominator, opportunities: denominator };
}

const STATS: StatTable = {
  vpip: stat(2, 3),
  pfr: stat(1, 3),
  three_bet: stat(0, 1),
  fold_to_three_bet: stat(0, 0),
  cbet_flop: stat(1, 1),
  fold_to_cbet_flop: stat(0, 0),
  aggression_frequency: stat(2, 4),
  aggression_factor: stat(2, 1),
};

function sessionReview(overrides: Partial<SessionReview> = {}): SessionReview {
  return {
    policyVersion: "phase6_session_review_v1",
    scoringPolicyVersion: "phase6_provisional_v1",
    hands: 3,
    startedAt: "2026-10-07T00:00:00.000Z",
    endedAt: "2026-10-07T00:25:00.000Z",
    durationMs: 25 * 60 * 1000,
    bigBlind: 2,
    heroNet: -120,
    decisionQuality: {
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
      overall: score(53.8, 4),
    },
    abilities: ABILITIES,
    strengths: [
      {
        handId: "h1",
        handNumber: 1,
        decisionIndex: 0,
        street: "preflop",
        action: "call",
        assessment: "strong",
        confidence: "high",
      },
    ],
    leaks: [
      {
        handId: "h2",
        handNumber: 2,
        decisionIndex: 2,
        street: "turn",
        action: "bet",
        assessment: "major_leak",
        confidence: "high",
      },
    ],
    importantHands: [
      {
        handId: "h2",
        handNumber: 2,
        heroHoleCards: [
          { rank: 14, suit: "s" },
          { rank: 13, suit: "s" },
        ],
        reasons: ["big_pot"],
        decisions: { total: 5, reviewed: 2 },
        leakCount: 1,
        strengthCount: 0,
      },
    ],
    heroStats: { version: "phase6_stats_v1", hands: 3, overall: STATS },
    recommendedDrill: { available: false, candidate: null },
    ...overrides,
  };
}

function render(review: SessionReview, showBB = true): string {
  return renderToStaticMarkup(
    <BbDisplayProvider value={showBB}>
      <SessionReviewBody
        review={review}
        onOpenReview={noop}
        onStartDrill={noop}
      />
    </BbDisplayProvider>,
  );
}

describe("SessionReviewBody", () => {
  it("判断の質を収支より先に出し、M 件中 N 件・点数・確度・件数を一緒に出す", () => {
    const html = render(sessionReview());
    expect(html).toContain("この Session の判断 13 件中 5 件を Review 済み");
    expect(html).toContain("53.8 点");
    expect(html).toContain("確度 低い・4 件");
    expect(html.indexOf("判断の質")).toBeLessThan(html.indexOf("収支"));
    // 段階評価の内訳は文字でも示す（0 件の段階は出さない）。
    expect(html).toContain("大きな損失（Major Leak） 1 件");
    expect(html).not.toContain("Mixed / Marginal");
  });

  it("収支は実額が正本で、BB は補助（OFF でも実額は出す）。勝ち負けで上手・下手と書かない", () => {
    const on = render(sessionReview());
    expect(on).toContain("−120（60 BB）");
    expect(on).toContain("上手・下手は収支ではなく、判断の質で見ます");
    const off = render(sessionReview(), false);
    expect(off).toContain("−120");
    expect(off).not.toContain("60 BB");
  });

  it("Review 済みの判断が無ければ点数を出さず、件数の注意を出す", () => {
    const html = render(
      sessionReview({
        decisionQuality: {
          ...sessionReview().decisionQuality,
          reviewed: 0,
          scored: 0,
          insufficientEvidence: 0,
          assessments: {
            strong: 0,
            reasonable: 0,
            mixed_marginal: 0,
            improvement_suggested: 0,
            major_leak: 0,
            insufficient_evidence: 0,
          },
          overall: score(null, 0),
        },
        strengths: [],
        leaks: [],
      }),
    );
    expect(html).toContain("13 件中 0 件を Review 済み");
    expect(html).toContain("まだ数えられる判断がありません");
    expect(html).toContain("Review 済みの判断がまだ無いため");
    expect(html).not.toContain("確度 判断なし");
  });

  it("まとめて Review する Button は無く、Drill は候補があるときだけ始められる", () => {
    const html = render(
      sessionReview({
        recommendedDrill: {
          available: true,
          candidate: sessionReview().leaks[0] ?? null,
        },
      }),
    );
    expect(html).not.toMatch(/まとめて|すべて Review|一括/);
    expect(html).toContain("候補: Hand 2 のターンの判断（大きな損失）");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Drill を始める/);
    expect(html).toContain("結果は通常の Score に混ぜません");
    const none = render(sessionReview());
    expect(none).toMatch(
      /<button[^>]*disabled=""[^>]*>Drill を始める<\/button>/,
    );
  });

  it("Ability は点数と確度・件数・傾向を出し、Live Mechanics は Poker の判断と別だと示す", () => {
    const html = render(sessionReview());
    expect(html).toContain("プリフロップ（Preflop）");
    expect(html).toContain("確度 低い・2 件・傾向 件数不足");
    expect(html).toContain("Poker の判断とは別の Score");
  });

  it("Stats は Hero 自身の分子 / 分母を出し、機会が無い指標は割合を出さない。Persona・他 Player を出さない", () => {
    const html = render(sessionReview());
    expect(html).toContain("67%（2 / 3）");
    expect(html).toContain("—（0 / 0）");
    expect(html).toContain("2.0（2 / 1）");
    expect(html).not.toMatch(/persona|Persona|cpu\d/);
  });

  it("Strength / Leak と Important Hands は Hand の番号と段階評価・Review 済みの数を出す（結果は出さない）", () => {
    const html = render(sessionReview());
    expect(html).toContain("Hand 2・ターン（Turn）");
    expect(html).toContain("Review 済み 2 / 5");
    expect(html).toContain("大きい Pot");
  });
});

const PROFILE: ProfileResponse = {
  profile: {
    policyVersion: "phase6_profile_v1",
    decisions: { total: 40, reviewed: 12 },
    recent: {
      window: 100,
      reviewed: 12,
      scored: 11,
      overall: score(71.2, 11),
      abilities: ABILITIES,
    },
    longTerm: {
      reviewed: 12,
      scored: 11,
      overall: score(71.2, 11, "medium"),
      abilities: ABILITIES,
    },
    hypotheses: [
      {
        hypothesisId: "phase6_hypothesis_v1/postflop_facing_bet",
        type: "postflop_facing_bet",
        status: "supported",
        supportingEvidenceIds: ["a", "b"],
        counterEvidenceIds: ["c"],
        policyVersion: "phase6_hypothesis_v1",
        computedAt: "2026-10-07T00:00:00.000Z",
      },
    ],
  },
  text: "Review 済みの判断 12 件（対象の判断 40 件中）から作った Profile です。",
  heroStats: { version: "phase6_stats_v1", hands: 20, overall: STATS },
};

describe("ProfileBody", () => {
  it("直近（既定）と全期間を切り替えられ、どちらも件数と確度を添える", () => {
    const recent = renderToStaticMarkup(<ProfileBody response={PROFILE} />);
    expect(recent).toContain("全期間の判断 40 件中 12 件を Review 済み");
    expect(recent).toContain("直近 100 件（Recent）");
    expect(recent).toMatch(/aria-pressed="true"[^>]*>直近 100 件/);
    expect(recent).toContain("確度 低い・11 件");
    const longTerm = renderToStaticMarkup(
      <ProfileBody response={PROFILE} initialTab="longTerm" />,
    );
    expect(longTerm).toMatch(/aria-pressed="true"[^>]*>全期間（Long-term）/);
    expect(longTerm).toContain("確度 中くらい・11 件");
  });

  it("Weakness Hypothesis を状態の文字と支持 / 反証の件数で出す", () => {
    const html = renderToStaticMarkup(<ProfileBody response={PROFILE} />);
    expect(html).toContain("Flop 以降で Bet に直面した場面");
    expect(html).toContain("裏付けあり");
    expect(html).toContain("支持 2 件・反証 1 件");
    expect(html).toContain("Review 済みの判断 12 件");
  });
});

describe("Learning の文言", () => {
  it("時間・収支・件数の注意・Stats の表記", () => {
    expect(durationText(null)).toBe("—");
    expect(durationText(30_000)).toBe("1 分未満");
    expect(durationText(25 * 60_000)).toBe("25 分");
    expect(durationText(85 * 60_000)).toBe("1 時間 25 分");
    expect(netText(120, 2, true)).toBe("+120（60 BB）");
    expect(netText(0, 2, false)).toBe("±0");
    expect(sampleCaveat(0, 0, "insufficient")).toContain("判断がありません");
    expect(sampleCaveat(3, 10, "insufficient")).toContain("根拠が足りない");
    expect(sampleCaveat(30, 40, "high")).toContain("比較的安定");
    expect(statText("vpip", stat(1, 4))).toBe("25%（1 / 4）");
    expect(statText("aggression_factor", stat(3, 0))).toBe("—（3 / 0）");
  });
});

describe("DrillResultsBody", () => {
  const results = (overrides: Partial<DrillResults> = {}): DrillResults => ({
    policyVersion: "phase6_drill_v1",
    drills: [
      {
        drillId: "d1",
        createdAt: "2026-10-07T00:00:00.000Z",
        policyVersion: "phase6_drill_v1",
        source: { handId: "h1", decisionIndex: 1 },
        variant: { kind: "bet_size", potFraction: 0.75 },
        change: null,
        drillHandId: "dh1",
        decisionIndex: 1,
        finished: true,
        assessment: "strong",
      },
    ],
    score: {
      policyVersion: "phase6_provisional_v1",
      decisions: { total: 1, reviewed: 1 },
      overall: score(100, 1),
      abilities: [],
    },
    ...overrides,
  });

  it("練習した判断の M 件中 N 件・点数・確度と、Drill ごとの段階評価を出す", () => {
    const html = renderToStaticMarkup(
      <DrillResultsBody results={results()} onOpenReview={noop} />,
    );
    expect(html).toContain("練習した判断 1 件中 1 件を Review 済み");
    expect(html).toContain("100 点");
    expect(html).toContain("Bet の額（Bet Size）");
    expect(html).toContain("良い判断");
  });

  it("終わった Drill が無ければ点数を出さない", () => {
    const html = renderToStaticMarkup(
      <DrillResultsBody
        results={results({ drills: [] })}
        onOpenReview={noop}
      />,
    );
    expect(html).toContain("終わった Drill はまだありません");
    expect(html).not.toContain("点");
  });
});
