// Tournament の Claude CPU の Opponent Eval（#202・D132）のテスト。Claude は呼ばない（D87）:
// query() を dry-run の Fake か録画の再生に差し替える。
import { readFileSync } from "node:fs";
import { cardToString } from "@proj-poker/engine";
import { describe, expect, it } from "vitest";
import { MODEL_ROLES } from "../../config.js";
import {
  buildOpponentPrompt,
  systemPromptOf,
} from "../../opponents/claude-opponent.js";
import { PERSONA_PRESETS, describePersona } from "../../opponents/persona.js";
import { runOpponentEval } from "./harness.js";
import {
  assertShellRoute,
  createCallBudget,
  dryRunQuery,
} from "./memory-prompt-eval.js";
import { assertPopulation, summarizeOpponentEval } from "./metrics.js";
import { createReplayClock, replayQueryFor } from "./recording.js";
import { OPPONENT_EVAL_SPOTS, buildSpot } from "./spots.js";
import {
  TOURNAMENT_EVAL_LIMITS,
  TOURNAMENT_EVAL_PERSONAS,
  TOURNAMENT_EVAL_REPEATS,
  TOURNAMENT_EVAL_SPOTS,
  TOURNAMENT_RECORDING_URL,
  assertTournamentDecisionLimit,
  tournamentReport,
  type TournamentEvalRecording,
} from "./tournament-eval.js";

const spot = (id: string) => {
  const found = TOURNAMENT_EVAL_SPOTS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`Spot が無い: ${id}`);
  return buildSpot(found);
};

describe("Tournament の Spot（D132 の S0〜S6）", () => {
  it("7 Spot で、S1〜S4 は Stage だけが変わる 10BB の Open Shove の判断、S5・S6 は Shove への Call の判断", () => {
    expect(TOURNAMENT_EVAL_SPOTS.map((s) => s.id)).toEqual([
      "t0_no_context",
      "t1_before_bubble_shove",
      "t2_bubble_shove",
      "t3_itm_shove",
      "t4_heads_up_shove",
      "t5_bubble_call_vs_big",
      "t6_bubble_call_layers",
    ]);
    const stages = TOURNAMENT_EVAL_SPOTS.map(
      (s) => buildSpot(s).input.knowledge.tournament?.stage ?? null,
    );
    expect(stages).toEqual([
      null,
      "before_bubble",
      "bubble",
      "in_the_money",
      "heads_up",
      "bubble",
      "bubble",
    ]);
    for (const id of [
      "t0_no_context",
      "t1_before_bubble_shove",
      "t2_bubble_shove",
      "t3_itm_shove",
      "t4_heads_up_shove",
    ]) {
      const { input } = spot(id);
      const me = input.knowledge.seats.find((s) => s.playerId === "cpu3");
      // 判断する cpu3 は 1,500（10BB）・Qh 6c で、前は全員 Fold（Pot に Raise が無く、All-in を選べる）。
      expect((me?.stack ?? 0) + (me?.totalCommitted ?? 0), id).toBe(1_500);
      expect(input.knowledge.holeCards?.map(cardToString)).toEqual([
        "Qh",
        "6c",
      ]);
      expect(input.legal.actions.map((a) => a.type)).toContain("all_in");
    }
    const call = spot("t5_bubble_call_vs_big").input;
    expect(call.legal.actions.map((a) => a.type)).toEqual([
      "fold",
      "call",
      "all_in",
    ]);
    // Chip Leader に対する Bubble Factor が高い（2 を超える）Spot。
    const vsLeader = call.knowledge.tournament?.bubbleFactors.find(
      (b) => b.opponentId === "cpu1",
    );
    expect(vsLeader?.bubbleFactor).toBeGreaterThan(2);
  });

  it("S0 と S2・S5 と S6 は Hand の ID が同じで、S6 だけ Memory（Tournament の Hypothesis）・Table Tendency・Tilt がある", () => {
    expect(spot("t0_no_context").input.knowledge.handId).toBe(
      spot("t2_bubble_shove").input.knowledge.handId,
    );
    const s5 = spot("t5_bubble_call_vs_big").input.knowledge;
    const s6 = spot("t6_bubble_call_layers").input.knowledge;
    expect(s6.handId).toBe(s5.handId);
    expect(s5.memory).toBeUndefined();
    expect(s5.tilt).toBeUndefined();
    expect(s5.tableTendency).toBeUndefined();
    expect(s6.memory?.context).toBe("tournament");
    expect(s6.tilt).toBeDefined();
    expect(s6.tableTendency).toBeDefined();
  });

  it("Context なし（S0）の Prompt は、S2 の入力から Tournament Context を外したものと同じ文字列で、System Prompt は Cash と同じ", () => {
    const persona = describePersona(PERSONA_PRESETS.nit);
    const s0 = spot("t0_no_context").input;
    const s2 = spot("t2_bubble_shove").input;
    const { tournament, ...withoutContext } = s2.knowledge;
    expect(tournament).toBeDefined();
    expect(s0.knowledge.tournament).toBeUndefined();
    const p0 = buildOpponentPrompt(s0, persona);
    const p2 = buildOpponentPrompt(s2, persona);
    expect(p0).toBe(
      buildOpponentPrompt({ ...s2, knowledge: withoutContext }, persona),
    );
    expect(p0).not.toContain("## トーナメントの状況");
    expect(p0).not.toMatch(/icmEquity|bubbleFactor|payoutsByPlace|stage/);
    expect(p2).toContain("## トーナメントの状況");
    expect(p2).toContain('"stage":"bubble"');
    // 差分は「選べる Action」の前に入る Tournament の節（見出し・読み方・構造化データ）だけ。
    const at = p0.indexOf("## 選べる Action");
    expect(p2.startsWith(p0.slice(0, at))).toBe(true);
    expect(p2.endsWith(p0.slice(at))).toBe(true);
    expect(p2.slice(at, p2.length - (p0.length - at))).toMatch(
      /^## トーナメントの状況[\s\S]*"bubbleFactors":\[[^\]]*\]\}\n\n$/,
    );
    const [cashSpot] = OPPONENT_EVAL_SPOTS;
    if (cashSpot === undefined) throw new Error("Cash の代表 Spot が無い");
    const cash = buildSpot(cashSpot).input;
    expect(systemPromptOf(s0)).toBe(systemPromptOf(cash));
    expect(systemPromptOf(s2)).not.toBe(systemPromptOf(cash));
  });
});

