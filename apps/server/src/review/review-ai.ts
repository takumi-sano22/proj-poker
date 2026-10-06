// Review AI（Pass A: Decision Review）の Prompt・構造化出力の Schema・出力の検証（docs/05 §6〜§9）。
// 渡すのは構造化した Evidence（ReviewEvidence）だけ。Evidence は判断時点の Hero Information Set から作るので、
// 他者の Hidden Cards・未来の Card・system の記録・CPU の Persona は入っていない（不変条件 2・3）。
// 条件付きの指示（Solver があるときだけ〜）は文で書かず、Schema の enum と検証で守らせる（llm ガイダンス 4）。
import { cardToString, type Card } from "@proj-poker/engine";
import { allEvidenceIds } from "./evidence.js";
import {
  ASSESSMENTS,
  CONFIDENCES,
  type Assessment,
  type Confidence,
  type ReviewEvidence,
  type ReviewOutput,
} from "./types.js";

/** 出力の検証で不正と判定した段。schema（形）→ grounding（根拠の参照）の順に見る。 */
export type ReviewInvalidStage = "schema" | "grounding";

export interface ReviewCorrection {
  readonly stage: ReviewInvalidStage;
  readonly reason: string;
}

export type ReviewOutputCheck =
  | { readonly ok: true; readonly value: ReviewOutput }
  | {
      readonly ok: false;
      readonly stage: ReviewInvalidStage;
      readonly reason: string;
    };

/** 文字数・件数の上限（暫定値）。長すぎる出力は UI で読まれないので不正として再要求する。 */
export const REVIEW_TEXT_MAX = 1200;
export const ITEM_TEXT_MAX = 300;
const ASSUMPTIONS_MAX = 8;
const CHANGERS_MAX = 6;
export const EVIDENCE_IDS_MAX = 20;

/** 構造化出力の項目（この順で並べる。docs/05 §9 の説明の順を含む）。 */
const OUTPUT_KEYS = [
  "assessment",
  "confidence",
  "practical",
  "theoryBasis",
  "theory",
  "exploitBasis",
  "exploit",
  "assumptions",
  "conclusionChangers",
  "evidenceIds",
] as const;

export const REVIEW_SYSTEM_PROMPT = [
  "あなたはノーリミット・テキサスホールデム（キャッシュゲーム）のコーチです。Hero の 1 回の判断を、渡された Evidence だけを使って評価します。",
  "",
  "# 守ること",
  "- Evidence は判断の時点に Hero が知り得た情報と、そこから決定論で計算した値です。Hand の結果・相手の実際の札は渡していません。結果ではなく判断の質を評価してください。",
  "- 数値（Pot・Pot Odds・Equity・必要 Equity・簡易 EV・Combo 数・頻度）は Evidence の値をそのまま使い、自分で計算し直したり作ったりしないでください。",
  "- math.equity.method が exact なら仮定した Range の全列挙（標本の誤差は無い。trials は数えた組の数）、monte_carlo なら trials 回の試行による推定です。",
  "- 額は Chip の実額で書き、BB 換算は必要なときに括弧で添えてください。",
  "- Range と Equity は Assumption（仮定した Range）に基づく推定です。断定せず、前提を書いてください。",
  "- 簡易 EV（math.alternatives の ev）は前提付きの目安で、GTO / Solver の値ではありません。",
  "- Solver の結果（solver.status が supported のときだけある）は Heads-Up・抽象化した Bet Tree の近似です。Exact GTO・正解とは書かず、前提（scope・betTree・rangeAssumptions・assumptions）を添えてください。Solver の結果が無いときは Solver の結論を書かないでください。",
  "- 「GTO で X だから常に X が正しい」とは教えないでください。",
  "- knowledge の項目のうち label が HEURISTIC / EXPLOIT のものは経験則として書き、普遍的なルールとして断定しないでください。",
  "- 根拠が足りず評価できないときは assessment を insufficient_evidence にしてください。",
  "",
  "# 出力（StructuredOutput ツールで、文章を書かずにすぐ返す。値はすべて JSON の文字列か文字列の配列。文は日本語）",
  "- assessment: strong（とても良い）/ reasonable（妥当）/ mixed_marginal（どちらとも言える・僅差）/ improvement_suggested（改善の余地あり）/ major_leak（大きな損失につながる判断）/ insufficient_evidence（根拠不足で評価しない）",
  "- confidence: low / medium / high（Evidence の量と前提の強さから）",
  "- practical: 実戦的な Baseline。Pot Odds・Equity・Position・相手の Range の想定から、この判断をどう考えるか",
  "- theoryBasis / theory: GTO / Theory の観点。theoryBasis は Solver の結果を根拠にするなら solver、一般的な理論なら general_theory、書くことが無ければ none（theory は空文字でよい）",
  "- exploitBasis / exploit: 相手の傾向に合わせた調整。exploitBasis は相手の Observation を根拠にするなら observation、無ければ none（exploit は空文字でよい）",
  "- assumptions: この評価の前提（Range の想定・簡易 EV の前提など）",
  "- conclusionChangers: 何が変わるとこの結論も変わるか（相手の Range がもっと狭い／広い等）",
  "- evidenceIds: 根拠にした Evidence の id",
].join("\n");

