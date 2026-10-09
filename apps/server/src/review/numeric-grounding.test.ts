// Review の文の中の数値の Grounding（#168・D131）のテスト。Claude は呼ばない（Fake。D87）。
// - 数値表: Evidence から決定論で作る（同じ Evidence なら同じ表・N1 から採番・書式は UI と揃える）
// - 照合: 未知の参照・{} の無い参照・参照の後ろの単位の重ね書き・% / pt / BB 付きの生の数値で表と一致しないものは不正。
//   単位の無い数（3-Bet・6-max・50/30/20 等）は検査しない。丸め・「約」・BB 併記・全角％ で誤検知しない
// - 生成: 不正なら既存の Retry の枠（最大 2 回）だけで直させ、通った文は参照を表の値に置き換えて保存する（Pass A・Follow-up）
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  heroInformationSets,
  type HeroInformationSet,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { loadKb } from "../kb/index.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import {
  BTN_VS_UTG,
  BUBBLE_SHOVE,
  playScriptedHand,
  tournamentSessionOf,
  type ScriptedHand,
} from "../testing/review-eval/hands.js";
import { buildReviewEvidence, reviewSpotReasons } from "./evidence.js";
import {
  buildFollowUpPrompt,
  checkFollowUpOutput,
  followUpSystemPrompt,
  generateFollowUp,
} from "./followup.js";
import { generateReview } from "./generate.js";
import { toPlayerNames } from "./identifiers.js";
import {
  NUMERIC_GROUNDING_REASON_PREFIX,
  buildNumericTable,
  checkNumericGrounding,
  resolveNumericRefs,
  type NumericTable,
} from "./numeric-grounding.js";
import {
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  checkReviewOutput,
} from "./review-ai.js";
import type { FollowUpTarget } from "./reveal-types.js";
import type { ReviewEvidence } from "./types.js";

const kb = loadKb();
const solver = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});

async function evidenceOf(
  hand: ScriptedHand,
  index: number,
): Promise<ReviewEvidence> {
  const sets = heroInformationSets(playScriptedHand(hand), "hero");
  const tournament = tournamentSessionOf(hand);
  return buildReviewEvidence(
    sets[index] as HeroInformationSet,
    reviewSpotReasons(sets, index, tournament),
    {
      kb,
      solver,
      playerNames: toPlayerNames(PHASE1_TABLE_SETUP.players),
      ...(tournament === undefined ? {} : { tournament }),
    },
  );
}

/** BTN vs UTG の River の Call（Pot 55・Call 24・Pot Odds 24 / 79 ≈ 30.38%・Equity 13 / 34 ≈ 38.24%）。 */
const river = await evidenceOf(BTN_VS_UTG, 3);
const table = buildNumericTable(river);

function rowOf(t: NumericTable, label: string) {
  const row = t.rows.find((r) => r.label === label);
  if (row === undefined) throw new Error(`数値表に無い行: ${label}`);
  return row;
}

/** その説明の行の参照（{N3}）。 */
const ref = (label: string, t: NumericTable = table) =>
  `{${rowOf(t, label).key}}`;

