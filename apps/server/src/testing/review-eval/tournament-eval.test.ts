// Tournament の Review Eval（#202・D132）のテスト。Claude は呼ばない（D87）: query() を Fake か録画の再生に差し替える。
import { readFileSync } from "node:fs";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { ClaudeQuery } from "../../claude/structured-query.js";
import { MODEL_ROLES } from "../../config.js";
import { loadKb } from "../../kb/index.js";
import type { ReviewDraft } from "../../review/types.js";
import { createAmaster97Adapter } from "../../solver/amaster97-adapter.js";
import { createCallBudget } from "../opponent-eval/memory-prompt-eval.js";
import { createReplayClock } from "../opponent-eval/recording.js";
import { hashParams } from "../opponent-eval/harness.js";
import { runReviewEval } from "./harness.js";
import { assertReviewPopulation, summarizeReviewEval } from "./metrics.js";
import { replayReviewQueryFor } from "./recording.js";
import {
  TOURNAMENT_FOLLOW_UPS,
  TOURNAMENT_REVIEW_LIMITS,
  TOURNAMENT_REVIEW_RECORDING_CASES,
  TOURNAMENT_REVIEW_RECORDING_URL,
  TOURNAMENT_REVIEW_REPEATS,
  assertTournamentReviewLimit,
  capturePrompts,
  chipIcmConfusionsOf,
  promptLeaks,
  replayFollowUpQueryFor,
  runTournamentFollowUps,
  tournamentReviewReport,
  type TournamentReviewRecording,
} from "./tournament-eval.js";

const kb = loadKb();
const solver = createAmaster97Adapter({
  install: { installed: false, detail: "Review Eval（Solver なし）" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});

/** 検証を通らない出力を返す Fake（Retry を含めた最悪の呼び出しの数を通す）。 */
const invalidQuery: ClaudeQuery = () =>
  (async function* () {
    await Promise.resolve();
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      structured_output: {},
    } as unknown as SDKMessage;
  })();

/** 全判断と Follow-up を、与えた query() で本番と同じ経路に通す。 */
async function runAll(
  queryFor: (caseId: string, repeat: number) => ClaudeQuery,
  followUpQueryFor: (key: string) => ClaudeQuery,
  repeats: number = TOURNAMENT_REVIEW_REPEATS,
  clock?: () => number,
) {
  const drafts = new Map<string, ReviewDraft>();
  const captured = capturePrompts(queryFor);
  const records = await runReviewEval({
    cases: TOURNAMENT_REVIEW_RECORDING_CASES,
    repeats,
    kb,
    solver,
    env: { PATH: "/usr/bin" },
    queryFor: captured.queryFor,
    onDraft: (caseId, repeat, draft) =>
      drafts.set(`${caseId}#${repeat}`, draft),
    ...(clock === undefined ? {} : { clock }),
  });
  const followUps = await runTournamentFollowUps(drafts, {
    env: { PATH: "/usr/bin" },
    queryFor: followUpQueryFor,
    ...(clock === undefined ? {} : { clock }),
  });
  return { records, drafts, prompts: captured.prompts, followUps };
}

describe("Tournament の Review の判断と上限（D132）", () => {
  it("4 判断（Bubble Shove・Bubble Call・ITM の Short Stack の Call・All-in でない Turn の Bet）× repeat 2 と Follow-up 2 件で、最悪 20 回", () => {
    expect(TOURNAMENT_REVIEW_RECORDING_CASES.map((c) => c.id)).toEqual([
      "bubble_shove/d0",
      "bubble_call/d0",
      "itm_short_call/d0",
      "tournament_turn_bet/d2",
    ]);
    expect(TOURNAMENT_FOLLOW_UPS.map((f) => `${f.caseId}#${f.repeat}`)).toEqual(
      ["bubble_shove/d0#1", "bubble_call/d0#1"],
    );
    expect(
      assertTournamentReviewLimit(
        TOURNAMENT_REVIEW_RECORDING_CASES,
        TOURNAMENT_REVIEW_REPEATS,
        TOURNAMENT_FOLLOW_UPS,
      ),
    ).toBe(TOURNAMENT_REVIEW_LIMITS.maxCalls);
    expect(() =>
      assertTournamentReviewLimit(
        TOURNAMENT_REVIEW_RECORDING_CASES,
        3,
        TOURNAMENT_FOLLOW_UPS,
      ),
    ).toThrow(/D132/);
  });

  it("全経路（Gate・Retry・Follow-up）を通すと、番人の数えで 20 回ちょうどで、Solver は Preflop で not_applicable・Turn で mode の Unsupported", async () => {
    const budget = createCallBudget(TOURNAMENT_REVIEW_LIMITS.maxCalls);
    const { records, drafts, prompts, followUps } = await runAll(
      () => budget.wrap(invalidQuery),
      () => budget.wrap(invalidQuery),
    );
    expect(budget.used()).toBe(20);
    expect(records.every((r) => r.attempts.length === 2)).toBe(true);
    expect(followUps.every((f) => f.attempts.length === 2)).toBe(true);
    expect(records.flatMap((r) => r.leaks)).toEqual([]);
    expect(followUps.flatMap((f) => f.leaks)).toEqual([]);
    const statuses = Object.fromEntries(
      records.map((r) => [r.caseId, r.solverStatus]),
    );
    expect(statuses).toEqual({
      "bubble_shove/d0": "not_applicable",
      "bubble_call/d0": "not_applicable",
      "itm_short_call/d0": "not_applicable",
      "tournament_turn_bet/d2": "unsupported",
    });
    const turn = drafts.get("tournament_turn_bet/d2#1")?.evidence;
    expect(turn?.solver).toMatchObject({
      status: "unsupported",
      reason: "mode",
    });
    expect(turn?.tournament?.allIn).toBeNull();
    // ITM の Short Stack の Call は Pay Jump・Short Stack の判断で、All-in への Call の必要 Equity がある。
    const itm = drafts.get("itm_short_call/d0#1")?.evidence;
    expect(itm?.tournament?.stage).toBe("in_the_money");
    expect(itm?.context.importantSpotReasons).toEqual(
      expect.arrayContaining(["pay_jump", "short_stack"]),
    );
    expect(itm?.tournament?.allIn).toMatchObject({
      status: "available",
      decision: "call_all_in",
    });
    const report = tournamentReviewReport({
      summary: summarizeReviewEval(records, {
        cases: TOURNAMENT_REVIEW_RECORDING_CASES.map((c) => c.id),
        repeats: TOURNAMENT_REVIEW_REPEATS,
      }),
      records,
      drafts,
      prompts,
      followUps,
    });
    expect(report.privateLeaks).toEqual([]);
    expect(report.followUps.fallbacks).toBe(2);
    expect(report.followUps.calls).toBe(4);
  });
});

