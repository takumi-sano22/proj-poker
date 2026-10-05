import { buildApp } from "./app.js";
import {
  buildTableSetup,
  parseBotDelayMs,
  parseOpponentTimeoutMs,
  parseTableSize,
  resolveDbPath,
} from "./config.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

// ローカル専用（D61・非目標: Auth / Online Multiplayer）。外部 NIC へ公開しないため loopback に固定し、設定で変えさせない。
const HOST = "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3001);

// Event Log は SQLite に保存する（D72）。終わった Hand だけが残る（D62）。
const dbPath = resolveDbPath(process.env["POKER_DB_PATH"]);
const store = SqliteEventStore.open(dbPath);

const app = buildApp({
  botDelayMs: parseBotDelayMs(process.env["BOT_THINK_DELAY_MS"]),
  // CPU の 1 回の判断を待つ上限（暫定値）。環境変数 OPPONENT_TIMEOUT_MS で上書きする。
  opponentTimeoutMs: parseOpponentTimeoutMs(process.env["OPPONENT_TIMEOUT_MS"]),
  // 卓の人数（2〜8。既定 6）。環境変数 TABLE_SIZE で選ぶ。
  setup: buildTableSetup(parseTableSize(process.env["TABLE_SIZE"])),
  store,
});
// アプリの終了時に DB を閉じる。途中の Hand は保存されない（Completed Hand が保存境界。D62）。
app.addHook("onClose", (_instance, done) => {
  store.close();
  done();
});
app.log.info({ dbPath }, "Event Log の保存先");

try {
  await app.listen({ host: HOST, port: PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
