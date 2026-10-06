// Review の画面の部品の静的な描画（#84）。DOM 環境を足さず、react-dom/server の文字列で見る。
// - Pass A は要点（段階評価・Practical）を根拠より先に出し、Hand 後の情報（全員の札）を出さない
// - Solver は Supported のときだけ結果を出し、Unsupported（Multiway・Flop・未導入）は前提と Fallback を出す
// - Pass B は Pass A と別の見た目（reveal の面）で、段階評価を出さない
// - 生成の待ち・失敗の案内に内部実装（モデル名・API）を出さない
import type { Card } from "@proj-poker/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  generationMessage,
  insufficientNote,
  solverNote,
  versionLabel,
} from "../lib/review.js";
import type {
  ReviewGeneration,
  ReviewRecord,
  RevealRecord,
  SolverEvidence,
} from "../lib/review-api.js";
import { DecisionReviewBody, RevealReviewBody } from "./ReviewPass.js";
import { SolverView } from "./ReviewEvidence.js";

const nameOf = (id: string) => id.toUpperCase();
const c = (rank: Card["rank"], suit: Card["suit"]): Card => ({ rank, suit });

const context: ReviewRecord["evidence"]["context"] = {
  street: "turn",
  smallBlind: 1,
  bigBlind: 2,
  heroId: "hero",
  heroPosition: "BTN",
  playerCount: 3,
  activePlayerCount: 2,
  heroHoleCards: [c(14, "s"), c(13, "s")],
  board: [c(2, "h"), c(7, "d"), c(9, "c"), c(12, "s")],
  pot: 40,
  currentBet: 20,
  seats: [
    {
      playerId: "hero",
      position: "BTN",
      isHero: true,
      stack: 150,
      streetCommitted: 0,
      folded: false,
      allIn: false,
    },
    {
      playerId: "cpu1",
      position: "BB",
      isHero: false,
      stack: 130,
      streetCommitted: 20,
      folded: false,
      allIn: false,
    },
  ],
  actionHistory: [
    {
      playerId: "cpu1",
      street: "turn",
      action: "bet",
      amount: 20,
      toAmount: 20,
      allIn: false,
    },
  ],
  decision: { action: "call", amount: 20, toAmount: 20, allIn: false },
  importantSpotReasons: ["big_pot"],
};

const supportedSolver: SolverEvidence = {
  status: "supported",
  id: "solver:1",
  scope: "heads_up",
  strategy: [
    { key: "check", action: { kind: "check" }, frequency: 0.7 },
    {
      key: "bet_50",
      action: { kind: "bet", potFraction: 0.5 },
      frequency: 0.3,
    },
  ],
  heroHandClass: "AKs",
  heroHandClassStrategy: { check: 0.4, bet_50: 0.6 },
  convergence: { iterations: 200, note: "近似" },
  assumptions: ["Hero の Range は BTN Open の標準"],
  warnings: [],
};

