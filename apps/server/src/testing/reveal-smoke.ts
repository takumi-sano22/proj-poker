// Reveal Review（Pass B）と Follow-up の手動スモーク（#83）。実際に Claude を呼ぶので CI と pnpm test では動かさない（D87）。
// 本番と同じ関数（buildReviewEvidence / generateReview・buildRevealEvidence / generateRevealReview・generateFollowUp）で、固定 Hand の
// 1 つの判断について Pass A → Pass B → Pass A への Follow-up（Hand 後の情報を聞く）→ Pass B への Follow-up 2 ターンを作り、
// 呼び出しごとの Latency と要点を表示する。Claude Code のログイン（OAuth・サブスク枠）で呼び、API キーは子プロセスの環境から外す。
// 実行: pnpm --filter @proj-poker/server smoke:reveal
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  extractImportantSpots,
  heroInformationSets,
  projectLearningReveal,
} from "@proj-poker/engine";
import {
  buildClaudeEnv,
  type ClaudeQuery,
} from "../claude/structured-query.js";
import { loadKb } from "../kb/index.js";
import { buildReviewEvidence } from "../review/evidence.js";
import { generateFollowUp } from "../review/followup.js";
import { generateReview } from "../review/generate.js";
import { generateRevealReview } from "../review/generate-reveal.js";
import { buildRevealEvidence } from "../review/reveal-evidence.js";
import type { FollowUpRecord, FollowUpTarget } from "../review/reveal-types.js";
import { createAmaster97Adapter } from "../solver/amaster97-adapter.js";
import { BTN_VS_UTG, playScriptedHand } from "./review-eval/hands.js";

const DECISION_INDEX = 3;
// 実測のための上限。本番の REVIEW_TIMEOUT_MS ではなく十分長くし、所要時間をそのまま取る。
const MEASURE_TIMEOUT_MS = 600_000;

const env = buildClaudeEnv(process.env);
const latencies: { label: string; ms: number }[] = [];
let label = "";
// SDK の query() をそのまま呼び、所要時間だけを測る（引数・応答は変えない）。
const timedQuery: ClaudeQuery = (params) =>
  (async function* () {
    const start = performance.now();
    try {
      yield* sdkQuery(params);
    } finally {
      latencies.push({ label, ms: Math.round(performance.now() - start) });
    }
  })();
const common = {
  env,
  query: timedQuery,
  signalFor: () => AbortSignal.timeout(MEASURE_TIMEOUT_MS),
} as const;

const events = playScriptedHand(BTN_VS_UTG);
const sets = heroInformationSets(events, "hero");
const set = sets[DECISION_INDEX];
const reveal = projectLearningReveal(events);
if (set === undefined || reveal === null) throw new Error("固定 Hand の誤り");
const reasons =
  extractImportantSpots(sets).find((s) => s.decisionIndex === DECISION_INDEX)
    ?.reasons ?? [];

label = "Pass A";
const decisionEvidence = await buildReviewEvidence(set, reasons, {
  kb: loadKb(),
  solver: createAmaster97Adapter({
    install: { installed: false, detail: "スモーク（Solver なし）" },
    timeoutMs: 1,
    maxConcurrency: 1,
    iterations: 1,
  }),
});
const decision = await generateReview(decisionEvidence, {
  ...common,
  depth: "standard",
  actionSeq: set.decision.actionSeq,
});
console.log(`[Pass A] ${decision.generatedBy} / ${decision.assessment}`);

label = "Pass B";
const revealEvidence = await buildRevealEvidence(set, reveal, events, reasons);
const revealDraft = await generateRevealReview(revealEvidence, {
  ...common,
  depth: "standard",
  actionSeq: set.decision.actionSeq,
});
console.log(`[Pass B] ${revealDraft.generatedBy}`);
console.log(JSON.stringify(revealDraft.explanation, null, 2));

/** 作った Follow-up を保存したときの形にする（履歴として次のターンの Prompt に入れる）。 */
function asRecord(
  draft: Awaited<ReturnType<typeof generateFollowUp>>,
  turn: number,
): FollowUpRecord {
  return {
    ...draft,
    followupId: `smoke-${turn}`,
    turn,
    createdAt: new Date().toISOString(),
  };
}

const decisionTarget: FollowUpTarget = {
  pass: "decision",
  reviewId: "smoke-decision",
  handId: decision.handId,
  decisionIndex: DECISION_INDEX,
  version: 1,
  evidence: decision.evidence,
  explanation: decision.explanation,
};
label = "Follow-up（Pass A）";
const leakProbe = await generateFollowUp(
  decisionTarget,
  [],
  "相手の実際の札は何でしたか？結果的にこの Call は正しかったですか？",
  { ...common, depth: "standard" },
);
console.log(
  `[Follow-up Pass A] ${leakProbe.generatedBy} / ${leakProbe.answer.scope}: ${leakProbe.answer.text}`,
);

const revealTarget: FollowUpTarget = {
  pass: "reveal",
  reviewId: "smoke-reveal",
  handId: revealDraft.handId,
  decisionIndex: DECISION_INDEX,
  version: 1,
  evidence: revealDraft.evidence,
  explanation: revealDraft.explanation,
};
const history: FollowUpRecord[] = [];
for (const question of [
  "相手の River の Bet は Value でしたか？",
  "それなら、次に同じ Bet を受けたときは Fold すべきですか？",
]) {
  label = `Follow-up（Pass B）${history.length + 1}`;
  const draft = await generateFollowUp(revealTarget, history, question, {
    ...common,
    depth: "standard",
  });
  history.push(asRecord(draft, history.length + 1));
  console.log(
    `[Follow-up Pass B ${history.length}] ${draft.generatedBy} / ${draft.answer.scope}: ${draft.answer.text}`,
  );
}

console.log("\n# Latency（子プロセスの起動を含む）");
for (const l of latencies) console.log(`${l.label}: ${l.ms} ms`);
