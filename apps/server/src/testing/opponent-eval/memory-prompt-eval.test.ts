// Memory 付き Prompt の Claude CPU の Opponent Eval（#155・D123）のテスト。Claude は呼ばない（D87）:
// query() を dry-run の Fake か録画の再生に差し替える。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODEL_ROLES } from "../../config.js";
import {
  buildClaudeEnv,
  buildOpponentPrompt,
  type ClaudeQuery,
} from "../../opponents/claude-opponent.js";
import { runOpponentEval } from "./harness.js";
import {
  MEMORY_PROMPT_CONDITIONS,
  MEMORY_PROMPT_EVAL_LIMITS,
  MEMORY_PROMPT_EVAL_PERSONAS,
  MEMORY_PROMPT_EVAL_REPEATS,
  MEMORY_PROMPT_EVAL_SPOTS,
  MEMORY_PROMPT_RECORDING_URL,
  assertDecisionLimit,
  createCallBudget,
  directionReport,
  dryRunQuery,
  missingCases,
  type MemoryPromptEvalRecording,
} from "./memory-prompt-eval.js";
import { assertPopulation, summarizeOpponentEval } from "./metrics.js";
import {
  RECORDING_URL,
  createReplayClock,
  replayQueryFor,
  type OpponentEvalRecording,
} from "./recording.js";
import { buildSpot } from "./spots.js";

const HEADINGS = ["## あなたの記憶", "## 卓の傾向", "## あなたの今の状態"];

const run = (spots = MEMORY_PROMPT_EVAL_SPOTS, query: ClaudeQuery) =>
  runOpponentEval({
    spots,
    personas: MEMORY_PROMPT_EVAL_PERSONAS,
    repeats: MEMORY_PROMPT_EVAL_REPEATS,
    model: MODEL_ROLES.opponent_fast,
    env: { PATH: "/usr/bin" },
    queryFor: () => query,
  });

describe("Memory 付き Prompt の Spot と条件（#155）", () => {
  it("代表 Spot 2 × 条件 3（baseline・loose・tight）で、Hand の ID は元の Spot のまま", () => {
    expect(MEMORY_PROMPT_EVAL_SPOTS.map((s) => s.id)).toEqual([
      "river_facing_big_bet@baseline",
      "river_facing_big_bet@loose",
      "river_facing_big_bet@tight",
      "flop_cbet@baseline",
      "flop_cbet@loose",
      "flop_cbet@tight",
    ]);
    for (const spot of MEMORY_PROMPT_EVAL_SPOTS) {
      expect(buildSpot(spot).input.knowledge.handId).toBe(
        `eval-${spot.baseSpotId}`,
      );
    }
  });

  it("baseline の Prompt には層の節が無く、loose / tight の Prompt には Memory・Table Tendency・Tilt の節がある", () => {
    for (const spot of MEMORY_PROMPT_EVAL_SPOTS) {
      const prompt = buildOpponentPrompt(buildSpot(spot).input);
      const layered = !spot.id.endsWith("@baseline");
      for (const heading of HEADINGS) {
        expect(prompt.includes(heading), `${spot.id} ${heading}`).toBe(layered);
      }
    }
  });

  it("loose と tight は Subject・卓の傾向が逆向きで、Tilt は同じ（両者の差は相手と卓の傾向だけ）", () => {
    const by = Object.fromEntries(
      MEMORY_PROMPT_CONDITIONS.map((c) => [c.id, c.layers]),
    );
    expect(by.baseline).toEqual({ id: "none" });
    expect(by.loose?.memory).toBe("loose");
    expect(by.tight?.memory).toBe("tight");
    expect(by.loose?.tilt).toBe(by.tight?.tilt);
    expect(by.loose?.table?.vpip).toBeGreaterThan(by.tight?.table?.vpip ?? 1);
  });

  it("baseline の Prompt・Options は、既存の録画（opponent-eval.json）の同じ Spot・Persona の 1 回目と同じ指紋", async () => {
    const existing = JSON.parse(
      readFileSync(RECORDING_URL, "utf8"),
    ) as OpponentEvalRecording;
    const baseline = MEMORY_PROMPT_EVAL_SPOTS.filter((s) =>
      s.id.endsWith("@baseline"),
    );
    const records = await run(baseline, dryRunQuery);
    for (const r of records) {
      const base = r.spotId.replace("@baseline", "");
      const recorded = existing.cases.find(
        (c) => c.spotId === base && c.personaId === r.personaId,
      );
      expect(r.attempts[0]?.paramsHash, r.spotId).toBe(
        recorded?.attempts[0]?.paramsHash,
      );
    }
  });
});

