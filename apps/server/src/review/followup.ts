// Follow-up Q&A（#83・docs/05 §7・§12）。Pass と Version で指定した 1 つの Review に対して Hero が質問し、Review AI が答える。
// - 答えの根拠は、その Review の Evidence と説明だけ。Pass A（decision）への質問の Prompt には Pass A の Evidence しか入れないので、
//   Hand 後の情報（相手の実際の札・結果）が入る経路が無い（不変条件 3）。Pass ごとの範囲の指示は、条件文ではなく Pass で文ごと出し分ける（llm ガイダンス 4）
// - 複数ターンは、これまでの質問と答えを Prompt に入れて 1 回の単発の問い合わせとして呼ぶ（D87 の呼び出し方。SDK のセッションは残さない）
// 本番（ReviewService）とスモーク（testing/）が同じこの関数を通る（LC-050）。
import { MODEL_ROLES } from "../config.js";
import { runStructuredQuery } from "../claude/structured-query.js";
import { allEvidenceIds } from "./evidence.js";
import {
  evidenceGlossary,
  replacementNamesOf,
  sanitizeOutput,
} from "./identifiers.js";
import {
  REVIEW_MAX_TURNS,
  modelRoleFor,
  type GenerateReviewOptions,
} from "./generate.js";
import {
  EVIDENCE_IDS_MAX,
  REVIEW_TEXT_MAX,
  cardReplacer,
  isText,
  type ReviewCorrection,
  type ReviewInvalidStage,
} from "./review-ai.js";
import { allRevealEvidenceIds } from "./reveal-evidence.js";
import type {
  FollowUpAnswer,
  FollowUpDraft,
  FollowUpRecord,
  FollowUpTarget,
} from "./reveal-types.js";

/** 質問の文字数の上限（暫定値）。 */
export const FOLLOWUP_QUESTION_MAX = 500;
/** 1 つの Review の Version に続けられるターン数の上限（暫定値。履歴を Prompt に入れるので長さを抑える）。 */
export const FOLLOWUP_MAX_TURNS = 20;

export type FollowUpOutputCheck =
  | {
      readonly ok: true;
      readonly value: FollowUpAnswer;
    }
  | {
      readonly ok: false;
      readonly stage: ReviewInvalidStage;
      readonly reason: string;
    };

const OUTPUT_KEYS = ["scope", "answer", "evidenceIds"] as const;

const COMMON_RULES = [
  "あなたはノーリミット・テキサスホールデム（キャッシュゲーム）のコーチです。Hero の 1 回の判断について作った Review に、Hero が続けて質問します。渡した Evidence と Review の説明だけを根拠に答えてください。",
  "",
  "# 守ること",
  "- 数値は Evidence の値をそのまま使い、自分で計算し直したり作ったりしないでください。額は Chip の実額で書いてください。",
  "- Evidence に無いことを推測で作らないでください。Evidence で答えられない質問は scope を out_of_scope にし、何が無いので答えられないかを書いてください。",
  "- これまでの質問と答えがあれば、その流れを踏まえて答えてください。",
  "- 文は Hero が読みます。内部の識別子（playerId・Evidence の項目名・英字と _ でつないだ値・Evidence の id）は文に書かず、席は seats の displayName、項目は「Evidence の項目の説明」の言葉で書いてください。Evidence の id は evidenceIds にだけ入れてください。",
];

/** Pass ごとの範囲の指示（Pass で文ごと出し分ける）。 */
const PASS_RULES: Readonly<Record<FollowUpTarget["pass"], readonly string[]>> =
  {
    decision: [
      "- この Review は判断の時点に Hero が知り得た情報だけを使った Decision Review です。Hand の結果・相手の実際の札・判断より後に出た Card は Evidence に無く、あなたも知りません。それを聞かれたら scope を out_of_scope にし、Hand 後の答え合わせ（Reveal Review）で確かめられると答えてください。",
      "- 判断の質は結果ではなく、判断の時点の情報で考えてください。",
    ],
    reveal: [
      "- この Review は Hand の後に学習のために全員の札を見せた答え合わせ（Reveal Review）です。実際の札・実際の Equity を使って答えてよいですが、判断の時点で Hero はそれを知り得なかったことを前提にしてください。",
      "- 結果（勝った・負けた・相手の実際の札）を理由に、判断の評価（Decision Review）を付け直さないでください。結果と判断の質を分けて答えてください。",
    ],
  };

