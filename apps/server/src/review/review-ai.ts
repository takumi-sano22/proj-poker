// Review AI（Pass A: Decision Review）の Prompt・構造化出力の Schema・出力の検証（docs/05 §6〜§9）。
// 渡すのは構造化した Evidence（ReviewEvidence）だけ。Evidence は判断時点の Hero Information Set から作るので、
// 他者の Hidden Cards・未来の Card・system の記録・CPU の Persona は入っていない（不変条件 2・3）。
// 条件付きの指示（Solver があるときだけ〜）は文で書かず、Schema の enum と検証で守らせる（llm ガイダンス 4）。
import { cardToString, type Card } from "@proj-poker/engine";
import { allEvidenceIds } from "./evidence.js";
import { evidenceGlossary } from "./identifiers.js";
import {
  buildNumericTable,
  checkNumericGrounding,
  numericTableSection,
} from "./numeric-grounding.js";
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
  "- 数値（Pot・Pot Odds・Equity・必要 Equity・簡易 EV・Combo 数・頻度）は、Evidence から作った「数値表」の参照（{N3} の形）で書いてください。参照は保存のときに表の値に置き換わります。自分で計算し直したり、表に無い数値を作ったりしないでください。",
  "- Equity の算出方法が exact なら仮定した Range の全列挙（標本の誤差は無い。試行回数は数えた組の数）、Monte Carlo なら試行回数分の試行による推定です。",
  "- 額は Chip の実額で書き、BB 換算は必要なときに括弧で添えてください。",
  "- Range と Equity は Assumption（仮定した Range）に基づく推定です。断定せず、前提を書いてください。",
  "- 簡易 EV（他の Action の簡易 EV）は前提付きの目安で、GTO / Solver の値ではありません。",
  "- Solver の結果（Evidence に入っているときだけある）は Heads-Up・抽象化した Bet Tree の近似です。Exact GTO・正解とは書かず、前提（Heads-Up の近似であること・Bet Tree・Range の想定）を添えてください。Solver の結果が無いときは Solver の結論を書かないでください。",
  "- 「GTO で X だから常に X が正しい」とは教えないでください。",
  "- KB の項目のうち、ラベルが HEURISTIC / EXPLOIT のものは経験則として書き、普遍的なルールとして断定しないでください。",
  "- 文は Hero が読みます。内部の識別子（playerId・Evidence の項目名・英字と _ でつないだ値・Evidence の id）は文に書かず、席は seats の displayName、項目は「Evidence の項目の説明」の言葉で書いてください。Evidence の id は evidenceIds にだけ入れてください。",
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

/**
 * Tournament の Hand の判断（evidence.tournament がある）の System Prompt（#189）。1 行目だけをトーナメントにし、2 行目以降は Cash と同じ
 * （Tournament の版を足しても Cash の System Prompt は変えない。Review Eval の録画の指紋を変えない）。
 */
export const TOURNAMENT_REVIEW_SYSTEM_PROMPT = REVIEW_SYSTEM_PROMPT.replace(
  "ノーリミット・テキサスホールデム（キャッシュゲーム）のコーチです",
  "ノーリミット・テキサスホールデム（トーナメント）のコーチです",
);

/** その Evidence の Review に使う System Prompt（Tournament の Evidence があるときだけトーナメントの版。構造ゲート）。 */
export function reviewSystemPromptFor(evidence: ReviewEvidence): string {
  return evidence.tournament === undefined
    ? REVIEW_SYSTEM_PROMPT
    : TOURNAMENT_REVIEW_SYSTEM_PROMPT;
}

/**
 * Tournament の Evidence があるときだけ Pass A の Prompt に添える、トーナメントの状況と ICM の読み方（D109・D130・#189）。
 * ICM の数値は決定論のコードが正本で、Review AI は説明だけを行う（計算し直させない）。
 */
