import { randomInt, randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  DEFAULT_BOT_THINK_DELAY_MS,
  DEFAULT_OPPONENT_TIMEOUT_MS,
  PHASE1_TABLE_SETUP,
  type TableSetup,
} from "./config.js";
import { InMemoryEventStore, type EventStore } from "./event-store.js";
import { HandOrchestrator } from "./hand-orchestrator.js";
import type { OpponentFactory } from "./opponents/opponent-agent.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import { ReplayService } from "./replay.js";
import { registerHandRoutes } from "./routes/hands.js";
import { registerReplayRoutes } from "./routes/replay.js";

/** 組み立ての差し替え口。テストでは seed・待ち時間・ログを固定する。 */
export interface AppOptions {
  readonly logger?: boolean;
  readonly botDelayMs?: number;
  readonly opponentTimeoutMs?: number;
  readonly setup?: TableSetup;
  readonly store?: EventStore;
  readonly createOpponent?: OpponentFactory;
  readonly nextSeed?: () => number;
  readonly nextHandId?: () => string;
}

// listen と分けて組み立てだけを export する。テストから起動せずに叩けるようにするため。
export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    // 入力は schema のとおりに受ける。型の自動変換（"10" → 10）と、余分な項目の黙った削除をしない。
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  app.get("/api/health", () => ({ status: "ok" }));

  // 起動時（index.ts）は SQLite の Store を渡す（D72）。省略時のメモリ内実装はテスト用。
  // Orchestrator（書く側）と Replay（読む側）は同じ Store を使う。
  const store = options.store ?? new InMemoryEventStore();
  const setup = options.setup ?? PHASE1_TABLE_SETUP;
  const orchestrator = new HandOrchestrator({
    store,
    setup,
    createOpponent: options.createOpponent ?? createRuleBot,
    botDelayMs: options.botDelayMs ?? DEFAULT_BOT_THINK_DELAY_MS,
    opponentTimeoutMs: options.opponentTimeoutMs ?? DEFAULT_OPPONENT_TIMEOUT_MS,
    // seed はサーバーだけが持つ。クライアントから受け取らず、レスポンスにも出さない（Deck を推測させない）。
    nextSeed: options.nextSeed ?? (() => randomInt(0, 2 ** 32)),
    nextHandId: options.nextHandId ?? randomUUID,
    logger: app.log,
  });
  app.addHook("onClose", (_instance, done) => {
    orchestrator.close();
    done();
  });

  registerHandRoutes(app, orchestrator);
  // Hero はちょうど 1 人（Orchestrator の生成で検証済み）。
  const heroId = setup.players.find((p) => p.kind === "hero")?.playerId ?? "";
  registerReplayRoutes(app, new ReplayService(store, heroId, setup.players));

  return app;
}
