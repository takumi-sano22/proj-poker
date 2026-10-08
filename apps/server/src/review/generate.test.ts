// Review AI の出力の検証と、生成（Gate → Review AI → 検証 → Retry → Insufficient Evidence）のテスト。
// Claude は呼ばない（D87）: SDK の query() を Fake に差し替える。
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  extractImportantSpots,
  heroInformationSets,
  type HeroInformationSet,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import {
  ClaudeCallError,
  type ClaudeQuery,
} from "../claude/structured-query.js";
import { MODEL_ROLES, PHASE1_TABLE_SETUP } from "../config.js";
import { loadKb } from "../kb/index.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import { forbiddenKeys } from "../testing/leaks.js";
import { withoutKbBodies } from "../testing/review-eval/harness.js";
import { BTN_VS_UTG, playScriptedHand } from "../testing/review-eval/hands.js";
import type { TableTendency } from "../memory/table-tendency.js";
import {
  EMPTY_TABLE_TENDENCY,
  INSUFFICIENT_TABLE_TENDENCY,
  SAMPLE_TABLE_TENDENCY,
} from "../testing/table-tendency-fixture.js";
import {
  allEvidenceIds,
  buildReviewEvidence,
  evidenceIdsOf,
} from "./evidence.js";
import { buildFollowUpPrompt } from "./followup.js";
import { toPlayerNames } from "./identifiers.js";
import { REVIEW_MAX_TURNS, generateReview, modelRoleFor } from "./generate.js";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TEXT_MAX,
  TABLE_TENDENCY_GUIDE,
  buildReviewPrompt,
  checkReviewOutput,
  reviewOutputSchema,
} from "./review-ai.js";
import { checkEvidenceSufficiency } from "./sufficiency.js";
import type { FollowUpTarget } from "./reveal-types.js";
import type { ReviewEvidence, SolverEvidenceItem } from "./types.js";

const kb = loadKb();
const notInstalled = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});

async function riverEvidence(): Promise<ReviewEvidence> {
  const sets = heroInformationSets(playScriptedHand(BTN_VS_UTG), "hero");
  const set = sets[3] as HeroInformationSet;
  const reasons =
    extractImportantSpots(sets).find((s) => s.decisionIndex === 3)?.reasons ??
    [];
  return buildReviewEvidence(set, reasons, { kb, solver: notInstalled });
}

const evidence = await riverEvidence();

/** Supported の Solver Evidence（形だけ）。 */
const solver: SolverEvidenceItem = {
  status: "supported",
  id: "solver:x@abc:h/d3",
  solver: { id: "x", version: "1", commit: "abc", pinnedCommit: true },
  scope: "heads_up",
  node: { street: "river", actor: "oop" },
  spot: { street: "river", board: [], pot: 31, effectiveStack: 100 },
  betTree: {
    betPotFractions: [0.5],
    raiseMultipliers: [3],
    allIn: true,
    raiseCap: 4,
  },
  strategy: [],
  heroHandClass: "AJo",
  heroHandClassStrategy: null,
  ev: { available: false, reason: "-" },
  convergence: { iterations: 1, note: "-" },
  rangeAssumptions: {
    oop: { source: "notation", notation: "AA", note: "-", comboCount: 6 },
    ip: { source: "notation", notation: "KK", note: "-", comboCount: 6 },
  },
  assumptions: [],
  warnings: [],
};

/** 検証を通る出力。 */
function validOutput(e: ReviewEvidence = evidence) {
  return {
    assessment: "reasonable",
    confidence: "medium",
    practical: `Pot 31 に 24 の Bet で、必要 Equity は約 34%。仮定した Range に対する Equity は約 ${Math.round((e.math.equity?.equity ?? 0) * 100)}% なので Call は妥当。`,
    theoryBasis: "general_theory",
    theory:
      "Bet の大きさに対して守るべき頻度の考え方では、上位の Hand で Call する。",
    exploitBasis: "none",
    exploit: "",
    assumptions: [
      "相手の Range は標準の想定（UTG の Open から Bet / Check を続けた）",
    ],
    conclusionChangers: [
      "相手の River の Bet が Value に偏っているなら Fold 寄りになる",
    ],
    evidenceIds: [e.math.id, e.range.id, e.knowledge.items[0]?.id ?? ""],
  };
}