describe("呼び出しの上限（D123）", () => {
  it("判断の数は Spot × Persona × repeat で 36 ちょうど。上限を超える組み合わせは呼ぶ前に例外", () => {
    expect(
      assertDecisionLimit(
        MEMORY_PROMPT_EVAL_SPOTS,
        MEMORY_PROMPT_EVAL_PERSONAS,
        MEMORY_PROMPT_EVAL_REPEATS,
      ),
    ).toBe(MEMORY_PROMPT_EVAL_LIMITS.maxDecisions);
    expect(() =>
      assertDecisionLimit(
        MEMORY_PROMPT_EVAL_SPOTS,
        MEMORY_PROMPT_EVAL_PERSONAS,
        2,
      ),
    ).toThrow(/上限 36/);
    expect(MEMORY_PROMPT_EVAL_LIMITS.maxCalls).toBe(72);
  });

  it("番人は上限に達したら下の query() を呼ばずに例外にし、止めた後も呼ばない", () => {
    let inner = 0;
    const query: ClaudeQuery = (params) => {
      inner++;
      return dryRunQuery(params);
    };
    const params = { prompt: "p", options: {} };
    const budget = createCallBudget(2);
    const wrapped = budget.wrap(query);
    wrapped(params);
    wrapped(params);
    expect(() => wrapped(params)).toThrow(/上限 2 回/);
    expect(inner).toBe(2);
    expect(budget.used()).toBe(2);

    const closing = createCallBudget(5);
    closing.close("rate limited");
    expect(() => closing.wrap(query)(params)).toThrow(/rate limited/);
    expect(inner).toBe(2);
  });

  it("dry-run はモデルを呼ばず、1 判断 1 回の Prompt で全経路を通し、漏れが 0 件", async () => {
    const budget = createCallBudget(MEMORY_PROMPT_EVAL_LIMITS.maxCalls);
    const records = await run(undefined, budget.wrap(dryRunQuery));
    expect(records).toHaveLength(36);
    expect(budget.used()).toBe(36);
    expect(records.every((r) => r.final.kind === "claude")).toBe(true);
    expect(records.flatMap((r) => r.leaks)).toEqual([]);
  });

  it("番人が止めると残りの判断は障害になり、その後は 1 回も呼ばない（打ち切り）", async () => {
    const budget = createCallBudget(3);
    const records = await run(undefined, budget.wrap(dryRunQuery));
    expect(budget.used()).toBe(3);
    expect(records.filter((r) => r.final.kind === "claude")).toHaveLength(3);
    expect(records.filter((r) => r.final.kind === "outage")).toHaveLength(33);
  });

  it("足りない判断だけを数える（追加の実行で全件を取り直さない）", () => {
    const all = missingCases(
      [],
      MEMORY_PROMPT_EVAL_SPOTS,
      MEMORY_PROMPT_EVAL_PERSONAS,
      1,
    );
    expect(all).toHaveLength(36);
    expect(
      missingCases(
        all.slice(1),
        MEMORY_PROMPT_EVAL_SPOTS,
        MEMORY_PROMPT_EVAL_PERSONAS,
        1,
      ),
    ).toEqual([all[0]]);
  });

  it("子プロセスの env から API 課金に切り替わる変数を外す（buildClaudeEnv。D87・D123）", () => {
    const env = buildClaudeEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-test-dummy",
      ANTHROPIC_AUTH_TOKEN: "dummy-token",
    });
    expect(Object.keys(env)).toEqual(["PATH"]);
  });
});