describe("数値表（buildNumericTable）", () => {
  it("同じ Evidence なら同じ表で、参照キーは N1 から順に採番する", () => {
    expect(buildNumericTable(river)).toEqual(table);
    expect(table.rows.map((r) => r.key)).toEqual(
      table.rows.map((_, i) => `N${i + 1}`),
    );
    expect(table.rows[0]).toMatchObject({
      key: "N1",
      label: "Small Blind",
      display: "1",
      bbHint: "0.5 BB",
    });
  });

  it("書式は UI と揃える: 比率は整数の %・額は Chip の実額（BB 換算は参考）・簡易 EV は符号付きの整数", () => {
    expect(rowOf(table, "Pot Odds")).toMatchObject({ display: "30%" });
    expect(rowOf(table, "Pot Odds").percent).toBeCloseTo(30.38, 2);
    expect(rowOf(table, "判断時点の Pot")).toMatchObject({
      display: "55",
      bbHint: "27.5 BB",
      bb: 27.5,
    });
    expect(rowOf(table, "仮定した Range に対する Equity")).toMatchObject({
      display: "38%",
    });
    expect(rowOf(table, "SPR").display).toBe("2.9");
    expect(rowOf(table, "Call の簡易 EV").display).toMatch(/^\+\d+$/);
    expect(
      rowOf(table, "All-in（その Street の累計 186） の簡易 EV").display,
    ).toMatch(/^−\d+$/);
    // 文に出る名前は表示名（内部の playerId を表に出さない）。
    expect(table.rows.some((r) => /cpu\d/.test(r.label))).toBe(false);
  });

  it("Tournament: ICM Equity は小数第 1 位の pt と %・賞金は pt と総額に対する割合・Stack の BB 換算・Chip EV / ICM の必要 Equity", async () => {
    const shove = buildNumericTable(await evidenceOf(BUBBLE_SHOVE, 0));
    expect(rowOf(shove, "Hero の ICM Equity").display).toMatch(/^\d+\.\dpt$/);
    expect(
      rowOf(shove, "Hero の ICM Equity（賞金の総額に対する割合）").display,
    ).toMatch(/^\d+\.\d%$/);
    expect(rowOf(shove, "賞金の総額（Prize Pool）").display).toBe("600pt");
    expect(rowOf(shove, "1 位の賞金")).toMatchObject({
      display: "300pt",
      percent: 50,
    });
    expect(rowOf(shove, "Hero の Stack の BB 換算").display).toBe("10 BB");
    expect(
      rowOf(shove, "CPU 1 に Call された場合の Chip EV の必要 Equity").display,
    ).toMatch(/^\d+\.\d%$/);
    expect(
      rowOf(shove, "CPU 1 に Call された場合の ICM の必要 Equity").display,
    ).toMatch(/^\d+\.\d%$/);
    // 賞金の構造（50 / 30 / 20）と ICM の値は照合を通る。
    expect(
      checkNumericGrounding(
        [
          `賞金は 50%・30%・20% で、Hero の ICM Equity は ${rowOf(shove, "Hero の ICM Equity").display}、Stack は 10BB。`,
        ],
        shove,
      ),
    ).toBeNull();
    expect(
      checkNumericGrounding(["Hero の ICM Equity は 125.0pt。"], shove),
    ).toMatch(/125\.0pt/);
  });

  it("Pass A の Prompt に数値表の節が入り、System Prompt は参照で書くよう指示する", () => {
    const prompt = buildReviewPrompt(river);
    expect(prompt).toContain("## 数値表");
    expect(prompt).toContain("- {N1} Small Blind = 1（0.5 BB）");
    expect(prompt).toContain(`- ${ref("Pot Odds")} Pot Odds = 30%`);
    expect(REVIEW_SYSTEM_PROMPT).toContain("参照（{N3} の形）");
  });
});