/** 呼ばれるたびに outputs の次の値を返す Fake（Error なら assistant の error と is_error の result を流す）。受け取った引数を記録する。 */
function scriptedQuery(outputs: readonly unknown[]) {
  const calls: { prompt: string; options: Options }[] = [];
  let i = 0;
  const query: ClaudeQuery = (params) => {
    calls.push(params);
    const output = outputs[i++];
    return (async function* () {
      await Promise.resolve();
      if (output instanceof ClaudeCallError) {
        yield {
          type: "assistant",
          error: "authentication_failed",
          message: { content: [] },
        } as unknown as SDKMessage;
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in",
        } as unknown as SDKMessage;
        return;
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: output,
      } as unknown as SDKMessage;
    })();
  };
  return { query, calls };
}

const named = await (async () => {
  const sets = heroInformationSets(playScriptedHand(BTN_VS_UTG), "hero");
  const set = sets[3] as HeroInformationSet;
  return buildReviewEvidence(set, [], {
    playerNames: toPlayerNames(PHASE1_TABLE_SETUP.players),
    kb,
    solver: notInstalled,
  });
})();

describe("識別子の置換（#96・D101）", () => {
  it("Evidence の席に表示名（Hero の画面に出ている名前）が添い、Persona は入らない", () => {
    expect(named.context.seats.map((s) => [s.playerId, s.displayName])).toEqual(
      PHASE1_TABLE_SETUP.players.map((p) => [p.playerId, p.displayName]),
    );
    expect(forbiddenKeys(withoutKbBodies(named))).toEqual([]);
  });

  it("Prompt に項目の説明と、識別子を書かない指示が入る", () => {
    const prompt = buildReviewPrompt(named);
    expect(prompt).toContain('"displayName":"CPU 3"');
    expect(prompt).toContain("## Evidence の項目の説明");
    expect(prompt).toContain("- potOdds: Pot Odds");
    expect(REVIEW_SYSTEM_PROMPT).toContain("内部の識別子");
    // Pass A の Prompt に、Hand 後（Pass B）の項目の名前を出さない。
    expect(prompt).not.toContain("inAssumedRange");
  });

  it("出力に識別子があっても Retry せず、保存する説明は表示名と自然な言葉に置換する（根拠の id は触らない）", async () => {
    const fake = scriptedQuery([
      {
        ...validOutput(named),
        practical:
          "cpu3 の Bet に対する Call。potOdds=0.4 で、heroHoleCards は AJo。",
        assumptions: ["cpu3 の Range は標準の想定"],
        conclusionChangers: ["cpu3 が Bluff を増やすなら結論が変わる"],
      },
    ]);
    const draft = await generateReview(named, {
      depth: "standard",
      actionSeq: 1,
      env: {},
      query: fake.query,
    });
    expect(fake.calls).toHaveLength(1);
    expect(draft).toMatchObject({
      generatedBy: "review_ai",
      failure: null,
      explanation: {
        practical:
          "CPU 3 の Bet に対する Call。Pot Odds 0.4 で、Hero の札 は AJo。",
        conclusionChangers: ["CPU 3 が Bluff を増やすなら結論が変わる"],
      },
      assumptions: ["CPU 3 の Range は標準の想定"],
    });
    expect(draft.evidenceIds.cited).toContain(named.math.id);
  });
});

