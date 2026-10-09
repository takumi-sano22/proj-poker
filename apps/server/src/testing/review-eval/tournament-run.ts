// Tournament の Review Eval の手動実行（#202・D132）。実際に Claude を呼ぶので CI と pnpm test では動かさない（D87）。
// 経路は Claude Agent SDK・Claude Code の OAuth（サブスク枠）・buildClaudeEnv だけ。API 課金・別の経路へ切り替わる変数がシェルか
// 子プロセスの env にあれば呼ぶ前に止める。呼び出しは番人（createCallBudget）で 20 回までに抑える（8 Review + Follow-up 2）。
// 実行: pnpm --filter @proj-poker/server eval:review-tournament [--dry-run] [--record]
//   --dry-run: モデルを呼ばず（0 回）、不正な出力を返す Fake で全経路（Gate・Retry・Follow-up）を通し、最悪の呼び出しの数と漏れを数える
//   --record: 録画（recordings/review-tournament-eval.json）を取る。障害が 1 件でもあれば書かない。録画が既にあれば実行しない。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  buildClaudeEnv,
  type ClaudeQuery,
} from "../../claude/structured-query.js";
import { MODEL_ROLES } from "../../config.js";
import { loadKb } from "../../kb/index.js";
import type { ReviewDraft } from "../../review/types.js";
import { createAmaster97Adapter } from "../../solver/amaster97-adapter.js";
import {
  assertOAuthRoute,
  assertShellRoute,
  createCallBudget,
  describeRouteEnv,
} from "../opponent-eval/memory-prompt-eval.js";
import { runReviewEval } from "./harness.js";
import { summarizeReviewEval, unmetReviewTargets } from "./metrics.js";
import { toRecordedReviewCases } from "./recording.js";
import {
  TOURNAMENT_FOLLOW_UPS,
  TOURNAMENT_REVIEW_LIMITS,
  TOURNAMENT_REVIEW_RECORDING_CASES,
  TOURNAMENT_REVIEW_RECORDING_URL,
  TOURNAMENT_REVIEW_REPEATS,
  assertTournamentReviewLimit,
  capturePrompts,
  runTournamentFollowUps,
  toRecordedFollowUps,
  tournamentReviewReport,
  type TournamentReviewRecording,
} from "./tournament-eval.js";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    record: { type: "boolean", default: false },
  },
});
if (values["dry-run"] === values.record) {
  throw new RangeError("--dry-run か --record のどちらか 1 つを付ける");
}
if (values.record && existsSync(TOURNAMENT_REVIEW_RECORDING_URL)) {
  throw new Error("録画が既にある。上限（D132）の中で取り直さない");
}

// 実測のための上限。本番の REVIEW_TIMEOUT_MS ではなく十分長くする（eval:review と同じ）。
const MEASURE_TIMEOUT_MS = 600_000;
const env = buildClaudeEnv(process.env);
console.log(describeRouteEnv(env, process.env));
assertShellRoute(process.env);
assertOAuthRoute(env);

const cases = TOURNAMENT_REVIEW_RECORDING_CASES;
const repeats = TOURNAMENT_REVIEW_REPEATS;
const worst = assertTournamentReviewLimit(
  cases,
  repeats,
  TOURNAMENT_FOLLOW_UPS,
);
console.log(
  `Review: 判断 ${cases.length} × repeat ${repeats} = ${cases.length * repeats}・Follow-up ${TOURNAMENT_FOLLOW_UPS.length}。最悪の呼び出し ${worst}（上限 ${TOURNAMENT_REVIEW_LIMITS.maxCalls}）`,
);
const budget = createCallBudget(TOURNAMENT_REVIEW_LIMITS.maxCalls);
const base: ClaudeQuery = values["dry-run"]
  ? invalidOutputQuery
  : (sdkQuery as ClaudeQuery);