/** Review AI へ渡す Prompt（user message）。Evidence の JSON と、再要求のときだけ前回の不正の理由。 */
export function buildReviewPrompt(
  evidence: ReviewEvidence,
  correction?: ReviewCorrection,
): string {
  const sections = [
    "## Evidence（Card は 2 文字で、As はスペードの A、Td はダイヤの 10）",
    JSON.stringify(evidence, cardReplacer),
  ];
  if (correction !== undefined) {
    sections.push(
      "## 前回の答えは使えなかった",
      `${correction.stage}: ${correction.reason}。Schema と Evidence の id に合わせて答え直してください。`,
    );
  }
  return sections.join("\n\n");
}

/**
 * 構造化出力の JSON Schema。theory / exploit の basis と evidenceIds の候補は、その Evidence で選べるものに絞る
 * （Solver の結果が無いのに basis: solver を選ばせない・存在しない id を挙げさせない）。最終判断は checkReviewOutput。
 */
export function reviewOutputSchema(
  evidence: ReviewEvidence,
): Record<string, unknown> {
  // 文字数・件数の上限も Schema に書いてモデルへ伝える（検証の checkReviewOutput と同じ値）。
  const text = { type: "string", maxLength: REVIEW_TEXT_MAX };
  const list = (maxItems: number) => ({
    type: "array",
    minItems: 1,
    maxItems,
    items: { type: "string", minLength: 1, maxLength: ITEM_TEXT_MAX },
  });
  return {
    type: "object",
    additionalProperties: false,
    required: [...OUTPUT_KEYS],
    // 説明の順序（docs/05 §9）: practical → theory → exploit。入れ子のオブジェクトにすると JSON が崩れやすい（#82 の実測）ので平らにする。
    properties: {
      assessment: { type: "string", enum: [...ASSESSMENTS] },
      confidence: { type: "string", enum: [...CONFIDENCES] },
      practical: text,
      theoryBasis: { type: "string", enum: theoryBases(evidence) },
      theory: text,
      exploitBasis: { type: "string", enum: exploitBases(evidence) },
      exploit: text,
      assumptions: list(ASSUMPTIONS_MAX),
      conclusionChangers: list(CHANGERS_MAX),
      evidenceIds: {
        type: "array",
        minItems: 1,
        maxItems: EVIDENCE_IDS_MAX,
        items: { type: "string", enum: [...allEvidenceIds(evidence)] },
      },
    },
  };
}

function theoryBases(evidence: ReviewEvidence): string[] {
  return evidence.solver.status === "supported"
    ? ["solver", "general_theory", "none"]
    : ["general_theory", "none"];
}

function exploitBases(evidence: ReviewEvidence): string[] {
  // 相手の Observation の記録はまだ無い（status は常に unavailable）。記録ができたら observation を足す。
  return evidence.opponentObservation.status === "unavailable"
    ? ["none"]
    : ["observation", "none"];
}

/**
 * Review AI の出力を検証する（LLM の出力は何が来るか分からないので unknown で受ける）。
 * 1. schema: 形（知らない項目が無い・enum・文字数・件数）
 * 2. grounding: 根拠の参照（evidenceIds が Evidence に実在する・Solver の結果が無いのに solver を根拠にしない 等）
 */
