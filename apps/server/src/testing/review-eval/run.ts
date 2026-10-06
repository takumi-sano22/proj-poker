// Review Eval の手動実行（Issue #82・docs/09 §6）。実際に Claude を呼ぶので CI と pnpm test では動かさない（D87）。
// Claude Code のログイン（OAuth・サブスク枠）で呼び、API キーは子プロセスの環境から外す（buildClaudeEnv）。利用枠は開発の Claude Code と共有する。
// 実行: pnpm --filter @proj-poker/server eval:review [--repeats 1] [--depth standard|deep] [--solver] [--record]
//   --solver: POKER_SOLVER_HOME の Solver を使う（Supported の Solver Evidence を渡した Review を見る。録画とは併用しない）
//   --record: 結果を録画（recordings/review-eval.json）に書く。CI はこの録画を再生して集計する。障害が 1 件でもあれば書かない。
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeEnv } from "../../claude/structured-query.js";
import { MODEL_ROLES } from "../../config.js";
import { loadKb } from "../../kb/index.js";
import { createAmaster97Adapter } from "../../solver/amaster97-adapter.js";
import { createSolverAdapterFromEnv } from "../../solver/index.js";
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
  env: buildClaudeEnv(process.env),
  queryFor: () => sdkQuery,
  timeoutMs: MEASURE_TIMEOUT_MS,
  onRecord: (r, done, total) => {
    const final =
      r.final.kind === "review"
        ? `${r.final.generatedBy} ${r.final.assessment}\n${r.final.text}\n根拠: ${r.final.cited.join(", ")}`
        : `障害: ${r.final.message}`;
    console.log(
      `[${done}/${total}] ${r.caseId}#${r.repeat}（${r.attempts.length} 回・${r.attempts.map((a) => a.ms).join(" / ")} ms・Solver ${r.solverStatus}）${final}\n`,
    );
  },
});
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