export const TOURNAMENT_GUIDE = [
  "## トーナメントの状況（tournament）の扱い",
  "- この判断はトーナメントの Hand です。tournament は判断時点の公開情報（残人数・Level・Ante・賞金の構造・段階）と、そこから決定論のコードが計算した ICM（賞金の期待値）の値です。",
  "- ICM Equity・必要 Equity・BB 換算は計算済みの値です。Evidence の値をそのまま使い、ICM を自分で計算し直したり、値を作ったりしないでください。",
  "- Chip EV（Chip の損得）と ICM（賞金の期待値）は別の量です。混同せず、どちらの値かを書き分けてください。",
  "- Push / Fold の Range やその解は渡していません。それらを根拠にしないでください。",
].join("\n");

/** All-in の関わる判断で ICM の必要 Equity があるときだけ添える読み方（D130）。 */
export const TOURNAMENT_ALL_IN_GUIDE = [
  "## All-in の判断（tournament.allIn）の扱い",
  "- Chip EV の必要 Equity と ICM の必要 Equity を並べて比べてください。仮定した Range に対する Equity がそれぞれを上回るかで判断の質を考えてください。2 つの差は賞金の構造（ICM）による違いです。",
  "- 必要 Equity の前提（tournament.allIn.assumptions）を assumptions に書いてください。",
  "- 根拠にした ICM の必要 Equity の id を evidenceIds に入れてください。",
].join("\n");

/** Shove の判断にだけ添える、条件付きの値の読み方（D130。Fold Equity を推測で数値にさせない）。 */
export const TOURNAMENT_SHOVE_GUIDE = [
  "## Shove の必要 Equity の扱い",
  "- Shove の必要 Equity は、相手ごとに「その 1 人に Call され、ほかは Fold した場合」の条件付きの値です。相手が Fold する確率（Fold Equity）と Call の頻度は含みません。",
  "- Shove の良し悪しを書くときはこの前提を書き、Fold Equity や Call の頻度を推測で数値にしないでください。",
].join("\n");

/** Hero の読み（userRead）があるときだけ Pass A の Prompt に添える、読みの扱い方（D112・docs/05 §6）。 */
export const USER_READ_GUIDE = [
  "## Hero 自身の読み（userRead）の扱い",
  "- userRead は、Hero がこの判断の前に記録した読み・意図です。Hero の主張で、相手の観察の記録（Observation）ではありません。",
  "- 判断がその読みに沿っているか、読みが判断時点の公開情報（Action の履歴・Board・Pot）と整合するかを、practical で触れてください。",
  "- 相手の実際の札は渡していません。読みが当たっていたかどうかは書かないでください。",
].join("\n");

/**
 * Table Tendency（opponentObservation.tableTendency）があるときだけ Pass A の Prompt に添える、読み方（D122・docs/05 §5）。
 * 数値は決定論のコードが正本で、Review AI は説明だけを行う。卓全体の傾向を特定の相手の傾向として扱わせない。
 */
export const TABLE_TENDENCY_GUIDE = [
  "## 卓の傾向（opponentObservation.tableTendency）の扱い",
  "- 卓の傾向は、この Hand より前に Hero が座って見えた Hand の公開された Action だけから数えた、Hero 以外の卓全体の傾向です。個々の相手の傾向ではなく、相手の実際の札・この Hand の結果は含みません。",
  "- 項目は vpip（自発的に Pot に Chip を入れた割合）・pfr（Preflop で Raise した割合）・aggression_frequency（Postflop の Aggression の頻度）・showdown（札を比べて決着した Hand の割合）です。",
  "- 割合・回数・機会の数・Hand の数は Evidence の値をそのまま使い、計算し直したり作ったりしないでください。",
  "- サンプルが足りない（sufficient が false の）項目は保留です。根拠にせず、触れるならサンプルが足りないと書いてください。",
  "- 卓全体の傾向を、特定の相手の傾向として断定しないでください。exploit で卓の傾向を根拠にするときは exploitBasis を observation にし、根拠にしたサンプルが十分な項目の id を evidenceIds に入れてください。",
].join("\n");