describe("漏れと混同の検査が空振りしない", () => {
  it("Prompt に CPU の Private な情報（CPU の Prompt の節・Persona の ID・Memory の項目）や知り得ない札があれば数える", () => {
    const allowed = new Set(["As", "Kd"]);
    expect(promptLeaks('{"holeCards":["As","Kd"]}', allowed)).toEqual([]);
    expect(
      promptLeaks(
        '## あなたの記憶\n{"cpuProfileId":"x","persona":"nit"} "Qh"',
        allowed,
      ),
    ).toEqual([
      "prompt: Qh",
      "prompt: ## あなたの記憶",
      "prompt: cpuProfileId",
      'prompt: "nit"',
    ]);
  });

  it("Chip EV と ICM の必要 Equity の値の直前の語が逆なら疑いとして数え、正しく書き分けた文は数えない", () => {
    const draft = {
      evidence: {
        tournament: {
          allIn: {
            status: "available",
            decision: "call_all_in",
            requirements: [
              {
                chipEv: { requiredEquityPercent: 38.2 },
                icm: { requiredEquityPercent: 52.6 },
              },
            ],
          },
        },
      },
    } as unknown as Pick<ReviewDraft, "evidence">;
    expect(
      chipIcmConfusionsOf(
        [
          "Chip EV の必要 Equity は 38.2% で、ICM の必要 Equity は 52.6% です。",
          "ICM では 53% 必要なのに対し、Chip EV なら 38% で足ります。",
        ],
        draft,
      ),
    ).toEqual([]);
    expect(
      chipIcmConfusionsOf(["ICM の必要 Equity は 38.2% です。"], draft),
    ).toHaveLength(1);
    expect(
      chipIcmConfusionsOf(["Chip EV では 52.6% が必要です。"], draft),
    ).toHaveLength(1);
  });
});

describe("録画済み応答の再生（CI。Claude を呼ばない）", () => {
  const load = () =>
    JSON.parse(
      readFileSync(TOURNAMENT_REVIEW_RECORDING_URL, "utf8"),
    ) as TournamentReviewRecording;

  it("録画は全判断と Follow-up で、本番の review_standard のモデル・今の KB の Version・上限の中で取ったもの", () => {
    const recording = load();
    expect(recording.version).toBe(1);
    expect(recording.model).toBe(MODEL_ROLES.review_standard);
    expect(recording.kbVersion).toBe(kb.version);
    expect(recording.cases).toEqual(
      TOURNAMENT_REVIEW_RECORDING_CASES.map((c) => c.id),
    );
    expect(recording.repeats).toBe(TOURNAMENT_REVIEW_REPEATS);
    assertReviewPopulation(recording.records, recording);
    expect(recording.limits).toEqual(TOURNAMENT_REVIEW_LIMITS);
    expect(recording.modelCalls).toBeLessThanOrEqual(
      TOURNAMENT_REVIEW_LIMITS.maxCalls,
    );
    const recordedCalls = [...recording.records, ...recording.followUps]
      .map((r) => r.attempts.length)
      .reduce((a, b) => a + b, 0);
    expect(recordedCalls).toBe(recording.modelCalls);
    // 資格情報を録画に含めない（Prompt の指紋・出力・所要時間だけ）。
    expect(JSON.stringify(recording)).not.toMatch(
      /sk-ant|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|oauth/i,
    );
  });

  it("本番と同じ経路で再生し直した指標が録画時の集計と一致し、Hindsight Leak・CPU の Private な情報の漏れ・障害が 0 件", async () => {
    const recording = load();
    const clock = createReplayClock();
    const run = await runAll(
      replayReviewQueryFor(recording, clock, hashParams),
      replayFollowUpQueryFor(recording.followUps, clock),
      recording.repeats,
      clock.now,
    );
    // 録画が古い（引数の指紋が違う）と再生の query が例外を投げ、障害として記録される。理由をそのまま見せる。
    expect([
      ...run.records.flatMap((r) =>
        r.final.kind === "outage" ? [r.final.message] : [],
      ),
      ...run.followUps.flatMap((f) =>
        f.final.kind === "outage" ? [f.final.message] : [],
      ),
    ]).toEqual([]);
    const summary = summarizeReviewEval(run.records, recording);
    expect(summary).toEqual(recording.summary);
    expect(tournamentReviewReport({ ...run, summary })).toEqual(
      recording.report,
    );
    expect(summary.hindsightLeaks).toBe(0);
    expect(summary.outages).toBe(0);
    expect(recording.report.privateLeaks).toEqual([]);
    expect(recording.report.followUps.leaks).toEqual([]);
    expect(recording.report.followUps.outages).toBe(0);
  });
});
