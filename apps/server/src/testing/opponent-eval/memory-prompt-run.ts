// Memory 付き Prompt の Claude CPU の Opponent Eval の手動実行（#155・D123）。CI と pnpm test では動かさない（D87）。
// eval:opponent と同じ経路（Claude Agent SDK・Claude Code の OAuth〔サブスク枠〕・buildClaudeEnv）だけで呼び、API キーは使わない。
// 実行: pnpm --filter @proj-poker/server eval:opponent-memory-prompt [--dry-run] [--record] [--resume]
//   --dry-run: モデルを呼ばず（0 回）、判断・Prompt の数と漏れを数える。録画の前に必ず 1 回流す。
//   --record: 録画（recordings/opponent-memory-prompt-eval.json）を新しく取る。録画が既にあれば実行しない（全件の再実行を防ぐ）。
//   --resume: 録画に足りない判断だけを、残りの呼び出しの上限の中で追加で集める。
// 呼び出しの上限（判断 36・呼び出し 72）は memory-prompt-eval.ts の番人で強制する。障害（ログイン・利用枠を含む）が出たら残りを打ち切る。
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
  MEMORY_PROMPT_EVAL_LIMITS,
  MEMORY_PROMPT_EVAL_PERSONAS,
  MEMORY_PROMPT_EVAL_REPEATS,
  MEMORY_PROMPT_EVAL_SPOTS,
  MEMORY_PROMPT_RECORDING_URL,
  assertDecisionLimit,
  assertOAuthRoute,
  createCallBudget,
  describeRouteEnv,
  directionReport,
  dryRunQuery,
  missingCases,
  type MemoryPromptEvalRecording,
} from "./memory-prompt-eval.js";
import { caseKey, summarizeOpponentEval, unmetTargets } from "./metrics.js";
import {
  createReplayClock,
  replayQueryFor,
  toRecordedCases,
  type RecordedCase,
} from "./recording.js";

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
const env = buildClaudeEnv(process.env);
console.log(describeRouteEnv(env, process.env));
assertOAuthRoute(env);

const spots = MEMORY_PROMPT_EVAL_SPOTS;
const personas = MEMORY_PROMPT_EVAL_PERSONAS;
const repeats = MEMORY_PROMPT_EVAL_REPEATS;
const decisions = assertDecisionLimit(spots, personas, repeats);
const population = { spots: spots.map((s) => s.id), personas, repeats };
console.log(
  `判断: Spot ${spots.length}（代表 Spot × 条件）× Persona ${personas.length} × repeat ${repeats} = ${decisions}（上限 ${MEMORY_PROMPT_EVAL_LIMITS.maxDecisions}）。呼び出しの上限 ${MEMORY_PROMPT_EVAL_LIMITS.maxCalls}`,
);

if (values["dry-run"]) {
  await dryRun();
} else {
  await recordRun(values.resume === true);
}

/** モデルを呼ばずにハーネスを通し、Prompt の数・節の入り方・漏れを数える。 */
async function dryRun(): Promise<void> {
  const prompts: string[] = [];
  const budget = createCallBudget(MEMORY_PROMPT_EVAL_LIMITS.maxCalls);
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
          memory: count("## あなたの記憶"),
          tableTendency: count("## 卓の傾向"),
          tilt: count("## あなたの今の状態"),
        },
        hiddenInformationLeakage: summary.hiddenInformationLeakage,
        leaks: summary.leaks,
        withinLimits:
          records.length <= MEMORY_PROMPT_EVAL_LIMITS.maxDecisions &&
          prompts.length <= MEMORY_PROMPT_EVAL_LIMITS.maxCalls,
      },
      null,
      2,
    ),
  );
}

/** 実際に Claude を呼んで録画する（新規か、足りない分の追加）。 */
async function recordRun(resume: boolean): Promise<void> {
  const previous = existsSync(MEMORY_PROMPT_RECORDING_URL)
    ? (JSON.parse(
        readFileSync(MEMORY_PROMPT_RECORDING_URL, "utf8"),
      ) as MemoryPromptEvalRecording)
    : undefined;
  if (!resume && previous !== undefined) {
    throw new Error(
      "録画が既にある。全件を取り直さず、足りない分だけを --resume で集める（D123）",
    );
  }
  if (resume && previous === undefined) {
    throw new Error("--resume する録画が無い");
  }
  const usedBefore = previous?.modelCalls ?? 0;
  const missing = missingCases(previous?.cases ?? [], spots, personas, repeats);
  const budget = createCallBudget(
    MEMORY_PROMPT_EVAL_LIMITS.maxCalls - usedBefore,
  );
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
  const recording: MemoryPromptEvalRecording = {
    version: 1,
    recordedAt: new Date().toISOString(),
    model: MODEL_ROLES.opponent_fast,
    sdkVersion:
      serverPackage.dependencies["@anthropic-ai/claude-agent-sdk"] ?? "unknown",
    ...population,
    concurrency: 1,
    limits: MEMORY_PROMPT_EVAL_LIMITS,
    modelCalls: usedBefore + budget.used(),
    runs: (previous?.runs ?? 0) + 1,
    cases,
    summary,
  };
  writeFileSync(
    MEMORY_PROMPT_RECORDING_URL,
    `${JSON.stringify(recording, null, 2)}\n`,
  );
  console.log(
    `録画を書いた: ${MEMORY_PROMPT_RECORDING_URL.pathname}（判断 ${cases.length}/${decisions}・呼び出し ${recording.modelCalls}/${MEMORY_PROMPT_EVAL_LIMITS.maxCalls}・実行 ${recording.runs} 回目）`,
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
        direction: directionReport(summary),
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
