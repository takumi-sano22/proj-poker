// Tournament の Claude CPU の Opponent Eval の手動実行（#202・D132）。CI と pnpm test では動かさない（D87）。
// eval:opponent と同じ経路（Claude Agent SDK・Claude Code の OAuth〔サブスク枠〕・buildClaudeEnv）だけで呼び、API キーは使わない。
// 実行: pnpm --filter @proj-poker/server eval:opponent-tournament [--dry-run] [--record] [--resume]
//   --dry-run: モデルを呼ばず（0 回）、判断・Prompt の数・節の入り方と漏れを数える。録画の前に必ず 1 回流す。
//   --record: 録画（recordings/opponent-tournament-eval-v2.json。#207・D133。#202 の録画はベースラインとして残す）を新しく取る。録画が既にあれば実行しない（全件の再実行を防ぐ）。
//   --resume: 録画に足りない判断だけを、残りの呼び出しの上限の中で追加で集める。
// 呼び出しの上限（判断 28・呼び出し 56）は tournament-eval.ts の値を番人（createCallBudget）で強制する。障害が出たら残りを打ち切る。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { MODEL_ROLES } from "../../config.js";
import {
  buildClaudeEnv,
  type ClaudeQuery,
} from "../../opponents/claude-opponent.js";
import { runOpponentEval, type EvalRecord } from "./harness.js";
import {
  assertOAuthRoute,
  assertShellRoute,
  createCallBudget,
  describeRouteEnv,
  dryRunQuery,
  missingCases,
} from "./memory-prompt-eval.js";
import { caseKey, summarizeOpponentEval, unmetTargets } from "./metrics.js";
import {
  createReplayClock,
  replayQueryFor,
  toRecordedCases,
  type RecordedCase,
} from "./recording.js";
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

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
  },
});
const modes = [values["dry-run"], values.record, values.resume].filter(Boolean);
if (modes.length !== 1) {
  throw new RangeError("--dry-run / --record / --resume のどれか 1 つを付ける");
}

// 実測のための上限。本番の OPPONENT_TIMEOUT_MS ではなく十分長くする（eval:opponent と同じ）。
const MEASURE_TIMEOUT_MS = 120_000;
// 経路の確認（値は出さない）。シェルと子プロセスの env のどちらかに API 課金・別の経路の変数があれば呼ばずに止める（D132）。
const env = buildClaudeEnv(process.env);
console.log(describeRouteEnv(env, process.env));
assertShellRoute(process.env);
assertOAuthRoute(env);

const spots = TOURNAMENT_EVAL_SPOTS;
const personas = TOURNAMENT_EVAL_PERSONAS;
const repeats = TOURNAMENT_EVAL_REPEATS;
const decisions = assertTournamentDecisionLimit(spots, personas, repeats);
const population = { spots: spots.map((s) => s.id), personas, repeats };
console.log(
  `判断: Spot ${spots.length} × Persona ${personas.length} × repeat ${repeats} = ${decisions}（上限 ${TOURNAMENT_EVAL_LIMITS.maxDecisions}）。呼び出しの上限 ${TOURNAMENT_EVAL_LIMITS.maxCalls}（Retry を含めた最悪 ${decisions * 2}）`,
);

if (values["dry-run"]) {
  await dryRun();
} else {
  await recordRun(values.resume === true);
}

/** モデルを呼ばずにハーネスを通し、Prompt の数・節の入り方・漏れを数える。 */
async function dryRun(): Promise<void> {
  const prompts: string[] = [];
  const budget = createCallBudget(TOURNAMENT_EVAL_LIMITS.maxCalls);
  const capture: ClaudeQuery = (params) => {
    prompts.push(params.prompt);
    return dryRunQuery(params);
  };
  const records = await runOpponentEval({
    spots,
    personas,
    repeats,
    model: MODEL_ROLES.opponent_fast,
    env,
    queryFor: () => budget.wrap(capture),
  });
  const summary = summarizeOpponentEval(records, population);
  const count = (heading: string) =>
    prompts.filter((p) => p.includes(heading)).length;
  console.log(
    JSON.stringify(
      {
        modelCalls: 0,
        decisions: records.length,
        prompts: prompts.length,
        distinctPrompts: new Set(prompts).size,
        sections: {
          tournament: count("## トーナメントの状況"),
          memory: count("## あなたの記憶"),
          tableTendency: count("## 卓の傾向"),
          tilt: count("## あなたの今の状態"),
          // #207・D133 の Persona の読み方（Tournament の節）と、層を後に当てる 1 行（S6 だけ）。
          tournamentPersonaGuide: count(
            "戦略上の基準はこのトーナメントの状況です",
          ),
          tournamentLayersLine: count("後の節（記憶・卓の傾向・今の状態）"),
        },
        hiddenInformationLeakage: summary.hiddenInformationLeakage,
        leaks: summary.leaks,
        withinLimits:
          records.length <= TOURNAMENT_EVAL_LIMITS.maxDecisions &&
          prompts.length * 2 <= TOURNAMENT_EVAL_LIMITS.maxCalls,
      },
      null,
      2,
    ),
  );
}

