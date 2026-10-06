// AI Opponent Eval のハーネスと集計のテスト。Claude は呼ばない（D87）: query() を Fake か録画の再生に差し替える。
import { readFileSync } from "node:fs";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { MODEL_ROLES } from "../../config.js";
import type { ClaudeQuery } from "../../opponents/claude-opponent.js";
import {
  PERSONA_PRESET_IDS,
  type PersonaPresetId,
} from "../../opponents/persona.js";
import { hashParams, runOpponentEval, type EvalRecord } from "./harness.js";
import {
  assertPopulation,
  summarizeOpponentEval,
  unmetTargets,
} from "./metrics.js";
import {
  RECORDING_URL,
  createReplayClock,
  replayQueryFor,
  type OpponentEvalRecording,
} from "./recording.js";
import { OPPONENT_EVAL_SPOTS } from "./spots.js";

/** 呼ばれるたびに outputs の次の値を構造化出力として返す Fake（受け取った Prompt を記録する）。 */
function scriptedQuery(outputs: readonly unknown[]): {
  query: ClaudeQuery;
  prompts: string[];
} {
  const prompts: string[] = [];
  let i = 0;
  const query: ClaudeQuery = (params) => {
    prompts.push(params.prompt);
    const output = outputs[i++];
    return (async function* () {
      await Promise.resolve();
      if (output instanceof Error) throw output;
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

const OPEN = OPPONENT_EVAL_SPOTS.filter((s) => s.id === "preflop_open");

async function runOne(outputs: readonly unknown[], persona: PersonaPresetId) {
  const fake = scriptedQuery(outputs);
  const [record] = await runOpponentEval({
    spots: OPEN,
    personas: [persona],
    repeats: 1,
    model: "test-model",
    env: { PATH: "/usr/bin" },
    queryFor: () => fake.query,
  });
  return { record: record as EvalRecord, prompts: fake.prompts };
}

describe("runOpponentEval（本番と同じ検証・Retry）", () => {
  it("1 回目で正しい出力なら、その Action が最終で、Retry しない", async () => {
    const { record, prompts } = await runOne(
      [{ action: "raise", amount: 6 }],
      "tag_regular",
    );
    expect(record.attempts).toHaveLength(1);
    expect(record.final).toEqual({
      kind: "claude",
      action: { type: "raise", amount: 6 },
    });
    expect(record.leaks).toEqual([]);
    // 本番の Factory で、その CPU 自身の Persona だけが Prompt に入る。
    expect(prompts[0]).toContain("スタイル: TAG Regular");
  });

  it("call に amount を付けた出力は Schema の不正で、理由を付けて 1 回だけ再要求する（検証は緩めない。D40）", async () => {
    const { record, prompts } = await runOne(
      [{ action: "call", amount: 2 }, { action: "call" }],
      "calling_station",
    );
    expect(record.attempts.map((a) => a.check)).toEqual([
      { ok: false, stage: "schema", reason: "call に amount は付けない" },
      { ok: true },
    ]);
    expect(record.final).toEqual({ kind: "claude", action: { type: "call" } });
    expect(prompts[1]).toContain("## 前回の答えは使えなかった");
  });

  it("2 回続けて不正なら Fallback（本番なら RuleBot。D41）", async () => {
    const { record } = await runOne(
      [{ action: "check" }, { action: "raise", amount: 1 }],
      "maniac",
    );
    expect(record.attempts.map((a) => a.check.ok || a.check.stage)).toEqual([
      "legal_action",
      "amount_range",
    ]);
    expect(record.final).toEqual({ kind: "fallback" });
  });

  it("例外は障害として記録し、その判断を打ち切る", async () => {
    const { record } = await runOne([new Error("rate limited")], "nit");
    expect(record.attempts).toEqual([]);
    expect(record.final.kind).toBe("outage");
  });
});

describe("hashParams", () => {
  it("実行環境で変わる env・abortController・cwd は指紋に入れず、Prompt と Options の残りは入れる", () => {
    const options = { model: "m", systemPrompt: "s" } as Options;
    const base = hashParams({ prompt: "p", options });
    expect(
      hashParams({
        prompt: "p",
        options: {
          ...options,
          env: { PATH: "/x" },
          cwd: "/tmp/elsewhere",
          abortController: new AbortController(),
        },
      }),
    ).toBe(base);
    expect(hashParams({ prompt: "q", options })).not.toBe(base);
    expect(
      hashParams({ prompt: "p", options: { ...options, model: "other" } }),
    ).not.toBe(base);
  });
});

describe("summarizeOpponentEval", () => {
  const population = {
    spots: ["a", "b"],
    personas: ["nit", "maniac"] as PersonaPresetId[],
    repeats: 1,
  };
  const ok = { ok: true } as const;
  const record = (
    spotId: string,
    personaId: PersonaPresetId,
    attempts: EvalRecord["attempts"],
    final: EvalRecord["final"],
  ): EvalRecord => ({
    spotId,
    personaId,
    repeat: 1,
    attempts,
    final,
    leaks: [],
  });
  const attempt = (
    ms: number,
    check: EvalRecord["attempts"][number]["check"] = ok,
  ) => ({ paramsHash: "h", output: null, ms, check });

  it("Valid 率・Illegal Action 率・Retry 率・Fallback 率・Latency・Persona の差・Action の多様さを数える", () => {
    const summary = summarizeOpponentEval(
      [
        record("a", "nit", [attempt(100)], {
          kind: "claude",
          action: { type: "fold" },
        }),
        record(
          "a",
          "maniac",
          [
            attempt(300, { ok: false, stage: "schema", reason: "x" }),
            attempt(200),
          ],
          { kind: "claude", action: { type: "raise", amount: 6 } },
        ),
        record("b", "nit", [attempt(400)], {
          kind: "claude",
          action: { type: "fold" },
        }),
        record(
          "b",
          "maniac",
          [
            attempt(500, { ok: false, stage: "legal_action", reason: "y" }),
            attempt(600, { ok: false, stage: "amount_range", reason: "z" }),
          ],
          { kind: "fallback" },
        ),
      ],
      population,
    );
    expect(summary).toMatchObject({
      decisions: 4,
      calls: 6,
      structuredOutputValidRate: 0.833,
      illegalActionRate: 0.333,
      retryRate: 0.5,
      fallbackRate: 0.25,
      outages: 0,
      hiddenInformationLeakage: 0,
      latencyMs: { min: 100, median: 400, p90: 600, max: 600 },
      // a: nit は fold、maniac は raise で全く違う（1）。b: maniac は Fallback で Claude の判断が無いので組が無い（0）。
      personaDifferentiationBySpot: { a: 1, b: 0 },
      personaDifferentiation: 0.5,
      // nit は fold だけ（0 bit）。maniac は raise だけ（0 bit）。
      actionDiversity: { nit: 0, maniac: 0 },
      actionCounts: {
        nit: { a: { fold: 1 }, b: { fold: 1 } },
        maniac: { a: { raise: 1 }, b: {} },
      },
      invalidOutputs: [
        "a/maniac/1#1: schema: x",
        "b/maniac/1#1: legal_action: y",
        "b/maniac/1#2: amount_range: z",
      ],
    });
    expect(unmetTargets(summary)).toContain("Fallback 率 0.25 > 0.02");
  });

  it("母集団と一致しない記録（欠け・重複・余分）は集計せず例外にする", () => {
    const one = record("a", "nit", [attempt(1)], { kind: "fallback" });
    expect(() => assertPopulation([one], population)).toThrow(/欠け/);
    expect(() =>
      assertPopulation(
        [
          one,
          one,
          record("a", "maniac", [], { kind: "fallback" }),
          record("b", "nit", [], { kind: "fallback" }),
          record("b", "maniac", [], { kind: "fallback" }),
        ],
        population,
      ),
    ).toThrow(/重複 a\/nit\/1/);
  });
});

describe("録画済み応答の再生（CI。Claude を呼ばない）", () => {
  const recording = JSON.parse(
    readFileSync(RECORDING_URL, "utf8"),
  ) as OpponentEvalRecording;

  it("録画は全 Spot × 全 Persona で、本番の opponent_fast のモデルで取ったもの", () => {
    expect(recording.version).toBe(1);
    expect(recording.model).toBe(MODEL_ROLES.opponent_fast);
    expect(recording.spots).toEqual(OPPONENT_EVAL_SPOTS.map((s) => s.id));
    expect(recording.personas).toEqual(PERSONA_PRESET_IDS);
    assertPopulation(recording.cases, recording);
  });

  it("本番と同じ経路で再生し直した指標が録画時の集計と一致し、Hidden Information Leakage と障害が 0 件", async () => {
    const clock = createReplayClock();
    const records = await runOpponentEval({
      spots: OPPONENT_EVAL_SPOTS,
      personas: recording.personas,
      repeats: recording.repeats,
      model: MODEL_ROLES.opponent_fast,
      env: { PATH: "/usr/bin" },
      queryFor: replayQueryFor(recording, clock),
      clock: clock.now,
    });
    // 録画が古い（引数の指紋が違う）と再生の query が例外を投げ、障害として記録される。理由をそのまま見せる。
    expect(
      records.flatMap((r) =>
        r.final.kind === "outage" ? [r.final.message] : [],
      ),
    ).toEqual([]);
    const summary = summarizeOpponentEval(records, recording);
    expect(summary).toEqual(recording.summary);
    expect(summary.hiddenInformationLeakage).toBe(0);
    expect(summary.leaks).toEqual([]);
    expect(summary.outages).toBe(0);
    // Claude の判断で終わった Action は、すべて Engine が受け付けたもの（不正な出力は Retry か Fallback に回る）。
    expect(
      records.every(
        (r) => r.final.kind !== "claude" || r.attempts.at(-1)?.check.ok,
      ),
    ).toBe(true);
  });
});
