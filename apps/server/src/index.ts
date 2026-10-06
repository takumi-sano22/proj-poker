import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { buildApp } from "./app.js";
import {
  MODEL_ROLES,
  buildTableSetup,
  fixedSeedSequence,
  parseBotDelayMs,
  parseFixedSeed,
  parseOpponentProvider,
  parseOpponentTimeoutMs,
  parsePersonaRotation,
  parseReviewProvider,
  parseReviewTimeoutMs,
  parseTableSize,
  resolveDbPath,
} from "./config.js";
import { openDatabase } from "./db/database.js";
import { loadKb } from "./kb/index.js";
import {
  buildClaudeEnv,
  createClaudeOpponentFactory,
} from "./opponents/claude-opponent.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import {
  SqliteFollowUpStore,
  SqliteRevealReviewStore,
} from "./review/reveal-store.js";
import { fakeReviewQuery } from "./review/fake-review-query.js";
import { SqliteReviewStore } from "./review/review-store.js";
import { createSolverAdapterFromEnv } from "./solver/index.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

// ローカル専用（D61・非目標: Auth / Online Multiplayer）。外部 NIC へ公開しないため loopback に固定し、設定で変えさせない。
const HOST = "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3001);

// CPU の判断に使う実装（既定 RuleBot。D71）。OPPONENT_PROVIDER=claude のときだけ Claude（Agent SDK・OAuth。D87）にする（不正な値は DB を開く前に起動を止める）。
// Claude の子プロセスには API 課金に切り替わる変数（ANTHROPIC_API_KEY 等）を外した環境を渡す。
const provider = parseOpponentProvider(process.env["OPPONENT_PROVIDER"]);
const opponentModel = MODEL_ROLES.opponent_fast;
const claudeEnv = buildClaudeEnv(process.env);
const createOpponent =
  provider === "claude"
    ? createClaudeOpponentFactory({ model: opponentModel, env: claudeEnv })
    : createRuleBot;

// Review AI の実装（既定 Claude）。REVIEW_PROVIDER=fake は E2E 用の固定応答で、Claude を呼ばない（D98。本番では使わない）。
const reviewProvider = parseReviewProvider(process.env["REVIEW_PROVIDER"]);
// 山札の seed。POKER_SEED を設定したときだけ固定の並びにする（E2E の決定論のため。D98）。未設定なら Hand ごとに乱数（app.ts の既定）。
const fixedSeed = parseFixedSeed(process.env["POKER_SEED"]);

// Event Log は SQLite に保存する（D72）。終わった Hand だけが残る（D62）。
// Review（#82）も同じ DB の reviews テーブルに Version 付きで保存する（reviews.hand_id は hands を参照する）。
// Pass B（#83）は reveal_reviews、Follow-up の履歴は review_followups に追記する（どちらも hand_id は hands を参照する）。
const dbPath = resolveDbPath(process.env["POKER_DB_PATH"]);
const db = openDatabase(dbPath);
const store = new SqliteEventStore(db);
// Local KB は起動時に 1 回だけ読む（#80）。壊れていれば起動を止める。
const kb = loadKb();
// Solver は POKER_SOLVER_HOME で導入先を知る。未設定・未導入なら Unsupported として Fallback する（#81。起動は止めない）。
const solver = createSolverAdapterFromEnv();

const app = buildApp({
  botDelayMs: parseBotDelayMs(process.env["BOT_THINK_DELAY_MS"]),
  // CPU の 1 回の判断を待つ上限（暫定値）。環境変数 OPPONENT_TIMEOUT_MS で上書きする。
  opponentTimeoutMs: parseOpponentTimeoutMs(process.env["OPPONENT_TIMEOUT_MS"]),
  // 卓の人数（2〜8。既定 6）。環境変数 TABLE_SIZE で選ぶ。
  // CPU の Persona は席順で割り当てる（OI-005 の暫定値）。環境変数 CPU_PERSONAS（Preset ID のカンマ区切り）で順番を上書きする。
  setup: buildTableSetup(
    parseTableSize(process.env["TABLE_SIZE"]),
    parsePersonaRotation(process.env["CPU_PERSONAS"]),
  ),
  store,
  createOpponent,
  ...(fixedSeed === null ? {} : { nextSeed: fixedSeedSequence(fixedSeed) }),
  // Review AI は Claude（Agent SDK・OAuth。D87・D97）。API 課金に切り替わる変数を外した環境で呼ぶ（REVIEW_PROVIDER=fake のときだけ E2E 用の固定応答）。
  review: {
    store: new SqliteReviewStore(db),
    revealStore: new SqliteRevealReviewStore(db),
    followUpStore: new SqliteFollowUpStore(db),
    kb,
    solver,
    env: claudeEnv,
    query: reviewProvider === "fake" ? fakeReviewQuery : sdkQuery,
    timeoutMs: parseReviewTimeoutMs(process.env["REVIEW_TIMEOUT_MS"]),
  },
});
// アプリの終了時に DB を閉じる。途中の Hand は保存されない（Completed Hand が保存境界。D62）。
app.addHook("onClose", (_instance, done) => {
  store.close();
  done();
});
app.log.info({ dbPath }, "Event Log の保存先");
app.log.info(
  {
    kbVersion: kb.version,
    reviewModels: {
      review_standard: MODEL_ROLES.review_standard,
      review_deep: MODEL_ROLES.review_deep,
    },
  },
  "Review の設定",
);
if (reviewProvider === "fake") {
  app.log.warn(
    { reviewProvider },
    "Review AI は E2E 用の固定応答（Claude を呼ばない）",
  );
}
if (fixedSeed !== null) {
  app.log.warn({ seed: fixedSeed }, "山札の seed を固定している（E2E 用）");
}
app.log.info(
  provider === "claude" ? { provider, model: opponentModel } : { provider },
  "CPU の判断に使う実装",
);

try {
  await app.listen({ host: HOST, port: PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