describe("呼び出しの上限（D132）", () => {
  it("判断は Spot 7 × Persona 2（Nit・Maniac）× repeat 2 = 28 ちょうど。上限を超える組み合わせは呼ぶ前に例外", () => {
    expect(TOURNAMENT_EVAL_PERSONAS).toEqual(["nit", "maniac"]);
    expect(
      assertTournamentDecisionLimit(
        TOURNAMENT_EVAL_SPOTS,
        TOURNAMENT_EVAL_PERSONAS,
        TOURNAMENT_EVAL_REPEATS,
      ),
    ).toBe(TOURNAMENT_EVAL_LIMITS.maxDecisions);
    expect(() =>
      assertTournamentDecisionLimit(
        TOURNAMENT_EVAL_SPOTS,
        TOURNAMENT_EVAL_PERSONAS,
        3,
      ),
    ).toThrow(/上限 28/);
    expect(TOURNAMENT_EVAL_LIMITS.maxCalls).toBe(56);
  });

  it("dry-run はモデルを呼ばず、1 判断 1 回の Prompt で全経路を通し、漏れが 0 件", async () => {
    const budget = createCallBudget(TOURNAMENT_EVAL_LIMITS.maxCalls);
    const records = await runOpponentEval({
      spots: TOURNAMENT_EVAL_SPOTS,
      personas: TOURNAMENT_EVAL_PERSONAS,
      repeats: TOURNAMENT_EVAL_REPEATS,
      model: MODEL_ROLES.opponent_fast,
      env: { PATH: "/usr/bin" },
      queryFor: () => budget.wrap(dryRunQuery),
    });
    expect(records).toHaveLength(28);
    expect(budget.used()).toBe(28);
    expect(records.every((r) => r.final.kind === "claude")).toBe(true);
    expect(records.flatMap((r) => r.leaks)).toEqual([]);
  });

  it("シェルの env に API 課金・別の経路の変数があれば呼ぶ前に止める（値は出さない）", () => {
    expect(() => assertShellRoute({ PATH: "/usr/bin" })).not.toThrow();
    expect(() =>
      assertShellRoute({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-dummy" }),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(() =>
      assertShellRoute({ ANTHROPIC_BASE_URL: "http://localhost" }),
    ).toThrow(/ANTHROPIC_BASE_URL/);
    // 例外の文に値を出さない。
    let message = "";
    try {
      assertShellRoute({ ANTHROPIC_API_KEY: "sk-dummy" });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).not.toContain("sk-dummy");
  });
});

describe("録画済み応答の再生（CI。Claude を呼ばない）", () => {
  const load = () =>
    JSON.parse(
      readFileSync(TOURNAMENT_RECORDING_URL, "utf8"),
    ) as TournamentEvalRecording;

  it("録画は全 Spot × 全 Persona がちょうど揃い、本番の opponent_fast のモデルで、上限の中で取ったもの", () => {
    const recording = load();
    expect(recording.version).toBe(1);
    expect(recording.model).toBe(MODEL_ROLES.opponent_fast);
    expect(recording.spots).toEqual(TOURNAMENT_EVAL_SPOTS.map((s) => s.id));
    expect(recording.personas).toEqual(TOURNAMENT_EVAL_PERSONAS);
    expect(recording.repeats).toBe(TOURNAMENT_EVAL_REPEATS);
    assertPopulation(recording.cases, recording);
    expect(recording.limits).toEqual(TOURNAMENT_EVAL_LIMITS);
    expect(recording.modelCalls).toBeLessThanOrEqual(
      TOURNAMENT_EVAL_LIMITS.maxCalls,
    );
    expect(
      recording.cases.reduce((n, c) => n + c.attempts.length, 0),
    ).toBeLessThanOrEqual(recording.modelCalls);
    expect(recording.summary).not.toBeNull();
    // 資格情報を録画に含めない（Prompt の指紋・出力・所要時間だけ）。
    expect(JSON.stringify(recording)).not.toMatch(
      /sk-ant|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|oauth/i,
    );
  });

  it("本番と同じ経路で再生し直した指標が録画時の集計と一致し、Hidden Information Leakage と障害が 0 件", async () => {
    const recording = load();
    const clock = createReplayClock();
    const records = await runOpponentEval({
      spots: TOURNAMENT_EVAL_SPOTS,
      personas: recording.personas,
      repeats: recording.repeats,
      model: MODEL_ROLES.opponent_fast,
      env: { PATH: "/usr/bin" },
      queryFor: replayQueryFor(recording, clock),
      clock: clock.now,
    });
    // 録画が古い（Prompt・Options の指紋が違う）と再生の query が例外を投げ、障害として記録される。理由をそのまま見せる。
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
    // Stage ごとの分布と Context・層の有無の差（作業ログと docs/09 の数値の元）。
    const report = tournamentReport(summary);
    expect(report.stages.map((s) => s.spotId)).toEqual(recording.spots);
    expect(report.contextEffect.total).not.toBeNull();
    expect(report.layerEffect.total).not.toBeNull();
  });
});
