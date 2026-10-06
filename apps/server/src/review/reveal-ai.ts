// Reveal Review（Pass B）の Review AI の Prompt・構造化出力の Schema・出力の検証（docs/05 §7）。
// 渡すのは Pass B の Evidence（判断時点の卓 + Hand 後に見せた全員の札と、そこから決定論で計算した値）だけ。
// Pass B は答え合わせで、判断の評価（Assessment）は出させない。結果を理由に Pass A の評価を変えないよう Prompt で明示する。
import {
  EVIDENCE_IDS_MAX,
  ITEM_TEXT_MAX,
  REVIEW_TEXT_MAX,
  cardReplacer,
  isText,
  textList,
  type ReviewCorrection,
  type ReviewInvalidStage,
} from "./review-ai.js";
import { evidenceGlossary } from "./identifiers.js";
import { allRevealEvidenceIds } from "./reveal-evidence.js";
import type { RevealEvidence, RevealExplanation } from "./reveal-types.js";

export type RevealOutputCheck =
  | {
      readonly ok: true;
      readonly value: RevealExplanation & {
        readonly evidenceIds: readonly string[];
      };
    }
  | {
      readonly ok: false;
      readonly stage: ReviewInvalidStage;
      readonly reason: string;
    };

const TAKEAWAYS_MAX = 4;

/** 構造化出力の項目（この順で並べる）。 */
const OUTPUT_KEYS = [
  "readComparison",
  "actualEquity",
  "bluffValue",
  "takeaways",
  "evidenceIds",
] as const;

export const REVEAL_SYSTEM_PROMPT = [
  "あなたはノーリミット・テキサスホールデム（キャッシュゲーム）のコーチです。Hand が終わった後に、学習のために全員の札を見せて、Hero の 1 回の判断の答え合わせをします（Reveal Review）。",
  "",
  "# 守ること",
  "- 判断の良し悪しの評価は、判断時点の情報だけを使った別の Review（Decision Review）で済んでいます。この答え合わせで評価を付け直したり、結果（勝った・負けた・相手の実際の札）を理由に判断が良かった・悪かったと言ったりしないでください。結果と判断の質を分けて書いてください。",
  "- reveal の札は Hand の後に学習のためだけに見せた情報です。判断の時点で Hero は知り得なかったことを前提に書いてください。",
  "- 数値（Equity・Combo 数・人数）は Evidence の値をそのまま使い、自分で計算し直したり作ったりしないでください。「実際の札に対する Equity」は判断時点の Board からの、相手の実際の札に対する勝率、「仮定した Range に対する Equity」は判断時点に仮定した Range に対する勝率です。",
  "- 相手ごとに、実際の札が判断時点に仮定した Range に入っていたかを Evidence に入れています。1 Hand の結果だけで Range の想定が誤りだったとは断定しないでください。",
  "- Bet / Raise の value / bluff の区別は、Evidence に添えた基準で決めた目安です。基準を添えて書いてください。",
  "- 文は Hero が読みます。内部の識別子（playerId・Evidence の項目名・英字と _ でつないだ値・Evidence の id）は文に書かず、席は seats の displayName、項目は「Evidence の項目の説明」の言葉で書いてください。Evidence の id は evidenceIds にだけ入れてください。",
  "- 額は Chip の実額で書いてください。",
  "",
  "# 出力（StructuredOutput ツールで、文章を書かずにすぐ返す。値はすべて JSON の文字列か文字列の配列。文は日本語）",
  "- readComparison: 読みと実際の比較（判断時点に仮定した相手の Range と、実際の札。Range に入っていたか）",
  "- actualEquity: 実際の札に対する Equity と、判断時点に仮定した Range に対する Equity の違いと、その違いから学べること",
  "- bluffValue: Bluff / Value の答え合わせ（各 Bet / Raise が value だったか bluff だったか）。Bet / Raise の記録が空なら、Bet / Raise が無かったことを書く",
  "- takeaways: 次に同じような Spot で活かせる点（結果ではなく、読みの立て方・Range の想定の幅について）",
  "- evidenceIds: 根拠にした Evidence の id",
].join("\n");

/** Pass B の Prompt（user message）。Evidence の JSON と、再要求のときだけ前回の不正の理由。 */
export function buildRevealPrompt(
  evidence: RevealEvidence,
  correction?: ReviewCorrection,
): string {
  const sections = [
    "## Evidence（Card は 2 文字で、As はスペードの A、Td はダイヤの 10）",
    JSON.stringify(evidence, cardReplacer),
    evidenceGlossary("reveal"),
  ];
  if (correction !== undefined) {
    sections.push(
      "## 前回の答えは使えなかった",
      `${correction.stage}: ${correction.reason}。Schema と Evidence の id に合わせて答え直してください。`,
    );
  }
  return sections.join("\n\n");
}

/** 構造化出力の JSON Schema（evidenceIds の候補はその Evidence の id に絞る。最終判断は checkRevealOutput）。 */
export function revealOutputSchema(
  evidence: RevealEvidence,
): Record<string, unknown> {
  const text = { type: "string", minLength: 1, maxLength: REVIEW_TEXT_MAX };
  return {
    type: "object",
    additionalProperties: false,
    required: [...OUTPUT_KEYS],
    properties: {
      readComparison: text,
      actualEquity: text,
      bluffValue: text,
      takeaways: {
        type: "array",
        minItems: 1,
        maxItems: TAKEAWAYS_MAX,
        items: { type: "string", minLength: 1, maxLength: ITEM_TEXT_MAX },
      },
      evidenceIds: {
        type: "array",
        minItems: 1,
        maxItems: EVIDENCE_IDS_MAX,
        items: { type: "string", enum: [...allRevealEvidenceIds(evidence)] },
      },
    },
  };
}

/**
 * Pass B の出力を検証する（unknown で受ける）。
 * 1. schema: 形（知らない項目が無い・空でない文・文字数・件数）
 * 2. grounding: evidenceIds が Evidence に実在する
 */
export function checkRevealOutput(
  output: unknown,
  evidence: RevealEvidence,
): RevealOutputCheck {
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
  const texts: Record<string, string> = {};
  for (const key of ["readComparison", "actualEquity", "bluffValue"]) {
    const value = o[key];
    if (!isText(value, REVIEW_TEXT_MAX) || value.trim() === "") {
      return schema(`${key} は空でない ${REVIEW_TEXT_MAX} 字以内の文字列`);
    }
    texts[key] = value.trim();
  }
  const takeaways = textList(o["takeaways"], TAKEAWAYS_MAX);
  if (takeaways === null) {
    return schema(
      `takeaways は 1〜${TAKEAWAYS_MAX} 個の空でない ${ITEM_TEXT_MAX} 字以内の文字列`,
    );
  }
  const evidenceIds = textList(o["evidenceIds"], EVIDENCE_IDS_MAX);
  if (evidenceIds === null) {
    return schema(`evidenceIds は 1〜${EVIDENCE_IDS_MAX} 個の id`);
  }
  const known = allRevealEvidenceIds(evidence);
  const unknownIds = evidenceIds.filter((id) => !known.has(id));
  if (unknownIds.length > 0) {
    return {
      ok: false,
      stage: "grounding",
      reason: `Evidence に無い id: ${unknownIds.join(", ")}`,
    };
  }
  return {
    ok: true,
    value: {
      readComparison: texts["readComparison"] as string,
      actualEquity: texts["actualEquity"] as string,
      bluffValue: texts["bluffValue"] as string,
      takeaways,
      evidenceIds: [...new Set(evidenceIds)],
    },
  };
}
