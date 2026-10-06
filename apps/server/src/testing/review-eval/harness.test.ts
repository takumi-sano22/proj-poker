// Review Eval のハーネスと集計のテスト。Claude は呼ばない（D87）: query() を Fake か録画の再生に差し替える。
import { readFileSync } from "node:fs";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { ClaudeQuery } from "../../claude/structured-query.js";
import { MODEL_ROLES } from "../../config.js";
import { loadKb } from "../../kb/index.js";
import { createAmaster97Adapter } from "../../solver/amaster97-adapter.js";
import { createReplayClock } from "../opponent-eval/recording.js";
import { hashParams } from "../opponent-eval/harness.js";
import {
  REVIEW_EVAL_CASES,
  runReviewEval,
  type ReviewEvalRecord,
} from "./harness.js";
import {
  assertReviewPopulation,
  summarizeReviewEval,
  unmetReviewTargets,
} from "./metrics.js";
import {
  REVIEW_RECORDING_URL,
  replayReviewQueryFor,
  type ReviewEvalRecording,
} from "./recording.js";

const kb = loadKb();
const solver = createAmaster97Adapter({
  install: { installed: false, detail: "Review Eval（Solver なし）" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});

/** 呼ばれるたびに outputs の次の値を返す Fake。関数なら Prompt から出力を作る。Error なら例外。 */
function scriptedQuery(outputs: readonly unknown[]): ClaudeQuery {
  let i = 0;
  return (params) => {
    const next = outputs[i++];
    return (async function* () {
      await Promise.resolve();
      if (next instanceof Error) throw next;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output:
          typeof next === "function"
            ? (next as (prompt: string) => unknown)(params.prompt)
            : next,
      } as unknown as SDKMessage;
    })();
  };
}

/** Prompt の Evidence から Math と KB の id を拾って、検証を通る出力を作る。 */
function validFrom(prompt: string) {
  const math = /"id":"(math:[^"]+)"/.exec(prompt)?.[1] ?? "";
  const kbId = /"id":"(kb:[^"]+)"/.exec(prompt)?.[1] ?? "";
  return {
    assessment: "reasonable",
    confidence: "medium",
    practical: "Pot Odds と Equity から見て妥当。",
    theoryBasis: "general_theory",
    theory: "Exact GTO ではないが、理論上も守る頻度の範囲。",
    exploitBasis: "none",
    exploit: "",
    assumptions: ["相手の Range は標準の想定"],
    conclusionChangers: ["相手の Range がもっと狭いなら結論が変わる"],
    evidenceIds: [math, kbId],
  };
}

const ONE = REVIEW_EVAL_CASES.filter((c) => c.id === "btn_vs_utg/d3");

async function runOne(outputs: Parameters<typeof scriptedQuery>[0]) {
  const query = scriptedQuery(outputs);
  const [record] = await runReviewEval({
    cases: ONE,
    repeats: 1,
    kb,
    solver,
    env: { PATH: "/usr/bin" },
    queryFor: () => query,
  });
  return record as ReviewEvalRecord;
}

