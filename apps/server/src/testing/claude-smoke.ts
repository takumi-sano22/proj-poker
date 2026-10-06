// Claude の CPU の手動スモーク（#50）。実際に Claude を呼ぶので CI と pnpm test では動かさない（D87）。
// 本番と同じ経路（index.ts と同じ Factory・HandOrchestrator・出力の検証）で Hand を進め、1 回の判断ごとに
// Latency（子プロセスの起動を含む）と、出力が検証を 1 回で通ったか（Valid）を集計する。
// 実行: pnpm --filter @proj-poker/server smoke:claude [最少の呼び出し回数=30] [卓の人数=3]
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { HeroView, PlayerAction } from "@proj-poker/engine";
import { MODEL_ROLES, buildTableSetup } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { HandOrchestrator } from "../hand-orchestrator.js";
import {
  buildClaudeEnv,
  createClaudeOpponentFactory,
  type ClaudeQuery,
} from "../opponents/claude-opponent.js";
import type { OpponentFactory } from "../opponents/opponent-agent.js";
import { checkOpponentOutput } from "../opponents/opponent-output.js";

interface CallRecord {
  readonly ms: number;
  readonly outcome: "valid" | "invalid" | "error";
  readonly detail: string;
}

const minCalls = Number(process.argv[2] ?? 30);
const tableSize = Number(process.argv[3] ?? 3);
// 実測のための上限。本番の OPPONENT_TIMEOUT_MS ではなく十分長くし、分布をそのまま取る。
const MEASURE_TIMEOUT_MS = 120_000;

const records: CallRecord[] = [];
/** 1 回の query ごとの内訳: 最初の message（子プロセスの起動・初期化の完了）までと、API の所要時間（result.duration_api_ms）。 */
const breakdown: { initMs: number; apiMs: number }[] = [];
// SDK の query() をそのまま呼び、流れる message の時刻だけを見る（引数・応答は変えない）。
const timedQuery: ClaudeQuery = (params) =>
  (async function* () {
    const start = performance.now();
    let initMs = NaN;
    for await (const message of sdkQuery(params)) {
      if (Number.isNaN(initMs)) initMs = performance.now() - start;
      if (message.type === "result") {
        breakdown.push({ initMs, apiMs: message.duration_api_ms });
      }
      yield message;
    }
  })();
const inner = createClaudeOpponentFactory({
  model: MODEL_ROLES.opponent_fast,
  env: buildClaudeEnv(process.env),
  query: timedQuery,
});
// 本番の Factory を包み、1 回の判断の時間と検証結果だけを記録する（入力・出力は変えない）。
const measured: OpponentFactory = (seed, playerId) => {
  const agent = inner(seed, playerId);
  return {
    async decide(input, signal) {
      const start = performance.now();
      console.log(`${playerId}: 判断を求める（${records.length + 1} 回目）`);
      try {
        const output = await agent.decide(input, signal);
        const checked = checkOpponentOutput(output, input.legal);
        records.push({
          ms: performance.now() - start,
          outcome: checked.ok ? "valid" : "invalid",
          detail: checked.ok
            ? JSON.stringify(output)
            : `${checked.stage}: ${checked.reason}`,
        });
        return output;
      } catch (error) {
        records.push({
          ms: performance.now() - start,
          outcome: "error",
          detail: String(error),
        });
        throw error;
      }
    },
  };
};

const store = new InMemoryEventStore();
let handNo = 0;
const orchestrator = new HandOrchestrator({
  store,
  setup: buildTableSetup(tableSize),
  createOpponent: measured,
  botDelayMs: 0,
  opponentTimeoutMs: MEASURE_TIMEOUT_MS,
  nextSeed: () => 1000 + handNo,
  nextHandId: () => `smoke-${++handNo}`,
});

/** Hero は Call / Check で Showdown まで進める（CPU の判断の回数を稼ぐ）。 */
function passiveHero(view: HeroView): PlayerAction {
  const types = view.legalActions?.actions.map((a) => a.type) ?? [];
  if (types.includes("call")) return { type: "call" };
  if (types.includes("check")) return { type: "check" };
  return { type: "fold" };
}

// 見終わった Hand の ID を渡して次の Hand へ進む（null のままだと同じ Hand が返る）。
let lastHandId: string | null = null;
while (records.length < minCalls) {
  const started = await orchestrator.startHand(lastHandId);
  if (!started.ok) throw new Error(started.error.message);
  const { handId } = started.value;
  lastHandId = handId;
  let view = started.value.view;
  while (view.status !== "complete" && view.actorId === "hero") {
    const result = await orchestrator.heroAction(
      handId,
      view.log.at(-1)?.seq ?? -1,
      passiveHero(view),
    );
    if (!result.ok) throw new Error(result.error.message);
    view = result.value;
  }
  const outage = orchestrator.outageOf(handId);
  if (outage !== null) {
    console.log("障害で Hand が止まった:", outage.kind, outage.message);
    break;
  }
  console.log(`${handId}: 完了（ここまでの呼び出し ${records.length} 回）`);
}
orchestrator.close();

/** 昇順に並べた値の分位点（中央値は 0.5）。 */
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN,
  );
}
const summary = (values: readonly number[]) => ({
  min: quantile(values, 0),
  median: quantile(values, 0.5),
  p90: quantile(values, 0.9),
  max: quantile(values, 1),
});
const count = (o: CallRecord["outcome"]) =>
  records.filter((r) => r.outcome === o).length;
console.log(
  JSON.stringify(
    {
      model: MODEL_ROLES.opponent_fast,
      calls: records.length,
      valid: count("valid"),
      invalid: count("invalid"),
      error: count("error"),
      latencyMs: summary(records.map((r) => r.ms)),
      initMs: summary(breakdown.map((b) => b.initMs)),
      apiMs: summary(breakdown.map((b) => b.apiMs)),
      notValid: records
        .filter((r) => r.outcome !== "valid")
        .map((r) => `${r.outcome}: ${r.detail}`),
    },
    null,
    2,
  ),
);
