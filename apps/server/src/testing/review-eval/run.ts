// Review Eval の手動実行（Issue #82・docs/09 §6）。実際に Claude を呼ぶので CI と pnpm test では動かさない（D87）。
// Claude Code のログイン（OAuth・サブスク枠）で呼び、API キーは子プロセスの環境から外す（buildClaudeEnv）。利用枠は開発の Claude Code と共有する。
// API 課金・別の経路（Bedrock / Vertex / Foundry・別の接続先）へ切り替わる変数が親（シェル）か子プロセスの env にあれば、呼ぶ前に止める
// （assertOAuthRoute）。呼び出しの数は番人（createCallBudget）で REVIEW_EVAL_MAX_CALLS 回までに抑える（#168・D131: 12 Review・最大 24 回）。
// 実行: pnpm --filter @proj-poker/server eval:review [--repeats 1] [--depth standard|deep] [--solver] [--record]
//   --solver: POKER_SOLVER_HOME の Solver を使う（Supported の Solver Evidence を渡した Review を見る。録画とは併用しない）
//   --record: 結果を録画（recordings/review-eval.json）に書く。CI はこの録画を再生して集計する。障害が 1 件でもあれば書かない。
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  API_BILLING_ENV_KEYS,
  buildClaudeEnv,
} from "../../claude/structured-query.js";
import { MODEL_ROLES } from "../../config.js";
import { loadKb } from "../../kb/index.js";
import { createAmaster97Adapter } from "../../solver/amaster97-adapter.js";
import { createSolverAdapterFromEnv } from "../../solver/index.js";
import {
  OTHER_ROUTE_ENV_KEYS,
  assertOAuthRoute,
  createCallBudget,
  describeRouteEnv,
} from "../opponent-eval/memory-prompt-eval.js";
import { REVIEW_EVAL_CASES, runReviewEval } from "./harness.js";
import { summarizeReviewEval, unmetReviewTargets } from "./metrics.js";
import {
  REVIEW_RECORDING_URL,
  toRecordedReviewCases,
  type ReviewEvalRecording,
} from "./recording.js";

const { values } = parseArgs({
  options: {
    repeats: { type: "string", default: "1" },
    depth: { type: "string", default: "standard" },
    solver: { type: "boolean", default: false },
    record: { type: "boolean", default: false },
  },
});
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1) {
  throw new RangeError(`--repeats は 1 以上の整数: ${values.repeats}`);
}
const depth = values.depth;
if (depth !== "standard" && depth !== "deep") {
  throw new RangeError(`--depth は standard か deep: ${depth}`);
}
if (values.record && (values.solver || depth !== "standard")) {
  throw new RangeError(
    "--record は Solver なし・depth standard でだけ取る（CI の再生と同じ条件）",
  );
}
// 実測のための上限。本番の REVIEW_TIMEOUT_MS ではなく十分長くし、分布をそのまま取る（claude-smoke と同じ）。
const MEASURE_TIMEOUT_MS = 600_000;
/** 1 回の実行で Claude を呼んでよい回数の上限（#168 の人間判断: 4 判断 × repeat 3 = 12 Review・Retry を含めて最大 24 回）。 */
const REVIEW_EVAL_MAX_CALLS = 24;
// 最悪（全判断が Retry する）の呼び出しの数が上限を超える実行は、呼ぶ前に拒否する（途中で番人に止められて利用枠だけを使うのを防ぐ）。
const worstCaseCalls = REVIEW_EVAL_CASES.length * repeats * 2;
if (worstCaseCalls > REVIEW_EVAL_MAX_CALLS) {
  throw new RangeError(
    `--repeats ${repeats} は Retry を含めて最大 ${worstCaseCalls} 回呼びうるので、上限 ${REVIEW_EVAL_MAX_CALLS} 回を超える（判断 ${REVIEW_EVAL_CASES.length} × repeat ${Math.floor(REVIEW_EVAL_MAX_CALLS / (REVIEW_EVAL_CASES.length * 2))} まで）`,
  );
}

// 経路の確認（値は出さない）。buildClaudeEnv は API キーを子プロセスから外すが、親（シェル）にあるだけでも止める（D123・D126 と同じ作法）。
const env = buildClaudeEnv(process.env);
console.log(describeRouteEnv(env, process.env));
const parentRouteKeys = [
  ...API_BILLING_ENV_KEYS,
  ...OTHER_ROUTE_ENV_KEYS,
].filter((k) => process.env[k] !== undefined);
if (parentRouteKeys.length > 0) {
  throw new Error(
    `OAuth 以外の経路に切り替わる変数がシェルの env にある: ${parentRouteKeys.join(", ")}（呼ばずに止める）`,
  );
}
assertOAuthRoute(env);
const budget = createCallBudget(REVIEW_EVAL_MAX_CALLS);

const kb = loadKb();
const solver = values.solver
  ? createSolverAdapterFromEnv()
  : createAmaster97Adapter({
      install: { installed: false, detail: "Review Eval（Solver なし）" },
      timeoutMs: 1,
      maxConcurrency: 1,
      iterations: 1,
    });
const model =
  depth === "deep" ? MODEL_ROLES.review_deep : MODEL_ROLES.review_standard;
const population = { cases: REVIEW_EVAL_CASES.map((c) => c.id), repeats };
const records = await runReviewEval({
  cases: REVIEW_EVAL_CASES,
  repeats,
  depth,
  kb,
  solver,
  env,
  queryFor: () => budget.wrap(sdkQuery),
  timeoutMs: MEASURE_TIMEOUT_MS,
  onRecord: (r, done, total) => {
    const final =
      r.final.kind === "review"
        ? `${r.final.generatedBy} ${r.final.assessment}\n${r.final.text}\n根拠: ${r.final.cited.join(", ")}\n識別子（置換前）: ${r.final.identifiers.raw.join(", ") || "なし"} / （置換後）: ${r.final.identifiers.residual.join(", ") || "なし"}`
        : `障害: ${r.final.message}`;
    console.log(
      `[${done}/${total}] ${r.caseId}#${r.repeat}（${r.attempts.length} 回・${r.attempts.map((a) => a.ms).join(" / ")} ms・Solver ${r.solverStatus}）${final}\n`,
    );
  },
});
console.log(
  `Claude の呼び出し: ${budget.used()} 回（上限 ${REVIEW_EVAL_MAX_CALLS}）`,
);
const summary = summarizeReviewEval(records, population);
const unmet = unmetReviewTargets(summary);
console.log(JSON.stringify({ model, summary }, null, 2));
console.log(
  unmet.length === 0
    ? "合格ライン: すべて届いた"
    : `合格ライン: 届かなかった指標 ${unmet.join(" / ")}`,
);

if (values.record) {
  if (summary.outages > 0) {
    console.error("障害があったので録画しない（障害の無い実行で取り直す）");
    process.exit(1);
  }
  const serverPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  const recording: ReviewEvalRecording = {
    version: 1,
    recordedAt: new Date().toISOString(),
    model,
    sdkVersion:
      serverPackage.dependencies["@anthropic-ai/claude-agent-sdk"] ?? "unknown",
    kbVersion: kb.version,
    ...population,
    records: toRecordedReviewCases(records),
    summary,
  };
  writeFileSync(
    REVIEW_RECORDING_URL,
    `${JSON.stringify(recording, null, 2)}\n`,
  );
  console.log(`録画を書いた: ${REVIEW_RECORDING_URL.pathname}`);
}
