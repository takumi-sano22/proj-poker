// Reveal Review（Pass B）の文章の生成。Pass A の generateReview と同じ流れ（Gate → Review AI → 検証 → 1 回だけ再要求 →
// 2 回続けて不正なら Fallback）で、本番（ReviewService）とスモーク（testing/）が同じこの関数を通る（LC-050）。
// Pass B は評価（Assessment）を出さないので、Fallback も評価を持たない説明だけにする。
// Claude の呼び出しの失敗（未ログイン・利用枠・Timeout 等）は例外のまま投げる（Review は作らず、再実行を待つ）。
import { MODEL_ROLES } from "../config.js";
import { runStructuredQuery } from "../claude/structured-query.js";
import {
  REVIEW_MAX_TURNS,
  modelRoleFor,
  type GenerateReviewOptions,
} from "./generate.js";
import type { ReviewCorrection } from "./review-ai.js";
import {
  REVEAL_SYSTEM_PROMPT,
  buildRevealPrompt,
  checkRevealOutput,
  revealOutputSchema,
  type RevealOutputCheck,
} from "./reveal-ai.js";
import { revealEvidenceIdsOf } from "./reveal-evidence.js";
import type {
  RevealEvidence,
  RevealExplanation,
  RevealReviewDraft,
} from "./reveal-types.js";

export interface GenerateRevealOptions extends Omit<
  GenerateReviewOptions,
  "onAttempt"
> {
  readonly onAttempt?: (attempt: {
    readonly prompt: string;
    readonly output: unknown;
    readonly check: RevealOutputCheck;
  }) => void;
}

/** 答え合わせに足りる根拠があるか（Hero の札が読めて、判断時点で Pot を争っていた相手の札が 1 人以上見えている）。 */
export function revealIsSufficient(evidence: RevealEvidence): boolean {
  return (
    evidence.context.heroHoleCards.length === 2 &&
    evidence.reveal.villains.some(
      (v) => v.activeAtDecision && v.holeCards.length === 2,
    )
  );
}

/** Pass B の Evidence から Reveal Review を作る（保存の前）。Version・ID・時刻は Store が付ける。 */
export async function generateRevealReview(
  evidence: RevealEvidence,
  options: GenerateRevealOptions,
): Promise<RevealReviewDraft> {
  const modelRole = modelRoleFor(options.depth);
  const model = MODEL_ROLES[modelRole];
  const base = {
    handId: evidence.handId,
    decisionIndex: evidence.decisionIndex,
    actionSeq: options.actionSeq,
    pass: "reveal",
    depth: options.depth,
    modelRole,
    evidence,
  } as const;

  if (!revealIsSufficient(evidence)) {
    return {
      ...base,
      concreteModel: null,
      generatedBy: "sufficiency_gate",
      evidenceIds: revealEvidenceIdsOf(evidence),
      explanation: fallbackExplanation(
        "Hero の札か、判断時点で Pot を争っていた相手の札を読めなかったため、答え合わせはしません。",
      ),
      failure: null,
    };
  }

  const schema = revealOutputSchema(evidence);
  const failures: ReviewCorrection[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildRevealPrompt(evidence, failures.at(-1));
    const output = await runStructuredQuery({
      query: options.query,
      model,
      systemPrompt: REVEAL_SYSTEM_PROMPT,
      prompt,
      schema,
      env: options.env,
      signal: options.signalFor?.(),
      maxTurns: REVIEW_MAX_TURNS,
    });
    const check = checkRevealOutput(output, evidence);
    options.onAttempt?.({ prompt, output, check });
    if (check.ok) {
      const { evidenceIds, ...explanation } = check.value;
      return {
        ...base,
        concreteModel: model,
        generatedBy: "review_ai",
        evidenceIds: revealEvidenceIdsOf(evidence, evidenceIds),
        explanation,
        failure: null,
      };
    }
    failures.push({ stage: check.stage, reason: check.reason });
  }
  return {
    ...base,
    concreteModel: model,
    generatedBy: "invalid_output_fallback",
    evidenceIds: revealEvidenceIdsOf(evidence),
    explanation: fallbackExplanation(
      "Review AI の出力を 2 回続けて検証できなかったため、答え合わせの説明は作れませんでした（もう一度作ると説明できることがあります）。実際の札と Equity は Evidence に残っています。",
    ),
    failure: { kind: "invalid_output", attempts: failures },
  };
}

function fallbackExplanation(text: string): RevealExplanation {
  return {
    readComparison: text,
    actualEquity: "",
    bluffValue: "",
    takeaways: [],
  };
}