describe("文の中の数値の照合（checkNumericGrounding）", () => {
  it.each([
    [
      "参照",
      `必要 Equity は ${ref("Pot Odds")} で、Equity は ${ref("仮定した Range に対する Equity")}。`,
    ],
    ["表示の丸めの値", "Pot Odds は 30%。"],
    ["小数第 1 位の丸め", "Pot Odds は 30.4%、Equity は 38.2%。"],
    ["小数第 2 位", "Pot Odds は 30.38%。"],
    ["「約」は 1 桁分まで許す", "Pot Odds は約 31%。"],
    ["「前後」も概数", "Pot Odds は 31% 前後。"],
    ["全角の数字と ％", "Pot Odds は３０％。"],
    ["単位の無い 3-Bet・4-Bet", "3-Bet や 4-Bet の頻度は低い。"],
    ["単位の無い 6-max", "6-max の卓で 5 人が Fold した。"],
    ["単位の無い 50/30/20", "賞金の配分は 50/30/20。"],
    [
      "BB 併記（参照の後ろの括弧）",
      `Call は ${ref("Call に必要な額")}（12 BB）。`,
    ],
    ["BB 併記（空白なし）", "有効 Stack は 162（81BB）。"],
    [
      "簡易 EV の BB は符号を言葉で書いてよい",
      "Call の簡易 EV は 3.1 BB の得。",
    ],
    ["Range の絞り込みの割合", "Made Hand の上位 50% を残す想定。"],
    ["Equity と Pot Odds の差", "Equity は必要 Equity を 8% 上回る。"],
    ["席の表示名の数字を数値として読まない", "CPU 4 BB の席は Fold 済み。"],
  ])("通る: %s", (_name, text) => {
    expect(checkNumericGrounding([text], table)).toBeNull();
  });

  it.each([
    ["表に無い %", "必要 Equity は約 34%。", "34%"],
    ["「約」の無い丸め違い", "Pot Odds は 31%。", "31%"],
    ["小数の丸め違い", "Equity は 38.3%。", "38.3%"],
    ["全角の表に無い値", "Pot Odds は３４％。", "34%"],
    ["自分で計算した差", "Equity は必要 Equity を 12% 上回る。", "12%"],
    ["表に無い BB 換算", "Pot は 30 BB。", "30 BB"],
    ["表に無い pt", "ICM Equity は 98.2pt。", "98.2pt"],
  ])("不正: %s", (_name, text, value) => {
    const reason = checkNumericGrounding([text], table);
    expect(reason).toMatch(new RegExp(`^${NUMERIC_GROUNDING_REASON_PREFIX}: `));
    expect(reason).toContain(value);
  });

  it("未知の参照・{} の無い参照・単位を含む値の参照の後ろの単位は不正", () => {
    expect(checkNumericGrounding(["Pot は {N999}。"], table)).toContain(
      "数値表に無い参照 {N999}",
    );
    expect(
      checkNumericGrounding(
        [`Pot は ${rowOf(table, "判断時点の Pot").key}。`],
        table,
      ),
    ).toContain("参照は {} で囲んで書く");
    expect(
      checkNumericGrounding([`Pot Odds は ${ref("Pot Odds")}%。`], table),
    ).toContain("参照の後ろに単位を重ねない");
    // 額の参照の後ろに BB を書くと、置き換えた後の値（55 BB）として照合する。
    expect(
      checkNumericGrounding([`Pot は ${ref("判断時点の Pot")} BB。`], table),
    ).toContain("55 BB");
  });

  it("全角の括弧の参照も参照として読む", () => {
    const key = rowOf(table, "Pot Odds").key;
    expect(
      checkNumericGrounding([`Pot Odds は｛${key}｝。`], table),
    ).toBeNull();
    expect(resolveNumericRefs(`Pot Odds は｛${key}｝。`, table)).toBe(
      "Pot Odds は30%。",
    );
  });

  it("extraTexts（Hero の質問）に書かれた値は一致として扱う", () => {
    const answer = "66% の Bet でも Call は妥当です。";
    expect(checkNumericGrounding([answer], table)).toContain("66%");
    expect(
      checkNumericGrounding([answer], table, ["相手が 66% の Bet なら？"]),
    ).toBeNull();
  });
});

describe("参照の置き換え（resolveNumericRefs）", () => {
  it("文の参照を表の値に置き換え、根拠の id は触らない", () => {
    const value = {
      practical: `Pot ${ref("判断時点の Pot")} に ${ref("Call に必要な額")} の Call（Pot Odds ${ref("Pot Odds")}）。`,
      assumptions: [`Equity は ${ref("仮定した Range に対する Equity")}`],
      evidenceIds: ["{N1}"],
    };
    expect(resolveNumericRefs(value, table)).toEqual({
      practical: "Pot 55 に 24 の Call（Pot Odds 30%）。",
      assumptions: ["Equity は 38%"],
      evidenceIds: ["{N1}"],
    });
  });
});

/** 呼ばれるたびに outputs の次の値を返す Fake。受け取った Prompt を記録する。 */
function scriptedQuery(outputs: readonly unknown[]) {
  const prompts: string[] = [];
  let i = 0;
  const query: ClaudeQuery = (params) => {
    prompts.push(params.prompt);
    const output = outputs[i++];
    return (async function* () {
      await Promise.resolve();
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: output,
      } as unknown as SDKMessage;
    })();
  };
  return { query, prompts };
}

function reviewOutput(practical: string) {
  return {
    assessment: "reasonable",
    confidence: "medium",
    practical,
    theoryBasis: "general_theory",
    theory:
      "Bet の大きさに対して守る頻度の考え方では、上位の Hand で Call する。",
    exploitBasis: "none",
    exploit: "",
    assumptions: [
      `相手の Range は ${ref("CPU 3 の仮定した Range の Combo 数")} Combo`,
    ],
    conclusionChangers: ["相手の Range がもっと狭いなら Fold 寄り"],
    evidenceIds: [river.math.id],
  };
}

const goodPractical = `必要 Equity は ${ref("Pot Odds")}、Equity は ${ref("仮定した Range に対する Equity")} なので Call は妥当。`;
const badPractical = "必要 Equity は約 34%、Equity は 45% なので Call は妥当。";

