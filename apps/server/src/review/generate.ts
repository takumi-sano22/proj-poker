// Review の文章の生成（docs/03 §7 の Evidence Sufficiency → Review AI → Versioned Review の手前まで）。
// 本番（ReviewService）と Review Eval のハーネスが同じこの関数を通る（LC-050: 評価ハーネスと本番の引数組み立てを揃える）。
// 1. Evidence Sufficiency Gate: 根拠が足りなければ Review AI を呼ばずに Insufficient Evidence
// 2. Review AI（Claude。構造化出力）→ 検証（schema → grounding）。不正なら理由を付けて 1 回だけ再要求。
//    検証を通った文は、内部の識別子（playerId・Evidence の項目名）を表示名・自然な言葉に置換してから返す（identifiers.ts）
// 3. 2 回続けて不正なら Insufficient Evidence とし、失敗（各回の段と理由）を Review に残す
// Claude の呼び出しの失敗（未ログイン・利用枠・Timeout 等）は例外のまま投げる（Review は作らず、再実行を待つ）。
import { MODEL_ROLES } from "../config.js";
import {
  runStructuredQuery,
  type ClaudeQuery,
} from "../claude/structured-query.js";
import { evidenceIdsOf } from "./evidence.js";
import { playerNamesOf, sanitizeOutput } from "./identifiers.js";
import {
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  checkReviewOutput,
  reviewOutputSchema,
  type ReviewCorrection,
} from "./review-ai.js";
import {
  MISSING_EVIDENCE_TEXT,
  checkEvidenceSufficiency,
} from "./sufficiency.js";
import type {
  ReviewDepth,
  ReviewDraft,
  ReviewEvidence,
  ReviewModelRole,
} from "./types.js";

export interface GenerateReviewOptions {
  readonly depth: ReviewDepth;
  /** Review の対象の Hero の ACTION_TAKEN の seq。 */
  readonly actionSeq: number;
  /** 子プロセスの環境（buildClaudeEnv の結果）。 */
  readonly env: Record<string, string>;
  /** 省略時は SDK の query()。CI・テストは Fake / 録画。 */
  readonly query?: ClaudeQuery;
  /** 1 回の呼び出しを止める（上限の超過・アプリ終了）。 */
  readonly signalFor?: () => AbortSignal | undefined;
  /** 呼び出しごとに、渡した引数と出力を知らせる（Eval の記録・ログ）。 */
  readonly onAttempt?: (attempt: {
    readonly prompt: string;
    readonly output: unknown;
    readonly check: ReturnType<typeof checkReviewOutput>;
  }) => void;
}

/**
 * Review AI の 1 回の呼び出しのターン数の上限。構造化出力の JSON が崩れたとき、SDK がモデルに直させる 1 ターンを許す
 * （#82 の実測で、長い説明の JSON が崩れて 1 ターンでは止まった。直しは呼び出しの中で行い、検証の Retry とは別）。
 */
export const REVIEW_MAX_TURNS = 2;

/** 深さ → Model Role（D97: review_deep は Hero が「詳しく」を選んだ Spot だけ）。 */
export function modelRoleFor(depth: ReviewDepth): ReviewModelRole {
  return depth === "deep" ? "review_deep" : "review_standard";
}

/** Evidence から Review を作る（保存の前）。Version・ID・時刻は Store が付ける。 */
export async function generateReview(
  evidence: ReviewEvidence,
  options: GenerateReviewOptions,
): Promise<ReviewDraft> {
  const modelRole = modelRoleFor(options.depth);
  const model = MODEL_ROLES[modelRole];
  const base = {
    handId: evidence.handId,
    decisionIndex: evidence.decisionIndex,
    actionSeq: options.actionSeq,
    pass: evidence.pass,
    depth: options.depth,
    modelRole,
    kbVersion: evidence.knowledge.kbVersion,
    solverVersion:
      evidence.solver.status === "supported"
        ? `${evidence.solver.solver.id}@${evidence.solver.solver.version}+${evidence.solver.solver.commit}`
        : null,
    evidence,
  } as const;

  const sufficiency = checkEvidenceSufficiency(evidence);
  if (!sufficiency.sufficient) {
    const missing = sufficiency.missing.map((m) => MISSING_EVIDENCE_TEXT[m]);
    return {
      ...base,
      concreteModel: null,
      generatedBy: "sufficiency_gate",
      assessment: "insufficient_evidence",
      confidence: "low",
      assumptions: evidence.math.assumptions,
      evidenceIds: evidenceIdsOf(evidence),
      explanation: insufficientExplanation(
        `評価に足りる根拠が無いため、この判断は評価しません（${missing.join("・")}）。`,
        missing.map((m) => `${m}が揃えば評価できる`),
      ),
      failure: null,
    };
  }

  const schema = reviewOutputSchema(evidence);
  const failures: ReviewCorrection[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildReviewPrompt(evidence, failures.at(-1));
    const output = await runStructuredQuery({
      query: options.query,
      model,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      prompt,
      schema,
      env: options.env,
      signal: options.signalFor?.(),
      maxTurns: REVIEW_MAX_TURNS,
    });
    const check = checkReviewOutput(output, evidence);
    options.onAttempt?.({ prompt, output, check });
    if (check.ok) {
      // 識別子が出ていても Retry はせず、保存の前に既知のものを機械的に置換する（#96・D101）。
      const value = sanitizeOutput(
        check.value,
        playerNamesOf(evidence.context),
      );
      return {
        ...base,
        concreteModel: model,
        generatedBy: "review_ai",
        assessment: value.assessment,
        confidence: value.confidence,
        assumptions: value.assumptions,
        evidenceIds: evidenceIdsOf(evidence, value.evidenceIds),
        explanation: {
          practical: value.practical,
          theory: value.theory,
          exploit: value.exploit,
          conclusionChangers: value.conclusionChangers,
        },
        failure: null,
      };
    }
    failures.push({ stage: check.stage, reason: check.reason });
  }
  return {
    ...base,
    concreteModel: model,
    generatedBy: "invalid_output_fallback",
    assessment: "insufficient_evidence",
    confidence: "low",
    assumptions: evidence.math.assumptions,
    evidenceIds: evidenceIdsOf(evidence),
    explanation: insufficientExplanation(
      "Review AI の出力を 2 回続けて検証できなかったため、この判断は評価しません（もう一度 Review を作ると評価できることがあります）。",
      ["Review AI が検証を通る出力を返せば評価できる"],
    ),
    failure: { kind: "invalid_output", attempts: failures },
  };
}

function insufficientExplanation(
  practical: string,
  conclusionChangers: readonly string[],
): ReviewDraft["explanation"] {
  return {
    practical,
    theory: { basis: "none", text: "" },
    exploit: { basis: "none", text: "" },
    conclusionChangers,
  };
}