const kb = loadKb();
// 録画の再生で結果が揃うよう、Solver は未導入に固定する（Tournament の判断は導入の有無より先に mode で Unsupported になる）。
const solver = createAmaster97Adapter({
  install: { installed: false, detail: "Review Eval（Solver なし）" },
  timeoutMs: 1,
  maxConcurrency: 1,
  iterations: 1,
});
const population = { cases: cases.map((c) => c.id), repeats };
const drafts = new Map<string, ReviewDraft>();
const captured = capturePrompts(() => budget.wrap(base));
const records = await runReviewEval({
  cases,
  repeats,
  depth: "standard",
  kb,
  solver,
  env,
  queryFor: captured.queryFor,
  timeoutMs: MEASURE_TIMEOUT_MS,
  onDraft: (caseId, repeat, draft) => drafts.set(`${caseId}#${repeat}`, draft),
  onRecord: (r, done, total) => {
    if (r.final.kind === "outage") budget.close(r.final.message);
    const final =
      r.final.kind === "review"
        ? `${r.final.generatedBy} ${r.final.assessment}\n${r.final.text}\n根拠: ${r.final.cited.join(", ")}`
        : `障害: ${r.final.message}`;
    console.log(
      `[${done}/${total}] ${r.caseId}#${r.repeat}（${r.attempts.length} 回・${r.attempts.map((a) => a.ms).join(" / ")} ms・Solver ${r.solverStatus}）${final}\n`,
    );
  },
});
const followUps = await runTournamentFollowUps(drafts, {
  env,
  queryFor: () => budget.wrap(base),
  timeoutMs: MEASURE_TIMEOUT_MS,
});
for (const f of followUps) {
  console.log(
    `[Follow-up] ${f.caseId}#${f.repeat}（${f.attempts.length} 回）${f.final.kind === "answer" ? `${f.final.generatedBy} / ${f.final.scope}: ${f.final.text}` : `障害: ${f.final.message}`}\n`,
  );
}
console.log(
  `Claude の呼び出し: ${values["dry-run"] ? `0 回（Fake の呼び出し ${budget.used()} 回）` : `${budget.used()} 回`}（上限 ${TOURNAMENT_REVIEW_LIMITS.maxCalls}）`,
);
const summary = summarizeReviewEval(records, population);
const report = tournamentReviewReport({
  summary,
  records,
  drafts,
  prompts: captured.prompts,
  followUps,
});
console.log(JSON.stringify({ summary, report }, null, 2));
const unmet = unmetReviewTargets(summary);
console.log(
  unmet.length === 0
    ? "合格ライン（REVIEW_EVAL_TARGETS）: すべて届いた"
    : `合格ライン（REVIEW_EVAL_TARGETS）: 届かなかった指標 ${unmet.join(" / ")}`,
);

if (values.record) {
  const outages =
    summary.outages + followUps.filter((f) => f.final.kind === "outage").length;
  if (outages > 0) {
    console.error(
      `障害が ${outages} 件あったので録画しない（呼び出し ${budget.used()} 回は使った）`,
    );
    process.exit(1);
  }
  const serverPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  const recording: TournamentReviewRecording = {
    version: 1,
    recordedAt: new Date().toISOString(),
    model: MODEL_ROLES.review_standard,
    sdkVersion:
      serverPackage.dependencies["@anthropic-ai/claude-agent-sdk"] ?? "unknown",
    kbVersion: kb.version,
    ...population,
    limits: TOURNAMENT_REVIEW_LIMITS,
    modelCalls: budget.used(),
    records: toRecordedReviewCases(records),
    followUps: toRecordedFollowUps(followUps),
    summary,
    report,
  };
  writeFileSync(
    TOURNAMENT_REVIEW_RECORDING_URL,
    `${JSON.stringify(recording, null, 2)}\n`,
  );
  console.log(`録画を書いた: ${TOURNAMENT_REVIEW_RECORDING_URL.pathname}`);
}

/** dry-run の query()（モデルを呼ばない）。検証を通らない出力を返し、Retry を含めた最悪の呼び出しの数を通す。 */
function invalidOutputQuery(): ReturnType<ClaudeQuery> {
  return (async function* () {
    await Promise.resolve();
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      structured_output: {},
    } as unknown as SDKMessage;
  })();
}
