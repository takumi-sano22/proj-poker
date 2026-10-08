// Memory 付き Prompt の Claude CPU の Eval の River の追加測定の手動実行（#171・D126）。CI と pnpm test では動かさない（D87）。
// #155 と同じ経路（Claude Agent SDK・Claude Code の OAuth〔サブスク枠〕・buildClaudeEnv）だけで呼び、API キーは使わない。
// 実行: pnpm --filter @proj-poker/server eval:opponent-memory-river [--dry-run] [--record] [--resume]
//   --dry-run: モデルを呼ばず（0 回）、判断・Prompt の数・漏れ・D123 の録画との指紋の一致を数える。録画の前に必ず 1 回流す。
//   --record: 追加分の録画（recordings/opponent-memory-prompt-river-repeat.json）を新しく取る。録画が既にあれば実行しない。
//   --resume: 録画に足りない判断だけを、残りの呼び出しの上限の中で追加で集める（障害で打ち切ったときだけ）。
// 呼び出しの上限（判断 36・呼び出し 72）は river-repeat-eval.ts の定数と memory-prompt-eval.ts の番人で強制する。
// 障害（ログイン・利用枠を含む）が出たら残りを打ち切り、API キーや別の経路には切り替えない。
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
  MEMORY_PROMPT_RECORDING_URL,
  assertOAuthRoute,
  createCallBudget,
  describeRouteEnv,
  dryRunQuery,
  type MemoryPromptEvalRecording,
} from "./memory-prompt-eval.js";
import { caseKey, summarizeOpponentEval, unmetTargets } from "./metrics.js";
import {
  createReplayClock,
  replayQueryFor,
  toRecordedCases,
  type RecordedCase,
} from "./recording.js";
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

const spots = RIVER_REPEAT_SPOTS;
const personas = RIVER_REPEAT_PERSONAS;
const allCases = riverRepeatCases();
const decisions = assertRiverDecisionLimit(allCases);
// D123 の録画（repeat 1）は読むだけ（書き換えない）。
const base = JSON.parse(
  readFileSync(MEMORY_PROMPT_RECORDING_URL, "utf8"),
) as MemoryPromptEvalRecording;
const baseCases = baseRiverCases(base);
console.log(
  `追加の判断: Spot ${spots.length}（River × 条件）× Persona ${personas.length} × 追加 repeat ${RIVER_REPEAT_ADDED_REPEATS.length}（${RIVER_REPEAT_ADDED_REPEATS.join("・")}）= ${decisions}（上限 ${RIVER_REPEAT_EVAL_LIMITS.maxDecisions}）。呼び出しの上限 ${RIVER_REPEAT_EVAL_LIMITS.maxCalls}。D123 の録画の River の判断 ${baseCases.length}`,
);

if (values["dry-run"]) {
  await dryRun();
} else {
  await recordRun(values.resume === true);
}

/** モデルを呼ばずにハーネスを通し、Prompt の数・漏れ・D123 の録画との指紋の一致を数える。 */
async function dryRun(): Promise<void> {
  const prompts: string[] = [];
  const budget = createCallBudget(RIVER_REPEAT_EVAL_LIMITS.maxCalls);
  const capture: ClaudeQuery = (params) => {
    prompts.push(params.prompt);
    return dryRunQuery(params);
  };
  const records = await runOpponentEval({
    spots,
    personas,
    repeats: RIVER_REPEAT_TOTAL_REPEATS,
    model: MODEL_ROLES.opponent_fast,
    env,
    queryFor: () => budget.wrap(capture),
    only: isAddedRepeat,
  });
  // 追加分の 1 回目の呼び出しは、D123 の録画の同じ Spot・Persona の 1 回目と同じ指紋（#155 と同じ条件の組み立て）。
  const baseHash = new Map(
    baseCases.map((c) => [
      `${c.spotId}/${c.personaId}`,
      c.attempts[0]?.paramsHash,
    ]),
  );
  const hashMismatch = records
    .filter(
      (r) =>
        r.attempts[0]?.paramsHash !==
        baseHash.get(`${r.spotId}/${r.personaId}`),
    )
    .map(caseKey);
  const summary = summarizeOpponentEval(renumberAddedRepeats(records), {
    spots: spots.map((s) => s.id),
    personas,
    repeats: RIVER_REPEAT_ADDED_REPEATS.length,
  });
  console.log(
    JSON.stringify(
      {
        modelCalls: 0,
        decisions: records.length,
        prompts: prompts.length,
        distinctPrompts: new Set(prompts).size,
        hashMismatchWithD123: hashMismatch,
        hiddenInformationLeakage: summary.hiddenInformationLeakage,
        leaks: summary.leaks,
        withinLimits:
          records.length <= RIVER_REPEAT_EVAL_LIMITS.maxDecisions &&
          prompts.length <= RIVER_REPEAT_EVAL_LIMITS.maxCalls,
      },
      null,
      2,
    ),
  );
}

