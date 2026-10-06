// AI Opponent Eval の手動実行（Issue #53・docs/09 §5）。実際に Claude を呼ぶので CI と pnpm test では動かさない（D87）。
// Claude Code のログイン（OAuth・サブスク枠）で呼び、API キーは子プロセスの環境から外す（buildClaudeEnv）。利用枠は開発の Claude Code と共有する。
// 実行: pnpm --filter @proj-poker/server eval:opponent [--repeats 3] [--concurrency 1] [--record]
//   --record: 結果を録画（recordings/opponent-eval.json）に書く。CI はこの録画を再生して集計する。障害が 1 件でもあれば書かない。
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { MODEL_ROLES } from "../../config.js";
import { buildClaudeEnv } from "../../opponents/claude-opponent.js";
import { PERSONA_PRESET_IDS } from "../../opponents/persona.js";
import { runOpponentEval } from "./harness.js";
import { summarizeOpponentEval, unmetTargets } from "./metrics.js";
import {
  RECORDING_URL,
  toRecordedCases,
  type OpponentEvalRecording,
} from "./recording.js";
import { OPPONENT_EVAL_SPOTS } from "./spots.js";

const { values } = parseArgs({
  options: {
    repeats: { type: "string", default: "3" },
    concurrency: { type: "string", default: "1" },
    record: { type: "boolean", default: false },
  },
});
const repeats = Number(values.repeats);
const concurrency = Number(values.concurrency);
if (!Number.isSafeInteger(repeats) || repeats < 1) {
  throw new RangeError(`--repeats は 1 以上の整数: ${values.repeats}`);
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  throw new RangeError(`--concurrency は 1 以上の整数: ${values.concurrency}`);
}
// 実測のための上限。本番の OPPONENT_TIMEOUT_MS ではなく十分長くし、分布をそのまま取る（claude-smoke と同じ）。
const MEASURE_TIMEOUT_MS = 120_000;

const population = {
  spots: OPPONENT_EVAL_SPOTS.map((s) => s.id),
  personas: PERSONA_PRESET_IDS,
  repeats,
};
const records = await runOpponentEval({
  spots: OPPONENT_EVAL_SPOTS,
  personas: PERSONA_PRESET_IDS,
  repeats,
  model: MODEL_ROLES.opponent_fast,
  env: buildClaudeEnv(process.env),
  queryFor: () => sdkQuery,
  concurrency,
  timeoutMs: MEASURE_TIMEOUT_MS,
  onRecord: (r, done, total) => {
    const final =
      r.final.kind === "claude"
        ? JSON.stringify(r.attempts.at(-1)?.output)
        : r.final.kind === "outage"
          ? `障害: ${r.final.message}`
          : "Fallback";
    console.log(
      `[${done}/${total}] ${r.spotId}/${r.personaId}/${r.repeat}（${r.attempts.length} 回）${final}`,
    );
  },
});
const summary = summarizeOpponentEval(records, population);
const unmet = unmetTargets(summary);
console.log(
  JSON.stringify({ model: MODEL_ROLES.opponent_fast, summary }, null, 2),
);
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
  const recording: OpponentEvalRecording = {
    version: 1,
    recordedAt: new Date().toISOString(),
    model: MODEL_ROLES.opponent_fast,
    sdkVersion:
      serverPackage.dependencies["@anthropic-ai/claude-agent-sdk"] ?? "unknown",
    ...population,
    concurrency,
    cases: toRecordedCases(records),
    summary,
  };
  writeFileSync(RECORDING_URL, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`録画を書いた: ${RECORDING_URL.pathname}`);
}
