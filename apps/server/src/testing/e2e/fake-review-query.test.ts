// E2E 用の Review AI（REVIEW_PROVIDER=fake）が、本番と同じ生成・検証の経路で Pass A / Pass B / Follow-up を通ることのテスト。
import {
  extractImportantSpots,
  heroInformationSets,
  projectLearningReveal,
  type HeroInformationSet,
  type LearningReveal,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { loadKb } from "../../kb/index.js";
import { buildReviewEvidence } from "../../review/evidence.js";
import { generateFollowUp } from "../../review/followup.js";
import { generateReview } from "../../review/generate.js";
import { generateRevealReview } from "../../review/generate-reveal.js";
import { buildRevealEvidence } from "../../review/reveal-evidence.js";
import { createAmaster97Adapter } from "../../solver/amaster97-adapter.js";
import { BTN_VS_UTG, playScriptedHand } from "../review-eval/hands.js";
import { FAKE_REVIEW_MARK, fakeReviewQuery } from "./fake-review-query.js";

const kb = loadKb();
const notInstalled = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});

const events = playScriptedHand(BTN_VS_UTG);
const sets = heroInformationSets(events, "hero");
const set = sets[3] as HeroInformationSet;
const reasons =
  extractImportantSpots(sets).find((s) => s.decisionIndex === 3)?.reasons ?? [];
const options = { depth: "standard", env: {}, query: fakeReviewQuery } as const;

describe("E2E 用の Review AI（固定応答）", () => {
  it("Pass A: 検証を通り、段階評価（reasonable）と固定応答の印が付いた説明になる", async () => {
    const evidence = await buildReviewEvidence(set, reasons, {
      kb,
      solver: notInstalled,
    });
    const draft = await generateReview(evidence, {
      ...options,
      actionSeq: set.decision.actionSeq,
    });
    expect(draft).toMatchObject({
      generatedBy: "review_ai",
      assessment: "reasonable",
      failure: null,
    });
    expect(draft.explanation.practical).toContain(FAKE_REVIEW_MARK);
  });

  it("Pass B と Follow-up も検証を通る（evidenceIds は Schema の候補から選ぶ）", async () => {
    const reveal = projectLearningReveal(events) as LearningReveal;
    const evidence = await buildRevealEvidence(set, reveal, events, reasons);
    const draft = await generateRevealReview(evidence, {
      ...options,
      actionSeq: set.decision.actionSeq,
    });
    expect(draft).toMatchObject({ generatedBy: "review_ai", failure: null });
    expect(draft.explanation.readComparison).toContain(FAKE_REVIEW_MARK);

    const answer = await generateFollowUp(
      {
        pass: "reveal",
        reviewId: "r",
        handId: evidence.handId,
        decisionIndex: 3,
        version: 1,
        evidence,
        explanation: draft.explanation,
      },
      [],
      "相手の札は？",
      options,
    );
    expect(answer).toMatchObject({
      generatedBy: "review_ai",
      answer: { scope: "answered" },
    });
    expect(answer.answer.text).toContain(FAKE_REVIEW_MARK);
  });

  it("知らない Schema の呼び出しは誤りにする（Opponent など Review 以外に使わせない）", () => {
    expect(() =>
      fakeReviewQuery({
        prompt: "",
        options: {
          outputFormat: { type: "json_schema", schema: { properties: {} } },
        },
      }),
    ).toThrow("知らない構造化出力の Schema");
  });
});