const OUTPUT_RULES = [
  "",
  "# 出力（StructuredOutput ツールで、文章を書かずにすぐ返す。文は日本語）",
  "- scope: answered（Evidence で答えた）/ out_of_scope（Evidence の範囲の外で答えられない）",
  `- answer: 答え（${REVIEW_TEXT_MAX} 字以内）`,
  "- evidenceIds: 根拠にした Evidence の id（answered なら 1 つ以上）",
];

/** Follow-up の system prompt（Pass で範囲の指示を出し分ける）。 */
export function followUpSystemPrompt(pass: FollowUpTarget["pass"]): string {
  return [...COMMON_RULES, ...PASS_RULES[pass], ...OUTPUT_RULES].join("\n");
}

/** 対象の Review の Evidence が持つ id（答えの根拠に挙げてよい id）。 */
export function followUpEvidenceIds(target: FollowUpTarget): Set<string> {
  return target.pass === "decision"
    ? allEvidenceIds(target.evidence)
    : allRevealEvidenceIds(target.evidence);
}

/**
 * Follow-up の Prompt（user message）。対象の Review の Evidence と説明、これまでの質問と答え（古い順）、今回の質問。
 * 入れるのは target（その Pass の Review）と、その Review の Version に紐づく履歴だけ。
 */
export function buildFollowUpPrompt(
  target: FollowUpTarget,
  history: readonly FollowUpRecord[],
  question: string,
  correction?: ReviewCorrection,
): string {
  const sections = [
    `## 対象の Review（${target.pass === "decision" ? "Decision Review" : "Reveal Review"}・Version ${target.version}）`,
    "### Evidence（Card は 2 文字で、As はスペードの A、Td はダイヤの 10）",
    JSON.stringify(target.evidence, cardReplacer),
    // 卓の傾向（D122）のある Pass A の Evidence にだけ、その項目の説明を出す（無い Evidence の Prompt は #153 より前と同じ）。
    evidenceGlossary(target.pass, {
      tableTendency:
        target.pass === "decision" &&
        target.evidence.opponentObservation.status === "available",
    }),
    "### Review の説明",
    JSON.stringify(target.explanation),
  ];
  if (history.length > 0) {
    sections.push("## これまでの質問と答え（古い順）");
    for (const turn of history) {
      sections.push(
        `### 質問 ${turn.turn}`,
        turn.question,
        `### 答え ${turn.turn}`,
        turn.answer.text,
      );
    }
  }
  sections.push("## 今回の質問", question);
  if (correction !== undefined) {
    sections.push(
      "## 前回の答えは使えなかった",
      `${correction.stage}: ${correction.reason}。Schema と Evidence の id に合わせて答え直してください。`,
    );
  }
  return sections.join("\n\n");
}

/** 構造化出力の JSON Schema。evidenceIds の候補は対象の Review の Evidence の id に絞る。 */
export function followUpOutputSchema(
  target: FollowUpTarget,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...OUTPUT_KEYS],
    properties: {
      scope: { type: "string", enum: ["answered", "out_of_scope"] },
      answer: { type: "string", minLength: 1, maxLength: REVIEW_TEXT_MAX },
      evidenceIds: {
        type: "array",
        maxItems: EVIDENCE_IDS_MAX,
        items: { type: "string", enum: [...followUpEvidenceIds(target)] },
      },
    },
  };
}