describe("checkReviewOutput", () => {
  it("検証を通る出力は、文字列の前後の空白を除いて返す", () => {
    const result = checkReviewOutput(
      { ...validOutput(), practical: "  妥当な Call。 " },
      evidence,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { practical: "妥当な Call。" },
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["知らない項目", { extra: 1 }],
    ["assessment が 6 段階の外", { assessment: "good" }],
    ["confidence が 3 段階の外", { confidence: "very_high" }],
    ["practical が空", { practical: " " }],
    ["practical が長すぎる", { practical: "あ".repeat(REVIEW_TEXT_MAX + 1) }],
    ["theoryBasis が無い", { theoryBasis: undefined }],
    [
      "theory が文字列でない（入れ子のオブジェクト）",
      { theory: { basis: "none", text: "" } },
    ],
    [
      "basis が none 以外なのに text が空",
      { theoryBasis: "general_theory", theory: "" },
    ],
    ["assumptions が空", { assumptions: [] }],
    ["conclusionChangers が文字列でない", { conclusionChangers: [1] }],
    ["evidenceIds が空", { evidenceIds: [] }],
  ])("Schema の不正: %s", (_label, patch) => {
    expect(
      checkReviewOutput({ ...validOutput(), ...patch }, evidence),
    ).toMatchObject({
      ok: false,
      stage: "schema",
    });
  });

  it("Schema の不正: オブジェクトでない・null", () => {
    expect(checkReviewOutput(null, evidence)).toMatchObject({
      ok: false,
      stage: "schema",
    });
    expect(checkReviewOutput("Call", evidence)).toMatchObject({
      ok: false,
      stage: "schema",
    });
  });

  it("根拠の不正: Evidence に無い id・Solver の結果が無いのに solver・Observation が無いのに observation", () => {
    expect(
      checkReviewOutput(
        { ...validOutput(), evidenceIds: ["kb:9.9.9:made_up@1"] },
        evidence,
      ),
    ).toMatchObject({ ok: false, stage: "grounding" });
    expect(evidence.solver.status).not.toBe("supported");
    expect(
      checkReviewOutput(
        {
          ...validOutput(),
          theoryBasis: "solver",
          theory: "Solver では Call が多い",
        },
        evidence,
      ),
    ).toMatchObject({ ok: false, stage: "grounding" });
    expect(
      checkReviewOutput(
        {
          ...validOutput(),
          exploitBasis: "observation",
          exploit: "相手は Bluff が多い",
        },
        evidence,
      ),
    ).toMatchObject({ ok: false, stage: "grounding" });
  });

  it("Solver の結果があれば theoryBasis: solver を選べるが、その Solver Evidence の id を挙げる", () => {
    const withSolver: ReviewEvidence = { ...evidence, solver };
    const theory = {
      theoryBasis: "solver",
      theory: "HU の近似では Call が多い（Exact GTO ではない）",
    };
    expect(
      checkReviewOutput({ ...validOutput(withSolver), ...theory }, withSolver),
    ).toMatchObject({ ok: false, stage: "grounding" });
    expect(
      checkReviewOutput(
        { ...validOutput(withSolver), ...theory, evidenceIds: [solver.id] },
        withSolver,
      ),
    ).toMatchObject({
      ok: true,
      value: { theory: { basis: "solver", text: theory.theory } },
    });
    // Schema の enum も、Solver の結果があるときだけ solver を含む。
    const basisEnum = (e: ReviewEvidence) =>
      (
        reviewOutputSchema(e) as {
          properties: { theoryBasis: { enum: string[] } };
        }
      ).properties.theoryBasis.enum;
    expect(basisEnum(evidence)).toEqual(["general_theory", "none"]);
    expect(basisEnum(withSolver)).toEqual(["solver", "general_theory", "none"]);
  });

  it("Schema の evidenceIds の候補は Evidence にある id だけ", () => {
    const schema = reviewOutputSchema(evidence) as {
      properties: { evidenceIds: { items: { enum: string[] } } };
    };
    expect(new Set(schema.properties.evidenceIds.items.enum)).toEqual(
      allEvidenceIds(evidence),
    );
  });
});

describe("generateReview", () => {
  it("検証を通った出力を Review にする: review_standard の具体モデル・Evidence IDs（挙げた id を cited に）・説明の順", async () => {
    const fake = scriptedQuery([validOutput()]);
    const draft = await generateReview(evidence, {
      depth: "standard",
      actionSeq: 40,
      env: { PATH: "/usr/bin" },
      query: fake.query,
    });
    expect(fake.calls).toHaveLength(1);
    const options = fake.calls[0]?.options;
    expect(options).toMatchObject({
      model: MODEL_ROLES.review_standard,
      maxTurns: REVIEW_MAX_TURNS,
      tools: [],
      settingSources: [],
      persistSession: false,
      env: { PATH: "/usr/bin" },
      outputFormat: {
        type: "json_schema",
        schema: reviewOutputSchema(evidence),
      },
    });
    expect(draft).toMatchObject({
      handId: evidence.handId,
      decisionIndex: 3,
      actionSeq: 40,
      pass: "decision",
      depth: "standard",
      modelRole: "review_standard",
      concreteModel: MODEL_ROLES.review_standard,
      kbVersion: kb.version,
      solverVersion: null,
      generatedBy: "review_ai",
      assessment: "reasonable",
      confidence: "medium",
      failure: null,
    });
    expect(Object.keys(draft.explanation)).toEqual([
      "practical",
      "theory",
      "exploit",
      "conclusionChangers",
    ]);
    expect(draft.evidenceIds.cited).toEqual(validOutput().evidenceIds);
    expect(draft.evidence).toBe(evidence);
  });

  it("詳しく（deep）は review_deep の具体モデルで呼ぶ（D97）", async () => {
    expect(modelRoleFor("deep")).toBe("review_deep");
    const fake = scriptedQuery([validOutput()]);
    const draft = await generateReview(evidence, {
      depth: "deep",
      actionSeq: 40,
      env: {},
      query: fake.query,
    });
    expect(fake.calls[0]?.options.model).toBe(MODEL_ROLES.review_deep);
    expect(draft).toMatchObject({
      modelRole: "review_deep",
      concreteModel: MODEL_ROLES.review_deep,
    });
  });

  it("不正なら理由を付けて 1 回だけ再要求し、2 回目が正しければ使う", async () => {
    const fake = scriptedQuery([{ assessment: "good" }, validOutput()]);
    const draft = await generateReview(evidence, {
      depth: "standard",
      actionSeq: 40,
      env: {},
      query: fake.query,
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.prompt).not.toContain("前回の答えは使えなかった");
    expect(fake.calls[1]?.prompt).toContain("前回の答えは使えなかった");
    expect(fake.calls[1]?.prompt).toContain("schema:");
    expect(draft.generatedBy).toBe("review_ai");
  });

  it("2 回続けて不正なら Insufficient Evidence にし、各回の段と理由を failure に残す", async () => {
    const fake = scriptedQuery([
      null,
      { ...validOutput(), evidenceIds: ["made_up"] },
      validOutput(),
    ]);
    const draft = await generateReview(evidence, {
      depth: "standard",
      actionSeq: 40,
      env: {},
      query: fake.query,
    });
    expect(fake.calls).toHaveLength(2);
    expect(draft).toMatchObject({
      generatedBy: "invalid_output_fallback",
      assessment: "insufficient_evidence",
      confidence: "low",
      concreteModel: MODEL_ROLES.review_standard,
      explanation: { theory: { basis: "none" }, exploit: { basis: "none" } },
    });
    expect(draft.failure?.attempts.map((a) => a.stage)).toEqual([
      "schema",
      "grounding",
    ]);
    expect(draft.evidenceIds.cited).toEqual([]);
  });

  it("根拠が足りなければ（Evidence Sufficiency Gate）Review AI を呼ばずに Insufficient Evidence にする", async () => {
    const thin: ReviewEvidence = {
      ...evidence,
      math: { ...evidence.math, equity: null },
      knowledge: { ...evidence.knowledge, items: [] },
    };
    expect(checkEvidenceSufficiency(thin)).toEqual({
      sufficient: false,
      missing: ["quantitative", "knowledge"],
    });
    const fake = scriptedQuery([validOutput()]);
    const draft = await generateReview(thin, {
      depth: "standard",
      actionSeq: 40,
      env: {},
      query: fake.query,
    });
    expect(fake.calls).toHaveLength(0);
    expect(draft).toMatchObject({
      generatedBy: "sufficiency_gate",
      assessment: "insufficient_evidence",
      concreteModel: null,
      failure: null,
    });
    expect(draft.explanation.practical).toContain("評価に足りる根拠が無い");
  });

  it("Solver の結果があれば、Equity が無くても Gate を通る（数値の根拠は Solver）", () => {
    const withSolverOnly: ReviewEvidence = {
      ...evidence,
      math: { ...evidence.math, equity: null },
      solver,
    };
    expect(checkEvidenceSufficiency(withSolverOnly)).toEqual({
      sufficient: true,
    });
  });

  it("Claude の呼び出しの失敗（未ログイン等）は Review を作らずに例外のまま伝える", async () => {
    const fake = scriptedQuery([new ClaudeCallError("x")]);
    await expect(
      generateReview(evidence, {
        depth: "standard",
        actionSeq: 40,
        env: {},
        query: fake.query,
      }),
    ).rejects.toMatchObject({
      name: "ClaudeCallError",
      failureKind: "unauthenticated",
    });
  });
});

describe("Table Tendency（D122・#153）の Prompt・Schema・Grounding", () => {
  async function riverWith(
    tableTendency?: TableTendency,
  ): Promise<ReviewEvidence> {
    const sets = heroInformationSets(playScriptedHand(BTN_VS_UTG), "hero");
    const set = sets[3] as HeroInformationSet;
    const reasons =
      extractImportantSpots(sets).find((s) => s.decisionIndex === 3)?.reasons ??
      [];
    return buildReviewEvidence(set, reasons, {
      kb,
      solver: notInstalled,
      ...(tableTendency === undefined ? {} : { tableTendency }),
    });
  }
  const id = (item: string) => `tendency:review-btn_vs_utg/d3/${item}`;
  const exploitEnum = (e: ReviewEvidence) =>
    (
      reviewOutputSchema(e) as {
        properties: { exploitBasis: { enum: string[] } };
      }
    ).properties.exploitBasis.enum;

  it("十分な項目があれば Opponent Observation に、項目ごとの id と決定論の割合で入り、Evidence IDs・選べる id に残る", async () => {
    const e = await riverWith(SAMPLE_TABLE_TENDENCY);
    expect(e.opponentObservation).toEqual({
      status: "available",
      tableTendency: {
        policyVersion: "phase7_table_tendency_v1",
        hands: 12,
        items: [
          {
            id: id("vpip"),
            item: "vpip",
            rate: 0.3,
            numerator: 18,
            denominator: 60,
            hands: 12,
            sufficient: true,
          },
          {
            id: id("pfr"),
            item: "pfr",
            rate: 0.117,
            numerator: 7,
            denominator: 60,
            hands: 12,
            sufficient: true,
          },
          {
            id: id("aggression_frequency"),
            item: "aggression_frequency",
            rate: 0.333,
            numerator: 5,
            denominator: 15,
            hands: 6,
            sufficient: false,
          },
          {
            id: id("showdown"),
            item: "showdown",
            rate: 0.333,
            numerator: 4,
            denominator: 12,
            hands: 12,
            sufficient: false,
          },
        ],
      },
    });
    const ids = [
      id("vpip"),
      id("pfr"),
      id("aggression_frequency"),
      id("showdown"),
    ];
    expect(evidenceIdsOf(e).tableTendency).toEqual(ids);
    for (const i of ids) expect(allEvidenceIds(e).has(i)).toBe(true);
    // Table Tendency 以外の Evidence は変わらない。
    expect({ ...e, opponentObservation: null }).toEqual({
      ...evidence,
      opponentObservation: null,
    });
  });

  it("あるときだけ Prompt に読み方と項目の説明を添え、exploitBasis に observation を選べる", async () => {
    const e = await riverWith(SAMPLE_TABLE_TENDENCY);
    const prompt = buildReviewPrompt(e);
    expect(prompt).toContain(TABLE_TENDENCY_GUIDE);
    expect(prompt).toContain("- tableTendency: 卓の傾向");
    expect(prompt).toContain("- sufficient: サンプルが十分か");
    expect(prompt).toContain(`"id":"${id("vpip")}","item":"vpip","rate":0.3`);
    expect(exploitEnum(e)).toEqual(["observation", "none"]);
    expect(exploitEnum(evidence)).toEqual(["none"]);
  });

  it("無い・Hand が 0・十分な項目が無いときは、Evidence・Prompt・Schema が #153 より前と同じ（Review Eval の録画の指紋を変えない）", async () => {
    for (const t of [
      undefined,
      EMPTY_TABLE_TENDENCY,
      INSUFFICIENT_TABLE_TENDENCY,
    ]) {
      const e = await riverWith(t);
      expect(e).toEqual(evidence);
      expect(evidenceIdsOf(e)).not.toHaveProperty("tableTendency");
      const prompt = buildReviewPrompt(e);
      expect(prompt).toBe(buildReviewPrompt(evidence));
      expect(prompt).not.toContain(TABLE_TENDENCY_GUIDE);
      expect(prompt).not.toContain("tableTendency");
      expect(reviewOutputSchema(e)).toEqual(reviewOutputSchema(evidence));
    }
  });

  it("Grounding: exploitBasis が observation なら、サンプルが十分な項目の id を挙げる（保留の項目だけ・id 無しは不正）", async () => {
    const e = await riverWith(SAMPLE_TABLE_TENDENCY);
    const exploit = {
      exploitBasis: "observation",
      exploit:
        "卓全体が Preflop で参加しやすい傾向なので、Value の幅を少し広げられる",
    };
    expect(
      checkReviewOutput({ ...validOutput(e), ...exploit }, e),
    ).toMatchObject({ ok: false, stage: "grounding" });
    expect(
      checkReviewOutput(
        {
          ...validOutput(e),
          ...exploit,
          evidenceIds: [e.math.id, id("showdown")],
        },
        e,
      ),
    ).toMatchObject({ ok: false, stage: "grounding" });
    expect(
      checkReviewOutput(
        { ...validOutput(e), ...exploit, evidenceIds: [e.math.id, id("vpip")] },
        e,
      ),
    ).toMatchObject({
      ok: true,
      value: { exploit: { basis: "observation", text: exploit.exploit } },
    });
    // exploitBasis が none なら、卓の傾向の id（保留の項目を含む）を挙げても通る。
    expect(
      checkReviewOutput(
        { ...validOutput(e), evidenceIds: [e.math.id, id("showdown")] },
        e,
      ),
    ).toMatchObject({ ok: true });
  });

  it("Follow-up（Pass A への質問）の Prompt にも、卓の傾向があるときだけ項目の説明を出す", async () => {
    const target = (e: ReviewEvidence): FollowUpTarget => ({
      pass: "decision",
      reviewId: "r1",
      handId: e.handId,
      decisionIndex: e.decisionIndex,
      version: 1,
      evidence: e,
      explanation: {
        practical: "妥当な Call。",
        theory: { basis: "none", text: "" },
        exploit: { basis: "none", text: "" },
        conclusionChangers: ["相手の Range"],
      },
    });
    const withTendency = await riverWith(SAMPLE_TABLE_TENDENCY);
    expect(
      buildFollowUpPrompt(target(withTendency), [], "卓の傾向は？"),
    ).toContain("- tableTendency: 卓の傾向");
    const without = buildFollowUpPrompt(target(evidence), [], "卓の傾向は？");
    expect(without).not.toContain("- tableTendency:");
    expect(without).not.toContain("- sufficient:");
  });
});
