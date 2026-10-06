import { buildApp } from "./app.js";
import {
  MODEL_ROLES,
  buildTableSetup,
  parseBotDelayMs,
  parseOpponentProvider,
  parseOpponentTimeoutMs,
  parsePersonaRotation,
  parseTableSize,
  resolveDbPath,
} from "./config.js";
import {
  buildClaudeEnv,
  createClaudeOpponentFactory,
} from "./opponents/claude-opponent.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

// ローカル専用（D61・非目標: Auth / Online Multiplayer）。外部 NIC へ公開しないため loopback に固定し、設定で変えさせない。
const HOST = "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3001);

// CPU の判断に使う実装（既定 RuleBot。D71）。OPPONENT_PROVIDER=claude のときだけ Claude（Agent SDK・OAuth。D87）にする（不正な値は DB を開く前に起動を止める）。
// Claude の子プロセスには API 課金に切り替わる変数（ANTHROPIC_API_KEY 等）を外した環境を渡す。
const provider = parseOpponentProvider(process.env["OPPONENT_PROVIDER"]);
const opponentModel = MODEL_ROLES.opponent_fast;
const createOpponent =
  provider === "claude"
    ? createClaudeOpponentFactory({
        model: opponentModel,
        env: buildClaudeEnv(process.env),
      })
    : createRuleBot;

// Event Log は SQLite に保存する（D72）。終わった Hand だけが残る（D62）。
const dbPath = resolveDbPath(process.env["POKER_DB_PATH"]);
const store = SqliteEventStore.open(dbPath);

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
});
// アプリの終了時に DB を閉じる。途中の Hand は保存されない（Completed Hand が保存境界。D62）。
app.addHook("onClose", (_instance, done) => {
  store.close();
  done();
});
app.log.info({ dbPath }, "Event Log の保存先");
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
