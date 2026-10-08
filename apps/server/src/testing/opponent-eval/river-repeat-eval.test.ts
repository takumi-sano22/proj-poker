// Memory 付き Prompt の Claude CPU の Eval の River の追加測定（#171・D126）のテスト。Claude は呼ばない（D87）:
// query() を dry-run の Fake か録画の再生に差し替える。D123 の録画は読むだけ。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODEL_ROLES } from "../../config.js";
import { runOpponentEval } from "./harness.js";
import {
  MEMORY_PROMPT_RECORDING_URL,
  assertOAuthRoute,
  createCallBudget,
  dryRunQuery,
  type MemoryPromptEvalRecording,
} from "./memory-prompt-eval.js";
import { assertPopulation, summarizeOpponentEval } from "./metrics.js";
import { createReplayClock, replayQueryFor } from "./recording.js";
import {
  RIVER_REPEAT_ADDED_REPEATS,
  RIVER_REPEAT_EVAL_LIMITS,
  RIVER_REPEAT_PERSONAS,
  RIVER_REPEAT_RECORDING_URL,
  RIVER_REPEAT_SPOTS,
  RIVER_REPEAT_TOTAL_REPEATS,
  assertRiverDecisionLimit,
  baseRiverCases,
  isAddedRepeat,
  renumberAddedRepeats,
  riverRateReport,
  riverRepeatCases,
  type RiverRepeatEvalRecording,
} from "./river-repeat-eval.js";

const loadBase = () =>
  JSON.parse(
    readFileSync(MEMORY_PROMPT_RECORDING_URL, "utf8"),
  ) as MemoryPromptEvalRecording;

describe("River の追加測定の母集団と上限（D126）", () => {
  it("River の 3 条件 × Persona 6 × 追加 repeat 2（2・3）で 36 ちょうど。repeat 1 は D123 の録画にあるので呼ばない", () => {
    expect(RIVER_REPEAT_SPOTS.map((s) => s.id)).toEqual([
      "river_facing_big_bet@baseline",
      "river_facing_big_bet@loose",
      "river_facing_big_bet@tight",
    ]);
    expect(RIVER_REPEAT_PERSONAS).toHaveLength(6);
    expect(RIVER_REPEAT_ADDED_REPEATS).toEqual([2, 3]);
    expect(RIVER_REPEAT_TOTAL_REPEATS).toBe(3);
    const cases = riverRepeatCases();
    expect(assertRiverDecisionLimit(cases)).toBe(36);
    expect(cases.every(isAddedRepeat)).toBe(true);
    expect(RIVER_REPEAT_EVAL_LIMITS).toEqual({
      maxDecisions: 36,
      maxCalls: 72,
    });
    expect(() =>
      assertRiverDecisionLimit([...cases, { ...cases[0]!, repeat: 4 }]),
    ).toThrow(/上限 36/);
  });

  it("dry-run はモデルを呼ばず、追加分だけを 1 判断 1 回で通し、漏れ 0 件・D123 の録画と同じ指紋（同じ条件の組み立て）", async () => {
    const budget = createCallBudget(RIVER_REPEAT_EVAL_LIMITS.maxCalls);
    const records = await runOpponentEval({
      spots: RIVER_REPEAT_SPOTS,
      personas: RIVER_REPEAT_PERSONAS,
      repeats: RIVER_REPEAT_TOTAL_REPEATS,
      model: MODEL_ROLES.opponent_fast,
      env: { PATH: "/usr/bin" },
      queryFor: () => budget.wrap(dryRunQuery),
      only: isAddedRepeat,
    });
    expect(records).toHaveLength(36);
    expect(budget.used()).toBe(36);
    expect(records.flatMap((r) => r.leaks)).toEqual([]);
    const base = baseRiverCases(loadBase());
    for (const r of records) {
      const recorded = base.find(
        (c) => c.spotId === r.spotId && c.personaId === r.personaId,
      );
      expect(r.attempts[0]?.paramsHash, `${r.spotId}/${r.personaId}`).toBe(
        recorded?.attempts[0]?.paramsHash,
      );
    }
  });

  it("OAuth 以外の経路に切り替わる変数が子プロセスの env にあれば、呼ぶ前に例外（値は出さない）", () => {
    expect(() => assertOAuthRoute({ PATH: "/usr/bin" })).not.toThrow();
    for (const key of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_BASE_URL",
    ]) {
      expect(() => assertOAuthRoute({ [key]: "secret-value" })).toThrow(key);
      expect(() => assertOAuthRoute({ [key]: "secret-value" })).not.toThrow(
        /secret-value/,
      );
    }
  });

  it("D123 の録画から River の 18 判断（repeat 1）だけを取り出す", () => {
    const base = baseRiverCases(loadBase());
    assertPopulation(base, {
      spots: RIVER_REPEAT_SPOTS.map((s) => s.id),
      personas: RIVER_REPEAT_PERSONAS,
      repeats: 1,
    });
  });
});