/** 実際に Claude を呼んで録画する（新規か、足りない分の追加）。 */
async function recordRun(resume: boolean): Promise<void> {
  const previous = existsSync(TOURNAMENT_RECORDING_URL)
    ? (JSON.parse(
        readFileSync(TOURNAMENT_RECORDING_URL, "utf8"),
      ) as TournamentEvalRecording)
    : undefined;
  if (!resume && previous !== undefined) {
    throw new Error(
      "録画が既にある。全件を取り直さず、足りない分だけを --resume で集める（D132）",
    );
  }
  if (resume && previous === undefined) {
    throw new Error("--resume する録画が無い");
  }
  const usedBefore = previous?.modelCalls ?? 0;
  const missing = missingCases(previous?.cases ?? [], spots, personas, repeats);
  const budget = createCallBudget(TOURNAMENT_EVAL_LIMITS.maxCalls - usedBefore);
  console.log(
    `今回集める判断 ${missing.length}・今回呼べる回数 ${budget.remaining()}（これまでの呼び出し ${usedBefore}）`,
  );
  if (missing.length === 0 || budget.remaining() === 0) {
    console.log("集める判断が無いか、呼び出しの上限に達している");
    return;
  }
  const wanted = new Set(missing.map(caseKey));
  const sdk = sdkQuery as ClaudeQuery;
  const records = await runOpponentEval({
    spots,
    personas,
    repeats,
    model: MODEL_ROLES.opponent_fast,
    env,
    queryFor: () => budget.wrap(sdk),
    timeoutMs: MEASURE_TIMEOUT_MS,
    only: (c) => wanted.has(caseKey(c)),
    onRecord: (r, done, total) => {
      if (r.final.kind === "outage") budget.close(r.final.message);
      console.log(
        `[${done}/${total}] ${caseKey(r)}（${r.attempts.length} 回）${describeFinal(r)}`,
      );
    },
  });

  // 障害の判断は録画に残さない（足りない分として次の --resume で集める）。
  const cases: RecordedCase[] = [
    ...(previous?.cases ?? []),
    ...toRecordedCases(records.filter((r) => r.final.kind !== "outage")),
  ];
  const complete = missingCases(cases, spots, personas, repeats).length === 0;
  const summary = complete ? await replaySummary(cases) : null;
  const serverPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  const recording: TournamentEvalRecording = {
    version: 1,
    recordedAt: new Date().toISOString(),
    model: MODEL_ROLES.opponent_fast,
    sdkVersion:
      serverPackage.dependencies["@anthropic-ai/claude-agent-sdk"] ?? "unknown",
    ...population,
    concurrency: 1,
    limits: TOURNAMENT_EVAL_LIMITS,
    modelCalls: usedBefore + budget.used(),
    runs: (previous?.runs ?? 0) + 1,
    cases,
    summary,
  };
  writeFileSync(
    TOURNAMENT_RECORDING_URL,
    `${JSON.stringify(recording, null, 2)}\n`,
  );
  console.log(
    `録画を書いた: ${TOURNAMENT_RECORDING_URL.pathname}（判断 ${cases.length}/${decisions}・呼び出し ${recording.modelCalls}/${TOURNAMENT_EVAL_LIMITS.maxCalls}・実行 ${recording.runs} 回目）`,
  );
  const closed = budget.closedReason();
  if (closed !== undefined) {
    console.error(`障害で打ち切った: ${closed}`);
    process.exitCode = 2;
  }
  if (summary !== null) report(summary);
}

/** 録画を本番と同じ経路で再生して集計する（CI と同じ。モデルは呼ばない）。 */
async function replaySummary(cases: readonly RecordedCase[]) {
  const clock = createReplayClock();
  const records = await runOpponentEval({
    spots,
    personas,
    repeats,
    model: MODEL_ROLES.opponent_fast,
    env: {},
    queryFor: replayQueryFor({ cases }, clock),
    clock: clock.now,
  });
  return summarizeOpponentEval(records, population);
}

function report(summary: ReturnType<typeof summarizeOpponentEval>): void {
  console.log(
    JSON.stringify(
      {
        model: MODEL_ROLES.opponent_fast,
        summary,
        tournament: tournamentReport(summary),
      },
      null,
      2,
    ),
  );
  const unmet = unmetTargets(summary);
  console.log(
    unmet.length === 0
      ? "合格ライン（既存の OPPONENT_EVAL_TARGETS）: すべて届いた"
      : `合格ライン（既存の OPPONENT_EVAL_TARGETS）: 届かなかった指標 ${unmet.join(" / ")}`,
  );
}

function describeFinal(r: EvalRecord): string {
  return r.final.kind === "claude"
    ? JSON.stringify(r.attempts.at(-1)?.output)
    : r.final.kind === "outage"
      ? `障害: ${r.final.message}`
      : "Fallback";
}