describe("runReviewEval（本番と同じ Evidence・生成・検証・Retry）", () => {
  it("検証を通った出力は review_ai で、漏れが無い。根拠の id を記録する", async () => {
    const record = await runOne([validFrom]);
    expect(record.attempts.map((a) => a.check)).toEqual([{ ok: true }]);
    expect(record.final).toMatchObject({
      kind: "review",
      generatedBy: "review_ai",
      assessment: "reasonable",
    });
    expect(record.leaks).toEqual([]);
    expect(record.solverStatus).toBe("unsupported");
  });

  it("不正なら 1 回だけ再要求し、2 回続けて不正なら Insufficient Evidence（Fallback）", async () => {
    const retried = await runOne([{ assessment: "good" }, validFrom]);
    expect(retried.attempts.map((a) => a.check.ok)).toEqual([false, true]);
    const fellBack = await runOne([null, { assessment: "good" }]);
    expect(fellBack.final).toMatchObject({
      kind: "review",
      generatedBy: "invalid_output_fallback",
      assessment: "insufficient_evidence",
    });
  });

  it("識別子（#96）: 既知のものは置換されて保存する Review に残らず、置換前の出方は記録する。未知のものは残存として数える", async () => {
    const withIds = (practical: string) => (prompt: string) => ({
      ...validFrom(prompt),
      practical,
    });
    const replaced = await runOne([
      withIds("cpu3 の Bet に Call。inAssumedRange=false だった。"),
    ]);
    expect(replaced.final).toMatchObject({
      kind: "review",
      identifiers: { raw: ["cpu3", "inAssumedRange"], residual: [] },
    });
    expect(replaced.final.kind === "review" && replaced.final.text).toContain(
      "CPU 3 の Bet に Call。",
    );
    const unknown = await runOne([withIds("mysteryField=1 が気になる。")]);
    expect(unknown.final).toMatchObject({
      identifiers: { raw: ["mysteryField"], residual: ["mysteryField"] },
    });
    const one = { cases: ["btn_vs_utg/d3"], repeats: 1 };
    expect(summarizeReviewEval([replaced], one)).toMatchObject({
      identifierMentionRate: 1,
      identifierResidualRate: 0,
      residualIdentifiers: [],
    });
    const summary = summarizeReviewEval([unknown], one);
    expect(summary).toMatchObject({
      identifierMentionRate: 1,
      identifierResidualRate: 1,
      residualIdentifiers: ["btn_vs_utg/d3#1: mysteryField"],
    });
    expect(unmetReviewTargets(summary)).toContain("identifierResidualRate");
    expect(
      unmetReviewTargets(summarizeReviewEval([replaced], one)),
    ).not.toContain("identifierResidualRate");
  });

  it("呼び出しの例外は障害として記録する", async () => {
    const record = await runOne([new Error("rate limited")]);
    expect(record.final.kind).toBe("outage");
  });
});

describe("summarizeReviewEval", () => {
  it("母集団と一致しない記録（欠け・重複）は集計しない", () => {
    expect(() =>
      assertReviewPopulation([{ caseId: "a", repeat: 1 }], {
        cases: ["a", "b"],
        repeats: 1,
      }),
    ).toThrow(/欠け b#1/);
    expect(() =>
      assertReviewPopulation(
        [
          { caseId: "a", repeat: 1 },
          { caseId: "a", repeat: 1 },
        ],
        { cases: ["a"], repeats: 1 },
      ),
    ).toThrow(/重複 a#1/);
  });

  it("Grounding 率・Exact GTO の言及（否定でも数える）を機械的に数える", async () => {
    const record = await runOne([validFrom]);
    const summary = summarizeReviewEval([record], {
      cases: ["btn_vs_utg/d3"],
      repeats: 1,
    });
    expect(summary).toMatchObject({
      reviews: 1,
      calls: 1,
      structuredOutputValidRate: 1,
      mathGroundingRate: 1,
      kbGroundingRate: 1,
      exactGtoMentions: 1,
      hindsightLeaks: 0,
    });
  });
});

describe("録画済み応答の再生（CI。Claude を呼ばない）", () => {
  const recording = JSON.parse(
    readFileSync(REVIEW_RECORDING_URL, "utf8"),
  ) as ReviewEvalRecording;

  it("録画は全判断で、本番の review_standard のモデル・今の KB の Version で取ったもの", () => {
    expect(recording.version).toBe(1);
    expect(recording.model).toBe(MODEL_ROLES.review_standard);
    expect(recording.kbVersion).toBe(kb.version);
    expect(recording.cases).toEqual(REVIEW_EVAL_CASES.map((c) => c.id));
    assertReviewPopulation(recording.records, recording);
  });

  it("本番と同じ経路で再生し直した指標が録画時の集計と一致し、Hindsight Leak と障害が 0 件", async () => {
    const clock = createReplayClock();
    const records = await runReviewEval({
      cases: REVIEW_EVAL_CASES,
      repeats: recording.repeats,
      kb,
      solver,
      env: { PATH: "/usr/bin" },
      queryFor: replayReviewQueryFor(recording, clock, hashParams),
      clock: clock.now,
    });
    // 録画が古い（引数の指紋が違う）と再生の query が例外を投げ、障害として記録される。理由をそのまま見せる。
    expect(
      records.flatMap((r) =>
        r.final.kind === "outage" ? [r.final.message] : [],
      ),
    ).toEqual([]);
    const summary = summarizeReviewEval(records, recording);
    expect(summary).toEqual(recording.summary);
    expect(summary.hindsightLeaks).toBe(0);
    expect(summary.leaks).toEqual([]);
    expect(summary.outages).toBe(0);
  });
});
