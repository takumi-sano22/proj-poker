// Reveal Review（Pass B）の Evidence・生成と、Follow-up の Prompt・検証・生成のテスト（#83）。Claude は呼ばない（D87）。
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  cardToString,
  createDeck,
  extractImportantSpots,
  heroInformationSets,
  projectLearningReveal,
  type HandEvent,
  type HeroInformationSet,
  type LearningReveal,
} from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import type { ClaudeQuery } from "../claude/structured-query.js";
import { MODEL_ROLES } from "../config.js";
import { loadKb } from "../kb/index.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import {
  allowedCardsAt,
  collectCards,
  forbiddenKeys,
} from "../testing/leaks.js";
import {
  BTN_VS_UTG,
  MULTIWAY_FLOP,
  SB_VS_BTN,
  playScriptedHand,
  type ScriptedHand,
} from "../testing/review-eval/hands.js";
import { buildReviewEvidence, evidenceIdsOf } from "./evidence.js";
import {
  FOLLOWUP_MAX_TURNS,
  buildFollowUpPrompt,
  checkFollowUpOutput,
  followUpOutputSchema,
  followUpSystemPrompt,
  generateFollowUp,
} from "./followup.js";
import { generateRevealReview } from "./generate-reveal.js";
import { checkRevealOutput, revealOutputSchema } from "./reveal-ai.js";
import {
  allRevealEvidenceIds,
  buildRevealEvidence,
} from "./reveal-evidence.js";
import type {
  FollowUpRecord,
  FollowUpTarget,
  RevealEvidence,
} from "./reveal-types.js";
import type { ReviewEvidence } from "./types.js";