/** Review AI へ渡す Prompt（user message）。Evidence の JSON と、再要求のときだけ前回の不正の理由。 */
export function buildReviewPrompt(
  evidence: ReviewEvidence,
  correction?: ReviewCorrection,
): string {
  const hasTableTendency = evidence.opponentObservation.status === "available";
  const sections = [
    "## Evidence（Card は 2 文字で、As はスペードの A、Td はダイヤの 10）",
    JSON.stringify(evidence, cardReplacer),
    evidenceGlossary("decision", {
      tableTendency: hasTableTendency,
      tournament: evidence.tournament !== undefined,
    }),
    // 文の数値は数値表の参照で書かせる（#168・D131）。表は Evidence から決定論で作る。
    numericTableSection(buildNumericTable(evidence)),
  ];
  // Hero の読みがあるときだけ扱い方を添える（構造ゲート。読みの無い判断の Prompt は従来と同じ文字列のまま）。
  if (evidence.userRead.status === "collected") {
    sections.push(USER_READ_GUIDE);
  }
  // 卓の傾向があるときだけ読み方を添える（構造ゲート。無い判断の Prompt は #153 より前と同じ文字列のまま）。
  if (hasTableTendency) {
    sections.push(TABLE_TENDENCY_GUIDE);
  }
  // Tournament の Evidence があるときだけ読み方を添える（構造ゲート。Cash の Prompt には足さない）。
  // All-in の判断・Shove の判断の読み方は、その値があるときだけ節ごと出し分ける（条件付きの指示を文で書かない）。
  if (evidence.tournament !== undefined) {
    sections.push(TOURNAMENT_GUIDE);
    const allIn = evidence.tournament.allIn;
    if (allIn?.status === "available") {
      sections.push(TOURNAMENT_ALL_IN_GUIDE);
      if (allIn.decision === "shove") sections.push(TOURNAMENT_SHOVE_GUIDE);
    }
  }
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
  // 相手の Observation（今は Table Tendency だけ。D122）が無ければ observation を選ばせない。
  return evidence.opponentObservation.status === "unavailable"
    ? ["none"]
    : ["observation", "none"];
}

/**
 * Review AI の出力を検証する（LLM の出力は何が来るか分からないので unknown で受ける）。
 * 1. schema: 形（知らない項目が無い・enum・文字数・件数）
 * 2. grounding: 根拠の参照（evidenceIds が Evidence に実在する・Solver の結果が無いのに solver を根拠にしない 等）と、
 *    文の中の数値（数値表の参照が実在する・% / pt / BB の付いた生の数値が表の値と一致する。#168・D131）
 * 返す値の文は参照（{N3}）のまま。保存の前に resolveNumericRefs で表の値へ置き換える（generate.ts）。
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
  if (exploit.basis === "observation") {
    if (evidence.opponentObservation.status === "unavailable") {
      return grounding(
        "相手の Observation が無いのに exploitBasis が observation",
      );
    }
    // 卓の傾向を根拠にするなら、サンプルが十分な項目の id を挙げる（保留の項目だけを根拠にさせない。D122）。
    const sufficientIds = evidence.opponentObservation.tableTendency.items
      .filter((i) => i.sufficient)
      .map((i) => i.id);
    if (!sufficientIds.some((id) => evidenceIds.includes(id))) {
      return grounding(
        `exploitBasis が observation なら evidenceIds にサンプルが十分な卓の傾向の id（${sufficientIds.join(" / ")} のどれか）を入れる`,
      );
    }
  }
  // Tournament の All-in の判断（ICM の必要 Equity がある）では、その id を 1 つ以上根拠に挙げる（ICM を無視・創作させない。D130）。
  const allIn = evidence.tournament?.allIn;
  if (allIn?.status === "available") {
    const icmIds = allIn.requirements.map((r) => r.icm.id);
    if (!icmIds.some((id) => evidenceIds.includes(id))) {
      return grounding(
        `トーナメントの All-in の判断では evidenceIds に ICM の必要 Equity の id（${icmIds.join(" / ")} のどれか）を入れる`,
      );
    }
  }
  // 文の中の数値を数値表と照合する（#168・D131）。不正なら既存の Retry の枠（最大 2 回）の中で直させる。
  const numeric = checkNumericGrounding(
    [practical, theory.text, exploit.text, ...assumptions, ...changers],
    buildNumericTable(evidence),
  );
  if (numeric !== null) return grounding(numeric);
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