/** Follow-up の出力を検証する（schema → grounding）。 */
export function checkFollowUpOutput(
  output: unknown,
  target: FollowUpTarget,
): FollowUpOutputCheck {
  const schema = (reason: string) =>
    ({ ok: false, stage: "schema", reason }) as const;
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return schema("出力がオブジェクトではない");
  }
  const o = output as Record<string, unknown>;
  const unknownKeys = Object.keys(o).filter(
    (k) => !(OUTPUT_KEYS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    return schema(`知らない項目がある: ${unknownKeys.join(", ")}`);
  }
  const scope = o["scope"];
  if (scope !== "answered" && scope !== "out_of_scope") {
    return schema("scope は answered / out_of_scope のどちらか");
  }
  const answer = o["answer"];
  if (!isText(answer, REVIEW_TEXT_MAX) || answer.trim() === "") {
    return schema(`answer は空でない ${REVIEW_TEXT_MAX} 字以内の文字列`);
  }
  const rawIds = o["evidenceIds"];
  if (
    !Array.isArray(rawIds) ||
    rawIds.length > EVIDENCE_IDS_MAX ||
    !rawIds.every((id) => typeof id === "string")
  ) {
    return schema(`evidenceIds は 0〜${EVIDENCE_IDS_MAX} 個の id`);
  }
  const ids = rawIds;
  if (scope === "answered" && ids.length === 0) {
    return {
      ok: false,
      stage: "grounding",
      reason: "answered なら evidenceIds に根拠の id を 1 つ以上入れる",
    };
  }
  const known = followUpEvidenceIds(target);
  const unknownIds = ids.filter((id) => !known.has(id));
  if (unknownIds.length > 0) {
    return {
      ok: false,
      stage: "grounding",
      reason: `Evidence に無い id: ${unknownIds.join(", ")}`,
    };
  }
  return {
    ok: true,
    value: { scope, text: answer.trim(), evidenceIds: [...new Set(ids)] },
  };
}

export interface GenerateFollowUpOptions extends Omit<
  GenerateReviewOptions,
  "onAttempt" | "actionSeq"
> {
  readonly onAttempt?: (attempt: {
    readonly prompt: string;
    readonly output: unknown;
    readonly check: FollowUpOutputCheck;
  }) => void;
}

/** Follow-up の 1 ターンの答えを作る（保存の前）。ターンの番号・ID・時刻は Store が付ける。 */
export async function generateFollowUp(
  target: FollowUpTarget,
  history: readonly FollowUpRecord[],
  question: string,
  options: GenerateFollowUpOptions,
): Promise<FollowUpDraft> {
  const modelRole = modelRoleFor(options.depth);
  const model = MODEL_ROLES[modelRole];
  const base = {
    reviewId: target.reviewId,
    pass: target.pass,
    handId: target.handId,
    decisionIndex: target.decisionIndex,
    reviewVersion: target.version,
    depth: options.depth,
    modelRole,
    concreteModel: model,
    question,
  } as const;
  const systemPrompt = followUpSystemPrompt(target.pass);
  const schema = followUpOutputSchema(target);
  const failures: ReviewCorrection[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildFollowUpPrompt(
      target,
      history,
      question,
      failures.at(-1),
    );
    const output = await runStructuredQuery({
      query: options.query,
      model,
      systemPrompt,
      prompt,
      schema,
      env: options.env,
      signal: options.signalFor?.(),
      maxTurns: REVIEW_MAX_TURNS,
    });
    const check = checkFollowUpOutput(output, target);
    options.onAttempt?.({ prompt, output, check });
    if (check.ok) {
      return {
        ...base,
        generatedBy: "review_ai",
        // 識別子の置換は Review と同じ（Retry はしない。#96）。
        answer: sanitizeOutput(
          check.value,
          replacementNamesOf(target.evidence),
        ),
        failure: null,
      };
    }
    failures.push({ stage: check.stage, reason: check.reason });
  }
  return {
    ...base,
    generatedBy: "invalid_output_fallback",
    answer: {
      scope: "unanswered",
      text: "Review AI の答えを 2 回続けて検証できなかったため、この質問には答えられませんでした（もう一度質問すると答えられることがあります）。",
      evidenceIds: [],
    },
    failure: { kind: "invalid_output", attempts: failures },
  };
}