const kb = loadKb();
const notInstalled = createAmaster97Adapter({
  install: { installed: false, detail: "テスト" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});

interface Fixture {
  readonly events: HandEvent[];
  readonly set: HeroInformationSet;
  readonly reveal: LearningReveal;
  readonly evidence: RevealEvidence;
}

async function fixture(
  hand: ScriptedHand,
  decisionIndex: number,
): Promise<Fixture> {
  const events = playScriptedHand(hand);
  const sets = heroInformationSets(events, "hero");
  const set = sets[decisionIndex] as HeroInformationSet;
  const reveal = projectLearningReveal(events) as LearningReveal;
  const reasons =
    extractImportantSpots(sets).find((s) => s.decisionIndex === decisionIndex)
      ?.reasons ?? [];
  const evidence = await buildRevealEvidence(set, reveal, events, reasons);
  return { events, set, reveal, evidence };
}

const river = await fixture(BTN_VS_UTG, 3);
const turnBet = await fixture(SB_VS_BTN, 2);
const multiway = await fixture(MULTIWAY_FLOP, 1);

/** 呼ばれるたびに outputs の次の値を返す Fake。受け取った引数を記録する。 */
function scriptedQuery(outputs: readonly unknown[]) {
  const calls: { prompt: string; options: Options }[] = [];
  let i = 0;
  const query: ClaudeQuery = (params) => {
    calls.push(params);
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
  return { query, calls };
}

function validReveal(e: RevealEvidence = river.evidence) {
  return {
    readComparison:
      "UTG の Open から Bet を続けた相手の Range を仮定していた。実際は KQs で、K の Pair だった。",
    actualEquity:
      "実際の札に対する Equity は 0 で、仮定した Range に対する Equity とは違う。1 Hand の結果で Range の想定を断定しない。",
    bluffValue: "Flop の Bet は bluff、River の Bet は value だった。",
    takeaways: [
      "River の大きい Bet の Range の幅を、Board の変化と合わせて考える",
    ],
    evidenceIds: [e.reveal.id, e.equity.id],
  };
}

describe("buildRevealEvidence（Pass B の Evidence）", () => {
  it("判断時点で Pot を争っていた相手の実際の札・読み（仮定した Range）との比較・実際の Equity を決定論で作る", () => {
    const { evidence } = river;
    expect(evidence.pass).toBe("reveal");
    expect(evidence.reveal.visibility).toBe("learning_only");
    const utg = evidence.reveal.villains.find((v) => v.playerId === "cpu3");
    expect(utg).toMatchObject({
      activeAtDecision: true,
      madeHandAtDecision: "pair",
    });
    expect(utg?.holeCards.map(cardToString)).toEqual(["Ks", "Qs"]);
    expect(typeof utg?.inAssumedRange).toBe("boolean");
    expect(utg?.assumedRange?.comboCount).toBeGreaterThan(0);
    // Fold した相手も札は見せるが、読みの比較（Range）は持たない。
    const folded = evidence.reveal.villains.filter((v) => !v.activeAtDecision);
    expect(folded).toHaveLength(4);
    for (const v of folded) {
      expect(v.assumedRange).toBeNull();
      expect(v.inAssumedRange).toBeNull();
    }
    // River の判断: AJ（J の Pair）対 KQ（K の Pair）で、実際の Equity は 0（Board は 5 枚なので全列挙は 1 通り）。
    expect(evidence.equity.actual).toMatchObject({
      equity: 0,
      method: "exact",
      trials: 1,
    });
    expect(evidence.equity.heroMadeHandAtDecision).toBe("pair");
    expect(evidence.equity.assumed).not.toBeNull();
    expect(evidence.reveal.finalBoard.map(cardToString)).toEqual([
      "Jc",
      "8s",
      "3d",
      "2h",
      "Kc",
    ]);
  });

  it("Bluff / Value の答え合わせ: 判断時点までの相手の Bet / Raise を、実際の札の Equity で value / bluff に分ける", () => {
    const items = river.evidence.aggression.items;
    expect(items.map((i) => [i.playerId, i.street, i.action])).toEqual([
      ["cpu3", "preflop", "raise"],
      ["cpu3", "flop", "bet"],
      ["cpu3", "river", "bet"],
    ]);
    // Flop（J83）: KQ は AJ に負けている → bluff。River（K が落ちた）: K の Pair は J の Pair に勝っている → value。
    expect(items[1]).toMatchObject({ playersInPot: 2, label: "bluff" });
    expect(items[2]).toMatchObject({
      playersInPot: 2,
      actorEquity: 1,
      label: "value",
    });
    // Preflop の Raise の時点では 6 人全員が Pot を争っている（公平な取り分は 1/6）。
    expect(items[0]?.playersInPot).toBe(6);
    expect(river.evidence.aggression.rule).toContain("公平な取り分");
  });

  it("Hero の判断が Bet なら、その判断も答え合わせに入る（isDecision）", () => {
    const decision = turnBet.evidence.aggression.items.find(
      (i) => i.isDecision,
    );
    // Turn（T726）で 98 の Straight は AT（T の Pair）に勝っている → value。
    expect(decision).toMatchObject({
      playerId: "hero",
      isHero: true,
      street: "turn",
      action: "bet",
      label: "value",
    });
  });

  it("Multiway: Pot を争っていた相手全員の実際の札に対する Equity（Monte Carlo・seed 固定で同じ値）", async () => {
    const active = multiway.evidence.reveal.villains.filter(
      (v) => v.activeAtDecision,
    );
    expect(active.map((v) => v.playerId).sort()).toEqual(["cpu2", "cpu5"]);
    expect(multiway.evidence.equity.actual?.method).toBe("monte_carlo");
    const again = await fixture(MULTIWAY_FLOP, 1);
    expect(again.evidence).toEqual(multiway.evidence);
  });

  it("入る札は配られた札と公開された Board だけ（Deck の残り・seed・system の記録・Persona は入らない）", () => {
    for (const { events, evidence } of [river, turnBet, multiway]) {
      const dealt = new Set(
        events.flatMap((e) =>
          e.type === "HOLE_CARD_DEALT" || e.type === "BOARD_DEALT"
            ? e.cards.map(cardToString)
            : [],
        ),
      );
      const cards = collectCards(evidence).map(cardToString);
      expect(cards.filter((c) => !dealt.has(c))).toEqual([]);
      expect(forbiddenKeys(evidence)).toEqual([]);
    }
  });

  it("別の Hand の Reveal は受け取らない", async () => {
    await expect(
      buildRevealEvidence(river.set, turnBet.reveal, river.events, []),
    ).rejects.toThrow(/Hand が違う/);
  });
});

describe("checkRevealOutput", () => {
  it("検証を通る出力は前後の空白を除いて返す", () => {
    expect(
      checkRevealOutput(
        { ...validReveal(), bluffValue: "  答え合わせ。 " },
        river.evidence,
      ),
    ).toMatchObject({ ok: true, value: { bluffValue: "答え合わせ。" } });
  });

  it.each<[string, Record<string, unknown>]>([
    ["知らない項目（評価を付けようとした）", { assessment: "strong" }],
    ["readComparison が空", { readComparison: " " }],
    ["takeaways が空", { takeaways: [] }],
    ["evidenceIds が空", { evidenceIds: [] }],
  ])("Schema の不正: %s", (_label, patch) => {
    expect(
      checkRevealOutput({ ...validReveal(), ...patch }, river.evidence),
    ).toMatchObject({ ok: false, stage: "schema" });
  });

  it("根拠の不正: Evidence に無い id", () => {
    expect(
      checkRevealOutput(
        { ...validReveal(), evidenceIds: ["math:made-up"] },
        river.evidence,
      ),
    ).toMatchObject({ ok: false, stage: "grounding" });
  });

  it("Schema は評価（assessment）を持たず、evidenceIds の候補は Pass B の Evidence の id だけ", () => {
    const schema = revealOutputSchema(river.evidence) as {
      properties: Record<string, { items?: { enum: string[] } }>;
    };
    expect(Object.keys(schema.properties)).not.toContain("assessment");
    expect(new Set(schema.properties["evidenceIds"]?.items?.enum)).toEqual(
      allRevealEvidenceIds(river.evidence),
    );
  });
});

describe("generateRevealReview", () => {
  it("検証を通った出力を Pass B にする（評価を持たない・review_standard・挙げた id を cited に）", async () => {
    const fake = scriptedQuery([validReveal()]);
    const draft = await generateRevealReview(river.evidence, {
      depth: "standard",
      actionSeq: river.set.decision.actionSeq,
      env: {},
      query: fake.query,
    });
    expect(draft).toMatchObject({
      pass: "reveal",
      modelRole: "review_standard",
      concreteModel: MODEL_ROLES.review_standard,
      generatedBy: "review_ai",
      failure: null,
      evidenceIds: {
        cited: [river.evidence.reveal.id, river.evidence.equity.id],
      },
    });
    expect(draft).not.toHaveProperty("assessment");
    expect(fake.calls[0]?.options.model).toBe(MODEL_ROLES.review_standard);
    // Prompt は Pass B の Evidence（実際の札を含む）。
    expect(fake.calls[0]?.prompt).toContain('"Ks"');
  });

  it("「詳しく」（deep）のときだけ review_deep（D97）", async () => {
    const fake = scriptedQuery([validReveal()]);
    const draft = await generateRevealReview(river.evidence, {
      depth: "deep",
      actionSeq: 0,
      env: {},
      query: fake.query,
    });
    expect(draft.modelRole).toBe("review_deep");
    expect(fake.calls[0]?.options.model).toBe(MODEL_ROLES.review_deep);
  });

  it("不正なら理由を付けて 1 回だけ再要求し、2 回続けて不正なら説明を作らずに失敗を残す", async () => {
    const fake = scriptedQuery([{ assessment: "strong" }, null]);
    const draft = await generateRevealReview(river.evidence, {
      depth: "standard",
      actionSeq: 0,
      env: {},
      query: fake.query,
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.prompt).toContain("前回の答えは使えなかった");
    expect(draft.generatedBy).toBe("invalid_output_fallback");
    expect(draft.failure?.attempts).toHaveLength(2);
    expect(draft.explanation.takeaways).toEqual([]);
  });
});

/** Pass A の Review の Version（Follow-up の対象）。 */
async function decisionTarget(): Promise<
  Extract<FollowUpTarget, { pass: "decision" }>
> {
  const sets = heroInformationSets(river.events, "hero");
  const evidence: ReviewEvidence = await buildReviewEvidence(
    sets[3] as HeroInformationSet,
    [],
    { kb, solver: notInstalled },
  );
  return {
    pass: "decision",
    reviewId: "r-decision",
    handId: evidence.handId,
    decisionIndex: 3,
    version: 1,
    evidence,
    explanation: {
      practical: "必要 Equity に対して Call は妥当。",
      theory: { basis: "none", text: "" },
      exploit: { basis: "none", text: "" },
      conclusionChangers: ["相手の Range が狭ければ Fold"],
    },
  };
}

const revealTarget: Extract<FollowUpTarget, { pass: "reveal" }> = {
  pass: "reveal",
  reviewId: "r-reveal",
  handId: river.evidence.handId,
  decisionIndex: 3,
  version: 1,
  evidence: river.evidence,
  explanation: {
    readComparison: "実際は KQs だった。",
    actualEquity: "実際の Equity は 0。",
    bluffValue: "River の Bet は value。",
    takeaways: ["Range の幅を考える"],
  },
};

function turn(n: number, question: string, answer: string): FollowUpRecord {
  return {
    followupId: `f${n}`,
    reviewId: "r-decision",
    pass: "decision",
    handId: river.evidence.handId,
    decisionIndex: 3,
    reviewVersion: 1,
    turn: n,
    createdAt: "2026-10-06T00:00:00.000Z",
    depth: "standard",
    modelRole: "review_standard",
    concreteModel: MODEL_ROLES.review_standard,
    generatedBy: "review_ai",
    question,
    answer: { scope: "answered", text: answer, evidenceIds: [] },
    failure: null,
  };
}

describe("Follow-up", () => {
  it("Pass A への質問の Prompt には、判断時点の Hero が知り得ない札（相手の実際の札・後の Board）が入らない", async () => {
    const target = await decisionTarget();
    const prompt = buildFollowUpPrompt(
      target,
      [turn(1, "Fold は？", "Pot Odds から見て Call が妥当。")],
      "相手の実際の札は何でしたか？",
    );
    const decisionPoint = river.set.decision.decisionPointSeq;
    const allowed = allowedCardsAt(river.events, "hero", decisionPoint);
    const leaked = createDeck()
      .map(cardToString)
      .filter((c) => !allowed.has(c) && prompt.includes(`"${c}"`));
    expect(leaked).toEqual([]);
    expect(prompt).not.toContain("learning_only");
    // 同じ判断の Pass B の Prompt には実際の札が入る（検査が漏れを見つけられることの確認）。
    const revealPrompt = buildFollowUpPrompt(revealTarget, [], "相手の札は？");
    expect(revealPrompt).toContain('"Ks"');
    expect(revealPrompt).toContain("learning_only");
  });

  it("Pass ごとに範囲の指示を文ごと出し分ける（Pass A は Hand 後の情報を知らない・Pass B は結果で評価を付け直さない）", () => {
    const decision = followUpSystemPrompt("decision");
    const reveal = followUpSystemPrompt("reveal");
    expect(decision).toContain("Reveal Review）で確かめられる");
    expect(decision).not.toContain("全員の札を見せた答え合わせ");
    expect(reveal).toContain("全員の札を見せた答え合わせ");
    expect(reveal).not.toContain("Reveal Review）で確かめられる");
  });

  it("複数ターン: これまでの質問と答えを古い順に Prompt へ入れ、今回の質問を最後に置く", async () => {
    const target = await decisionTarget();
    const prompt = buildFollowUpPrompt(
      target,
      [turn(1, "質問A", "答えA"), turn(2, "質問B", "答えB")],
      "質問C",
    );
    const order = ["質問A", "答えA", "質問B", "答えB", "質問C"].map((t) =>
      prompt.indexOf(t),
    );
    expect(order.every((p) => p >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt.indexOf("## 今回の質問")).toBeLessThan(
      prompt.indexOf("質問C"),
    );
  });

  it("出力の検証: answered は根拠の id が要る・Evidence に無い id は不正・out_of_scope は根拠なしでよい", async () => {
    const target = await decisionTarget();
    const id = target.evidence.math.id;
    expect(
      checkFollowUpOutput(
        { scope: "answered", answer: " Call が妥当。 ", evidenceIds: [id] },
        target,
      ),
    ).toEqual({
      ok: true,
      value: { scope: "answered", text: "Call が妥当。", evidenceIds: [id] },
    });
    expect(
      checkFollowUpOutput(
        { scope: "answered", answer: "妥当", evidenceIds: [] },
        target,
      ),
    ).toMatchObject({ ok: false, stage: "grounding" });
    // Pass A の Follow-up で Pass B の id は挙げられない。
    expect(
      checkFollowUpOutput(
        {
          scope: "answered",
          answer: "妥当",
          evidenceIds: [river.evidence.reveal.id],
        },
        target,
      ),
    ).toMatchObject({ ok: false, stage: "grounding" });
    expect(
      checkFollowUpOutput(
        {
          scope: "out_of_scope",
          answer: "判断時点の情報には無い。",
          evidenceIds: [],
        },
        target,
      ),
    ).toMatchObject({ ok: true, value: { scope: "out_of_scope" } });
    expect(
      checkFollowUpOutput(
        { scope: "maybe", answer: "x", evidenceIds: [] },
        target,
      ),
    ).toMatchObject({ ok: false, stage: "schema" });
    const schema = followUpOutputSchema(target) as {
      properties: { evidenceIds: { items: { enum: string[] } } };
    };
    expect(new Set(schema.properties.evidenceIds.items.enum)).toEqual(
      new Set([
        ...evidenceIdsOf(target.evidence).context,
        ...evidenceIdsOf(target.evidence).math,
        ...evidenceIdsOf(target.evidence).range,
        ...evidenceIdsOf(target.evidence).knowledge,
      ]),
    );
  });

  it("generateFollowUp: 答えを作り、対象の Review の Version に紐づける。2 回続けて不正なら答えずに失敗を残す", async () => {
    const target = await decisionTarget();
    const ok = scriptedQuery([
      {
        scope: "answered",
        answer: "Pot Odds から見て Call。",
        evidenceIds: [target.evidence.math.id],
      },
    ]);
    const draft = await generateFollowUp(target, [], "Fold は？", {
      depth: "standard",
      env: {},
      query: ok.query,
    });
    expect(draft).toMatchObject({
      reviewId: "r-decision",
      pass: "decision",
      reviewVersion: 1,
      question: "Fold は？",
      generatedBy: "review_ai",
      modelRole: "review_standard",
      answer: { scope: "answered" },
    });
    // D87 の呼び出し方: 単発の問い合わせ・ツールなし・セッションを残さない。
    expect(ok.calls[0]?.options).toMatchObject({
      tools: [],
      persistSession: false,
      settingSources: [],
    });
    expect(ok.calls[0]?.options.systemPrompt).toBe(
      followUpSystemPrompt("decision"),
    );

    const bad = scriptedQuery([null, { scope: "answered" }]);
    const failed = await generateFollowUp(target, [], "Fold は？", {
      depth: "deep",
      env: {},
      query: bad.query,
    });
    expect(bad.calls).toHaveLength(2);
    expect(bad.calls[0]?.options.model).toBe(MODEL_ROLES.review_deep);
    expect(failed).toMatchObject({
      generatedBy: "invalid_output_fallback",
      answer: { scope: "unanswered", evidenceIds: [] },
    });
    expect(failed.failure?.attempts).toHaveLength(2);
    expect(FOLLOWUP_MAX_TURNS).toBeGreaterThan(1);
  });
});