describe("Pass A の生成（generateReview）", () => {
  it("数値が表と一致しない出力は grounding の不正として理由を付けて 1 回だけ再要求し、通った文は参照を置き換えて保存する", async () => {
    const fake = scriptedQuery([
      reviewOutput(badPractical),
      reviewOutput(goodPractical),
    ]);
    const draft = await generateReview(river, {
      depth: "standard",
      actionSeq: 1,
      env: {},
      query: fake.query,
    });
    expect(fake.prompts).toHaveLength(2);
    expect(fake.prompts[1]).toContain(
      `grounding: ${NUMERIC_GROUNDING_REASON_PREFIX}`,
    );
    expect(draft.generatedBy).toBe("review_ai");
    expect(draft.explanation.practical).toBe(
      "必要 Equity は 30%、Equity は 38% なので Call は妥当。",
    );
    expect(draft.assumptions).toEqual(["相手の Range は 34 Combo"]);
  });

  it("2 回続けて数値が不正なら Insufficient Evidence にし、3 回目は呼ばない（Retry の上限は増やさない）", async () => {
    const fake = scriptedQuery([
      reviewOutput(badPractical),
      reviewOutput("Pot Odds は {N999}。"),
      reviewOutput(goodPractical),
    ]);
    const draft = await generateReview(river, {
      depth: "standard",
      actionSeq: 1,
      env: {},
      query: fake.query,
    });
    expect(fake.prompts).toHaveLength(2);
    expect(draft.generatedBy).toBe("invalid_output_fallback");
    expect(draft.failure?.attempts.map((a) => a.stage)).toEqual([
      "grounding",
      "grounding",
    ]);
  });

  it("checkReviewOutput は assumptions・conclusionChangers の数値も照合する", () => {
    const check = checkReviewOutput(
      {
        ...reviewOutput(goodPractical),
        conclusionChangers: ["相手の Bluff が 40% を超えるなら Call"],
      },
      river,
    );
    expect(check).toMatchObject({ ok: false, stage: "grounding" });
  });
});

describe("Follow-up（Pass A の Review への質問）", () => {
  const target: Extract<FollowUpTarget, { pass: "decision" }> = {
    pass: "decision",
    reviewId: "r1",
    handId: river.handId,
    decisionIndex: 3,
    version: 1,
    evidence: river,
    explanation: {
      practical: "必要 Equity は 30%、Equity は 38% なので Call は妥当。",
      theory: { basis: "none", text: "" },
      exploit: { basis: "none", text: "" },
      conclusionChangers: ["相手の Range が狭ければ Fold"],
    },
  };

  it("Prompt に数値表の節が入り、System Prompt は参照で書くよう指示する", () => {
    expect(buildFollowUpPrompt(target, [], "なぜ Call？")).toContain(
      "## 数値表",
    );
    expect(followUpSystemPrompt("decision")).toContain("{N3} の形");
    expect(followUpSystemPrompt("reveal")).not.toContain("数値表");
  });

  it("答えの数値を照合する（質問に書かれた値は一致として扱う）", () => {
    const answer = {
      scope: "answered",
      answer: "66% の Bet でも、必要 Equity は 30% なので Call は妥当です。",
      evidenceIds: [river.math.id],
    };
    expect(checkFollowUpOutput(answer, target)).toMatchObject({
      ok: false,
      stage: "grounding",
    });
    expect(
      checkFollowUpOutput(answer, target, "相手が 66% の Bet なら？"),
    ).toMatchObject({ ok: true });
  });

  it("generateFollowUp: 不正なら既存の枠で 1 回だけ再要求し、通った答えは参照を置き換えて保存する", async () => {
    const fake = scriptedQuery([
      {
        scope: "answered",
        answer: "必要 Equity は 34% です。",
        evidenceIds: [river.math.id],
      },
      {
        scope: "answered",
        answer: `必要 Equity は ${ref("Pot Odds")} です。`,
        evidenceIds: [river.math.id],
      },
    ]);
    const draft = await generateFollowUp(target, [], "必要 Equity は？", {
      depth: "standard",
      env: {},
      query: fake.query,
    });
    expect(fake.prompts).toHaveLength(2);
    expect(draft.generatedBy).toBe("review_ai");
    expect(draft.answer.text).toBe("必要 Equity は 30% です。");
  });
});