describe("漏れの走査が空振りしない", () => {
  it("Memory の Subject に判断する CPU 自身が入っていれば（他の CPU の Memory を渡した形）、漏れとして数える", async () => {
    const [spot] = MEMORY_PROMPT_EVAL_SPOTS.filter((s) =>
      s.id.endsWith("@loose"),
    );
    if (spot?.withLayers === undefined) throw new Error("loose の Spot が無い");
    const layered = spot.withLayers;
    const wrong = {
      ...spot,
      withLayers: (input: Parameters<typeof layered>[0]) => {
        const out = layered(input);
        const memory = out.knowledge.memory;
        if (memory === undefined) throw new Error("Memory が無い");
        const self = {
          ...memory.subjects[0],
          playerId: input.knowledge.viewerId,
        };
        return {
          ...out,
          knowledge: {
            ...out.knowledge,
            memory: {
              ...memory,
              subjects: [...memory.subjects, self] as typeof memory.subjects,
            },
          },
        };
      },
    };
    const [record] = await runOpponentEval({
      spots: [wrong],
      personas: ["nit"],
      repeats: 1,
      model: "test-model",
      env: {},
      queryFor: () => dryRunQuery,
    });
    expect(
      record?.leaks.some((l) => l.includes("memory の Subject に自分")),
    ).toBe(true);
  });
});

describe("録画済み応答の再生（CI。Claude を呼ばない）", () => {
  // 読み込みは各テストの中で行う（録画が無いときに、他の describe まで巻き込んで落とさない）。
  const load = () =>
    JSON.parse(
      readFileSync(MEMORY_PROMPT_RECORDING_URL, "utf8"),
    ) as MemoryPromptEvalRecording;

  it("録画は全 Spot × 全 Persona がちょうど揃い、本番の opponent_fast のモデルで、上限の中で取ったもの", () => {
    const recording = load();
    expect(recording.version).toBe(1);
    expect(recording.model).toBe(MODEL_ROLES.opponent_fast);
    expect(recording.spots).toEqual(MEMORY_PROMPT_EVAL_SPOTS.map((s) => s.id));
    expect(recording.personas).toEqual(MEMORY_PROMPT_EVAL_PERSONAS);
    expect(recording.repeats).toBe(MEMORY_PROMPT_EVAL_REPEATS);
    assertPopulation(recording.cases, recording);
    expect(recording.limits).toEqual(MEMORY_PROMPT_EVAL_LIMITS);
    expect(recording.cases.length).toBeLessThanOrEqual(
      MEMORY_PROMPT_EVAL_LIMITS.maxDecisions,
    );
    expect(recording.modelCalls).toBeLessThanOrEqual(
      MEMORY_PROMPT_EVAL_LIMITS.maxCalls,
    );
    // 録画に残った呼び出しは、実際に呼んだ回数を超えない（障害で終わった呼び出しは録画に残らない）。
    expect(
      recording.cases.reduce((n, c) => n + c.attempts.length, 0),
    ).toBeLessThanOrEqual(recording.modelCalls);
    expect(recording.summary).not.toBeNull();
  });

  it("本番と同じ経路で再生し直した指標が録画時の集計と一致し、Hidden Information Leakage と障害が 0 件", async () => {
    const recording = load();
    const clock = createReplayClock();
    const records = await runOpponentEval({
      spots: MEMORY_PROMPT_EVAL_SPOTS,
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
    expect(
      records.every(
        (r) => r.final.kind !== "claude" || r.attempts.at(-1)?.check.ok,
      ),
    ).toBe(true);
    // 向きの集計が全条件で値を持つ（作業ログと docs/09 の数値の元）。
    for (const row of directionReport(summary)) {
      expect(Object.keys(row.total)).toEqual(["baseline", "loose", "tight"]);
    }
  });
});