describe("録画済み応答の再生（CI。Claude を呼ばない）", () => {
  // 読み込みは各テストの中で行う（録画が無いときに、他の describe まで巻き込んで落とさない）。
  const load = () =>
    JSON.parse(
      readFileSync(RIVER_REPEAT_RECORDING_URL, "utf8"),
    ) as RiverRepeatEvalRecording;

  it("追加分の録画は River × Persona × repeat 2・3 がちょうど揃い、本番の opponent_fast のモデルで、上限の中で取ったもの", () => {
    const recording = load();
    expect(recording.version).toBe(1);
    expect(recording.model).toBe(MODEL_ROLES.opponent_fast);
    expect(recording.baseRecording).toBe("opponent-memory-prompt-eval.json");
    expect(recording.spots).toEqual(RIVER_REPEAT_SPOTS.map((s) => s.id));
    expect(recording.personas).toEqual(RIVER_REPEAT_PERSONAS);
    expect(recording.addedRepeats).toEqual(RIVER_REPEAT_ADDED_REPEATS);
    expect(recording.totalRepeats).toBe(RIVER_REPEAT_TOTAL_REPEATS);
    expect(recording.limits).toEqual(RIVER_REPEAT_EVAL_LIMITS);
    assertPopulation(renumberAddedRepeats(recording.cases), {
      spots: recording.spots,
      personas: recording.personas,
      repeats: RIVER_REPEAT_ADDED_REPEATS.length,
    });
    expect(recording.cases.every(isAddedRepeat)).toBe(true);
    expect(recording.modelCalls).toBeLessThanOrEqual(
      RIVER_REPEAT_EVAL_LIMITS.maxCalls,
    );
    // 録画に残った呼び出しは、実際に呼んだ回数を超えない（障害で終わった呼び出しは録画に残らない）。
    expect(
      recording.cases.reduce((n, c) => n + c.attempts.length, 0),
    ).toBeLessThanOrEqual(recording.modelCalls);
    expect(recording.summary).not.toBeNull();
    expect(recording.addedSummary).not.toBeNull();
  });

  it("D123 の録画の River の分と合わせて本番と同じ経路で再生し直した指標が録画時の集計と一致し、漏れと障害が 0 件", async () => {
    const recording = load();
    const clock = createReplayClock();
    const records = await runOpponentEval({
      spots: RIVER_REPEAT_SPOTS,
      personas: recording.personas,
      repeats: recording.totalRepeats,
      model: MODEL_ROLES.opponent_fast,
      env: { PATH: "/usr/bin" },
      queryFor: replayQueryFor(
        { cases: [...baseRiverCases(loadBase()), ...recording.cases] },
        clock,
      ),
      clock: clock.now,
    });
    // 録画が古い（Prompt・Options の指紋が違う）と再生の query が例外を投げ、障害として記録される。理由をそのまま見せる。
    expect(
      records.flatMap((r) =>
        r.final.kind === "outage" ? [r.final.message] : [],
      ),
    ).toEqual([]);
    const ids = RIVER_REPEAT_SPOTS.map((s) => s.id);
    const summary = summarizeOpponentEval(records, {
      spots: ids,
      personas: recording.personas,
      repeats: recording.totalRepeats,
    });
    expect(summary).toEqual(recording.summary);
    const addedSummary = summarizeOpponentEval(
      renumberAddedRepeats(records.filter(isAddedRepeat)),
      {
        spots: ids,
        personas: recording.personas,
        repeats: RIVER_REPEAT_ADDED_REPEATS.length,
      },
    );
    expect(addedSummary).toEqual(recording.addedSummary);
    expect(summary.decisions).toBe(54);
    expect(summary.hiddenInformationLeakage).toBe(0);
    expect(summary.leaks).toEqual([]);
    expect(summary.outages).toBe(0);
    // 条件ごとの割合が全条件で値を持つ（作業ログと docs/09 の数値の元）。
    const river = riverRateReport(summary);
    for (const id of ["baseline", "loose", "tight"] as const) {
      expect(river.total[id].n).toBeGreaterThan(0);
    }
  });
});