function decisionRecord(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewId: "r1",
    version: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
    depth: "standard",
    generatedBy: "review_ai",
    assessment: "reasonable",
    confidence: "medium",
    assumptions: ["相手の Range は標準の想定"],
    evidenceIds: { cited: ["math:1"] },
    explanation: {
      practical: "要点の文。Pot Odds から見て Call は妥当。",
      theory: { basis: "general_theory", text: "理論の文。" },
      exploit: { basis: "none", text: "" },
      conclusionChangers: ["相手の Range が狭いなら Fold"],
    },
    evidence: {
      context,
      math: {
        id: "math:1",
        pot: 40,
        callAmount: 20,
        potOdds: 1 / 3,
        effectiveStack: 130,
        spr: 3.25,
        equity: { equity: 0.42, method: "exact" },
        alternatives: [
          {
            action: "call",
            toAmount: null,
            risk: 20,
            winnablePot: 60,
            requiredEquity: 1 / 3,
            ev: 5.2,
            breakEvenFoldFrequency: null,
            chosen: true,
          },
        ],
        assumptions: ["簡易 EV は Fold を 0 とした差"],
      },
      range: { id: "range:1", villains: [], comparisons: null },
      solver: supportedSolver,
      knowledge: {
        items: [
          {
            id: "kb:1.0.0:pot_odds@1",
            title: "Pot Odds と必要 Equity",
            label: "FACT",
            body: "本文",
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("Pass A（判断時点の Review）", () => {
  it("段階評価と要点を根拠より先に出し、結論が変わる条件・前提・確度を併記する", () => {
    const html = renderToStaticMarkup(
      <DecisionReviewBody
        record={decisionRecord()}
        nameOf={nameOf}
        handId="h1"
        decisionIndex={0}
      />,
    );
    expect(html).toContain("妥当（Reasonable）");
    expect(html).toContain("assessment--good");
    expect(html).toContain("確度（Confidence）: 中くらい");
    expect(html).toContain("結論が変わる条件");
    expect(html).toContain("相手の Range が狭いなら Fold");
    expect(html).toContain("相手の Range は標準の想定");
    // 要点が根拠（Evidence）より前にある（要点先行・D04）。
    expect(html.indexOf("要点の文")).toBeLessThan(
      html.indexOf("根拠（Evidence）"),
    );
    // Follow-up の欄が Pass A の Version に付く。
    expect(html).toContain("この Review に質問する");
    // Hand 後の情報（全員の札・答え合わせ）の欄は Pass A に無い。
    expect(html).not.toContain("全員の札");
    expect(html).not.toContain("review-pass--reveal");
  });

  it("Solver は Supported なら結果を Heads-Up の前提つきで出す", () => {
    const html = renderToStaticMarkup(<SolverView solver={supportedSolver} />);
    expect(html).toContain("Heads-Up（2 人）の場面を Solver で解いた結果");
    expect(html).toContain("唯一の正解ではありません");
    expect(html).toContain("70%");
    expect(html).toContain("AKs");
  });

  it("Solver が Unsupported（Multiway・Street・未導入）・当てはまらない・失敗なら、結果を出さずに理由と Fallback を出す", () => {
    const cases: SolverEvidence[] = [
      { status: "unsupported", reason: "player_count", detail: "3 人" },
      { status: "unsupported", reason: "street", detail: "flop" },
      {
        status: "unsupported",
        reason: "solver_not_installed",
        detail: "/home/u/solver が無い",
      },
      { status: "not_applicable", reason: "preflop", detail: "" },
      { status: "failed", code: "timeout", detail: "内部の本文" },
    ];
    for (const solver of cases) {
      const html = renderToStaticMarkup(<SolverView solver={solver} />);
      expect(html).toContain("代わりに、計算（Math）");
      expect(html).not.toContain("freq__row");
      expect(html).not.toContain("Solver で解いた結果");
      // サーバーの detail（パス・内部の本文を含みうる）はそのまま出さない。
      expect(html).not.toContain("/home/u");
      expect(html).not.toContain("内部の本文");
    }
    expect(
      solverNote({ status: "unsupported", reason: "player_count", detail: "" })
        .reason,
    ).toContain("Multiway");
  });

  it("Insufficient Evidence は理由（Gate / 検証できなかった）を添えて出す", () => {
    const html = renderToStaticMarkup(
      <DecisionReviewBody
        record={decisionRecord({
          assessment: "insufficient_evidence",
          confidence: "low",
          generatedBy: "sufficiency_gate",
        })}
        nameOf={nameOf}
        handId="h1"
        decisionIndex={0}
      />,
    );
    expect(html).toContain("根拠が足りない（Insufficient Evidence）");
    expect(html).toContain("評価を保留しています");
    expect(insufficientNote("invalid_output_fallback")).toContain(
      "もう一度作ると",
    );
    expect(insufficientNote("review_ai")).toBeNull();
  });

  it("相手の傾向の記録が無いときは、Exploit の調整をしていないと書く", () => {
    const html = renderToStaticMarkup(
      <DecisionReviewBody
        record={decisionRecord()}
        nameOf={nameOf}
        handId="h1"
        decisionIndex={0}
      />,
    );
    expect(html).toContain("相手の傾向の記録がまだ無いため");
  });
});

describe("Pass B（Hand 後の答え合わせ）", () => {
  const reveal: RevealRecord = {
    reviewId: "rv1",
    version: 2,
    createdAt: "2026-10-06T00:00:00.000Z",
    depth: "deep",
    generatedBy: "review_ai",
    explanation: {
      readComparison: "読みの比較の文。",
      actualEquity: "実際の Equity の文。",
      bluffValue: "Bluff / Value の文。",
      takeaways: ["次に活かす点の文"],
    },
    evidence: {
      context,
      reveal: {
        villains: [
          {
            playerId: "cpu1",
            position: "BB",
            holeCards: [c(9, "h"), c(9, "s")],
            activeAtDecision: true,
            assumedRange: null,
            inAssumedRange: true,
            madeHandAtDecision: "three_of_a_kind",
          },
        ],
        finalBoard: [c(2, "h"), c(7, "d"), c(9, "c"), c(12, "s"), c(3, "c")],
      },
      equity: {
        assumed: 0.42,
        actual: { equity: 0.05 },
        heroMadeHandAtDecision: "high_card",
      },
      aggression: { items: [], rule: "公平な取り分以上なら value" },
    },
  };

  it("全員の札・実際の Equity・答え合わせを Pass B の面に出し、段階評価は出さない", () => {
    const html = renderToStaticMarkup(
      <RevealReviewBody
        record={reveal}
        nameOf={nameOf}
        handId="h1"
        decisionIndex={0}
      />,
    );
    expect(html).toContain("Hand 後の情報");
    expect(html).toContain("全員の札");
    expect(html).toContain("CPU1（BB）");
    expect(html).toContain("仮定した Range に入っていた");
    expect(html).toContain("スリーカード（Three of a Kind）");
    expect(html).toContain("5%");
    expect(html).toContain("次に活かす点の文");
    expect(html).toContain("この答え合わせに質問する");
    expect(html).not.toContain("assessment--");
    expect(html).not.toContain("Confidence");
  });
});

describe("生成の待ち・失敗の案内", () => {
  const internals = /claude|sonnet|opus|api|sdk|model/i;

  it("待ちは「作っています」だけで、長いときだけ補足する。内部実装を出さない", () => {
    const pending: ReviewGeneration = { state: "pending", depth: "standard" };
    expect(generationMessage(pending, "Review", false)).toBe(
      "Review を作っています…",
    );
    expect(
      generationMessage({ state: "pending", depth: "deep" }, "Review", false),
    ).toBe("詳しい Review を作っています…（標準より時間がかかります）");
    expect(generationMessage(pending, "答え合わせ", false)).toBe(
      "答え合わせを作っています…",
    );
    expect(generationMessage(pending, "Review", true)).toContain(
      "時間がかかっています",
    );
    expect(
      generationMessage({ state: "pending", depth: "deep" }, "Review", false),
    ).toContain("詳しい");
    expect(generationMessage({ state: "idle" }, "Review", false)).toBeNull();
    for (const kind of [
      "unauthenticated",
      "usage_limit",
      "timeout",
      "error",
    ] as const) {
      const text =
        generationMessage(
          { state: "failed", depth: "standard", kind },
          "Review",
          false,
        ) ?? "";
      expect(text).toContain("作");
      expect(text.replace(/Review/g, "")).not.toMatch(internals);
    }
    for (const depth of ["standard", "deep"] as const) {
      for (const delayed of [false, true]) {
        const text =
          generationMessage({ state: "pending", depth }, "Review", delayed) ??
          "";
        expect(text.replace(/Review/g, "")).not.toMatch(internals);
      }
    }
  });

  it("Version の表記は最新に印を付ける", () => {
    expect(versionLabel(3, true)).toBe("Version 3（最新）");
    expect(versionLabel(1, false)).toBe("Version 1");
  });
});