export function checkReviewOutput(
  output: unknown,
  evidence: ReviewEvidence,
): ReviewOutputCheck {
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
  if (!ASSESSMENTS.includes(o["assessment"] as Assessment)) {
    return schema(`assessment は ${ASSESSMENTS.join(" / ")} のどれか`);
  }
  if (!CONFIDENCES.includes(o["confidence"] as Confidence)) {
    return schema(`confidence は ${CONFIDENCES.join(" / ")} のどれか`);
  }
  const practical = o["practical"];
  if (!isText(practical, REVIEW_TEXT_MAX) || practical.trim() === "") {
    return schema(`practical は空でない ${REVIEW_TEXT_MAX} 字以内の文字列`);
  }
  const theory = section(o["theoryBasis"], o["theory"], [
    "solver",
    "general_theory",
    "none",
  ]);
  if (theory === null) {
    return schema(
      `theoryBasis は solver / general_theory / none、theory は ${REVIEW_TEXT_MAX} 字以内の文字列（theoryBasis が none 以外なら空にしない）`,
    );
  }
  const exploit = section(o["exploitBasis"], o["exploit"], [
    "observation",
    "none",
  ]);
  if (exploit === null) {
    return schema(
      `exploitBasis は observation / none、exploit は ${REVIEW_TEXT_MAX} 字以内の文字列（exploitBasis が none 以外なら空にしない）`,
    );
  }
  const assumptions = textList(o["assumptions"], ASSUMPTIONS_MAX);
  if (assumptions === null) {
    return schema(
      `assumptions は 1〜${ASSUMPTIONS_MAX} 個の空でない ${ITEM_TEXT_MAX} 字以内の文字列`,
    );
  }
  const changers = textList(o["conclusionChangers"], CHANGERS_MAX);
  if (changers === null) {
    return schema(
      `conclusionChangers は 1〜${CHANGERS_MAX} 個の空でない ${ITEM_TEXT_MAX} 字以内の文字列`,
    );
  }
  const evidenceIds = textList(o["evidenceIds"], EVIDENCE_IDS_MAX);
  if (evidenceIds === null) {
    return schema(`evidenceIds は 1〜${EVIDENCE_IDS_MAX} 個の id`);
  }

  const grounding = (reason: string) =>
    ({ ok: false, stage: "grounding", reason }) as const;
  const known = allEvidenceIds(evidence);
  const unknownIds = evidenceIds.filter((id) => !known.has(id));
  if (unknownIds.length > 0) {
    return grounding(`Evidence に無い id: ${unknownIds.join(", ")}`);
  }
  if (theory.basis === "solver") {
    if (evidence.solver.status !== "supported") {
      return grounding(
        "Solver の結果が無い（solver.status が supported ではない）のに theoryBasis が solver",
      );
    }
    if (!evidenceIds.includes(evidence.solver.id)) {
      return grounding(
        `theoryBasis が solver なら evidenceIds に ${evidence.solver.id} を入れる`,
      );
    }
  }
  if (
    exploit.basis === "observation" &&
    evidence.opponentObservation.status === "unavailable"
  ) {
    return grounding(
      "相手の Observation が無いのに exploitBasis が observation",
    );
  }
  return {
    ok: true,
    value: {
      assessment: o["assessment"] as Assessment,
      confidence: o["confidence"] as Confidence,
      practical: practical.trim(),
      theory,
      exploit,
      assumptions,
      conclusionChangers: changers,
      evidenceIds: [...new Set(evidenceIds)],
    },
  };
}

export function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/** theory / exploit の根拠の種類と文。basis が none 以外なら text を空にしない。 */
function section<B extends string>(
  basis: unknown,
  text: unknown,
  bases: readonly B[],
): { basis: B; text: string } | null {
  if (!bases.includes(basis as B) || !isText(text, REVIEW_TEXT_MAX)) {
    return null;
  }
  if (basis !== "none" && text.trim() === "") return null;
  return { basis: basis as B, text: text.trim() };
}

/** 1〜max 個の、空でない ITEM_TEXT_MAX 字以内の文字列の配列。 */
export function textList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    return null;
  }
  const items: unknown[] = value;
  const texts = items.filter(
    (v): v is string => isText(v, ITEM_TEXT_MAX) && v.trim() !== "",
  );
  return texts.length === items.length ? texts.map((v) => v.trim()) : null;
}

/** Card を "As" 形式の文字列にする（JSON の { rank: 14, suit: "s" } より読みやすくする）。Pass B・Follow-up の Prompt も使う。 */
export function cardReplacer(_key: string, value: unknown): unknown {
  return isCard(value) ? cardToString(value) : value;
}

function isCard(value: unknown): value is Card {
  return (
    typeof value === "object" &&
    value !== null &&
    "rank" in value &&
    "suit" in value
  );
}
