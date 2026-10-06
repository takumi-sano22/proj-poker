import { randomInt, randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  ClaudeCallError,
  type ClaudeQuery,
} from "./claude/structured-query.js";
import {
  DEFAULT_BOT_THINK_DELAY_MS,
  DEFAULT_OPPONENT_TIMEOUT_MS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  PHASE1_TABLE_SETUP,
  type TableSetup,
} from "./config.js";
import { InMemoryEventStore, type EventStore } from "./event-store.js";
import { HandOrchestrator } from "./hand-orchestrator.js";
import type { OpponentFactory } from "./opponents/opponent-agent.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import { loadKb, type LoadedKb } from "./kb/index.js";
import { ReplayService } from "./replay.js";
import {
  InMemoryFollowUpStore,
  InMemoryRevealReviewStore,
  type FollowUpStore,
  type RevealReviewStore,
} from "./review/reveal-store.js";
import {
  InMemoryReviewStore,
  type ReviewStore,
} from "./review/review-store.js";
import { ReviewService } from "./review/review-service.js";
import { registerHandRoutes } from "./routes/hands.js";
import { registerReplayRoutes } from "./routes/replay.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { createAmaster97Adapter } from "./solver/amaster97-adapter.js";
import type { SolverAdapter } from "./solver/types.js";

/** Review（#82・#83）の組み立て。起動時（index.ts）は SQLite の Store・環境変数の Solver・SDK の query() を渡す。 */
export interface ReviewAppOptions {
  readonly store?: ReviewStore;
  /** Pass B（Reveal Review）の Store。 */
  readonly revealStore?: RevealReviewStore;
  /** Follow-up の履歴の Store。 */
  readonly followUpStore?: FollowUpStore;
  readonly kb?: LoadedKb;
  readonly solver?: SolverAdapter;
  /** Claude を呼ぶ子プロセスの環境（buildClaudeEnv の結果）。 */
  readonly env?: Record<string, string>;
  /** Review AI の query()。省略時は呼ぶと失敗する query（テストで Claude を呼ばない。D87）。 */
  readonly query?: ClaudeQuery;
  readonly timeoutMs?: number;
}

/** query を渡さなかったときの Review AI。Claude を呼ばずに失敗させる（CI と pnpm test は Claude を呼ばない。D87）。 */
const reviewQueryNotConfigured: ClaudeQuery = () => {
  throw new ClaudeCallError("Review AI の query が設定されていない");
};

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
  readonly review?: ReviewAppOptions;
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

  // Review は保存済みの Hand を読むので、Replay と同じ Store を使う。省略時は Solver を未導入・Claude を呼ばない形にする（テスト用）。
  const review = options.review ?? {};
  const reviews = new ReviewService({
    events: store,
    reviews: review.store ?? new InMemoryReviewStore(),
    reveals: review.revealStore ?? new InMemoryRevealReviewStore(),
    followUps: review.followUpStore ?? new InMemoryFollowUpStore(),
    heroId,
    kb: review.kb ?? loadKb(),
    solver:
      review.solver ??
      createAmaster97Adapter({
        install: { installed: false, detail: "テスト用（Solver なし）" },
        timeoutMs: 1,
        maxConcurrency: 1,
        iterations: 1,
      }),
    env: review.env ?? {},
    query: review.query ?? reviewQueryNotConfigured,
    timeoutMs: review.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    logger: app.log,
  });
  app.addHook("onClose", (_instance, done) => {
    reviews.close();
    done();
  });
  registerReviewRoutes(app, reviews);

  return app;
}