/** 実際に Claude を呼んで追加分を録画する（新規か、足りない分の追加）。 */
async function recordRun(resume: boolean): Promise<void> {
  const previous = existsSync(RIVER_REPEAT_RECORDING_URL)
    ? (JSON.parse(
        readFileSync(RIVER_REPEAT_RECORDING_URL, "utf8"),
      ) as RiverRepeatEvalRecording)
    : undefined;
  if (!resume && previous !== undefined) {
    throw new Error(
      "録画が既にある。全件を取り直さず、足りない分だけを --resume で集める（D126）",
    );
  }
  if (resume && previous === undefined) {
    throw new Error("--resume する録画が無い");
  }
  const usedBefore = previous?.modelCalls ?? 0;
  const have = new Set((previous?.cases ?? []).map(caseKey));
  const missing = allCases.filter((c) => !have.has(caseKey(c)));
  const budget = createCallBudget(
    RIVER_REPEAT_EVAL_LIMITS.maxCalls - usedBefore,
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
    repeats: RIVER_REPEAT_TOTAL_REPEATS,
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
  const have2 = new Set(cases.map(caseKey));
  const complete = allCases.every((c) => have2.has(caseKey(c)));
  const summaries = complete ? await replaySummaries(cases) : null;
  const serverPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  const recording: RiverRepeatEvalRecording = {
    version: 1,
    recordedAt: new Date().toISOString(),
    model: MODEL_ROLES.opponent_fast,
    sdkVersion:
      serverPackage.dependencies["@anthropic-ai/claude-agent-sdk"] ?? "unknown",
    baseRecording: "opponent-memory-prompt-eval.json",
    spots: spots.map((s) => s.id),
    personas,
    addedRepeats: RIVER_REPEAT_ADDED_REPEATS,
    totalRepeats: RIVER_REPEAT_TOTAL_REPEATS,
    concurrency: 1,
    limits: RIVER_REPEAT_EVAL_LIMITS,
    modelCalls: usedBefore + budget.used(),
    runs: (previous?.runs ?? 0) + 1,
    cases,
    summary: summaries?.summary ?? null,
    addedSummary: summaries?.addedSummary ?? null,
  };
  writeFileSync(
    RIVER_REPEAT_RECORDING_URL,
    `${JSON.stringify(recording, null, 2)}\n`,
  );
  console.log(
    `録画を書いた: ${RIVER_REPEAT_RECORDING_URL.pathname}（判断 ${cases.length}/${decisions}・呼び出し ${recording.modelCalls}/${RIVER_REPEAT_EVAL_LIMITS.maxCalls}・実行 ${recording.runs} 回目）`,
  );
  const closed = budget.closedReason();
  if (closed !== undefined) {
    console.error(`障害で打ち切った: ${closed}`);
    process.exitCode = 2;
  }
  if (summaries !== null) report(summaries.summary, summaries.addedSummary);
}

/** D123 の録画の River の分と追加分を本番と同じ経路で再生して集計する（CI と同じ。モデルは呼ばない）。 */
async function replaySummaries(added: readonly RecordedCase[]) {
  const clock = createReplayClock();
  const records = await runOpponentEval({
    spots,
    personas,
    repeats: RIVER_REPEAT_TOTAL_REPEATS,
    model: MODEL_ROLES.opponent_fast,
    env: {},
    queryFor: replayQueryFor({ cases: [...baseCases, ...added] }, clock),
    clock: clock.now,
  });
  const ids = spots.map((s) => s.id);
  return {
    summary: summarizeOpponentEval(records, {
      spots: ids,
      personas,
      repeats: RIVER_REPEAT_TOTAL_REPEATS,
    }),
    addedSummary: summarizeOpponentEval(
      renumberAddedRepeats(records.filter(isAddedRepeat)),
      { spots: ids, personas, repeats: RIVER_REPEAT_ADDED_REPEATS.length },
    ),
  };
}

function report(
  summary: ReturnType<typeof summarizeOpponentEval>,
  addedSummary: ReturnType<typeof summarizeOpponentEval>,
): void {
  console.log(
    JSON.stringify(
      {
        model: MODEL_ROLES.opponent_fast,
        summary,
        addedSummary,
        river: riverRateReport(summary),
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
