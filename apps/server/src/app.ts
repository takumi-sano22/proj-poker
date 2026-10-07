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
  type OpponentInfo,
  type TableSetup,
} from "./config.js";
import { DrillService } from "./drill/drill-service.js";
import { InMemoryDrillStore, type DrillStore } from "./drill/drill-store.js";
import { InMemoryEventStore, type EventStore } from "./event-store.js";
import { HandOrchestrator } from "./hand-orchestrator.js";
import type { OpponentFactory } from "./opponents/opponent-agent.js";
import { createRuleBot } from "./opponents/rule-bot.js";
import { loadKb, type LoadedKb } from "./kb/index.js";
import {
  InMemoryHypothesisSnapshotStore,
  type HypothesisSnapshotStore,
} from "./learning/hypothesis-snapshot.js";
import {
  InMemoryLearningResetStore,
  type LearningResetStore,
} from "./learning/learning-reset.js";
import { LearningService } from "./learning/learning-service.js";
import { InMemoryNoteStore, type NoteStore } from "./notes/note-store.js";
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
import { registerDrillRoutes } from "./routes/drills.js";
import { registerHandRoutes } from "./routes/hands.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerNoteRoutes } from "./routes/notes.js";
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
  /** createOpponent の実装の記録用の説明（Hand ごとの Metadata。#97）。省略時は RuleBot（createOpponent の既定と同じ）。 */
  readonly opponentInfo?: OpponentInfo;
  readonly nextSeed?: () => number;
  readonly nextHandId?: () => string;
  readonly review?: ReviewAppOptions;
  /** Hero の Note / Tag の Store（#115）。起動時は SQLite（v5）、省略時のメモリ内実装はテスト用。 */
  readonly noteStore?: NoteStore;
  /** Weakness Hypothesis の Snapshot（#114・#116）。起動時は SQLite（v6）、省略時のメモリ内実装はテスト用。 */
  readonly hypothesisSnapshot?: HypothesisSnapshotStore;
  /** Targeted Drill の記録（#117）。起動時は SQLite（v7）、省略時のメモリ内実装はテスト用。 */
  readonly drillStore?: DrillStore;
  /** Learning Reset の区切り（#118・D114）。起動時は SQLite（v8）、省略時のメモリ内実装はテスト用。 */
  readonly learningResetStore?: LearningResetStore;
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
  // Drill の Hand（D116）は通常の集計・Resume・Replay の一覧から除く。除く対象は drills テーブルから読むたびに作る。
  const drillStore = options.drillStore ?? new InMemoryDrillStore();
  const drillHandIds = () => drillStore.drillHandIds();
  // seed はサーバーだけが持つ。クライアントから受け取らず、レスポンスにも出さない（Deck を推測させない）。
  const nextSeed = options.nextSeed ?? (() => randomInt(0, 2 ** 32));
  const nextHandId = options.nextHandId ?? randomUUID;
  const orchestrator = new HandOrchestrator({
    store,
    setup,
    createOpponent: options.createOpponent ?? createRuleBot,
    ...(options.opponentInfo === undefined
      ? {}
      : { opponentInfo: options.opponentInfo }),
    botDelayMs: options.botDelayMs ?? DEFAULT_BOT_THINK_DELAY_MS,
    opponentTimeoutMs: options.opponentTimeoutMs ?? DEFAULT_OPPONENT_TIMEOUT_MS,
    nextSeed,
    nextHandId,
    excludeFromResume: drillHandIds,
    logger: app.log,
  });
  app.addHook("onClose", (_instance, done) => {
    orchestrator.close();
    done();
  });

  registerHandRoutes(app, orchestrator);
  // Note / Tag は Hero だけの記録で、Orchestrator（CPU の入力）・Review へは渡さない（不変条件 2）。
  registerNoteRoutes(
    app,
    orchestrator,
    options.noteStore ?? new InMemoryNoteStore(),
  );
  // Hero はちょうど 1 人（Orchestrator の生成で検証済み）。
  const heroId = setup.players.find((p) => p.kind === "hero")?.playerId ?? "";
  registerReplayRoutes(
    app,
    new ReplayService(store, heroId, setup.players, drillHandIds),
  );

  // Review は保存済みの Hand を読むので、Replay と同じ Store を使う。省略時は Solver を未導入・Claude を呼ばない形にする（テスト用）。
  const review = options.review ?? {};
  const reviewStore = review.store ?? new InMemoryReviewStore();
  const reviews = new ReviewService({
    events: store,
    reviews: reviewStore,
    reveals: review.revealStore ?? new InMemoryRevealReviewStore(),
    followUps: review.followUpStore ?? new InMemoryFollowUpStore(),
    heroId,
    players: setup.players,
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

  // Session Review・Player Profile（#116）は、同じ Event Store と Pass A の reviews を読むだけ（Review を作らない。D115）。
  // Pass B の Store は渡さない（Hindsight を Score・Profile に混ぜない）。
  // Learning Reset（#118・D114）は区切りの行を足すだけで、正本（Event Log・reviews・Note / Tag）を消さない。
  // Reset の前後は Event Store と同じ順序の源の番号で決める（D117。起動時は同じ DB の ordinals、省略時はプロセスのカウンタ）。
  const learningResets =
    options.learningResetStore ?? new InMemoryLearningResetStore();
  registerLearningRoutes(
    app,
    new LearningService({
      events: store,
      reviews: reviewStore,
      heroId,
      hypotheses:
        options.hypothesisSnapshot ?? new InMemoryHypothesisSnapshotStore(),
      resets: learningResets,
      excludeHandIds: drillHandIds,
    }),
  );

  // Targeted Drill（#117）。元の判断の Pass A の Review を provenance にし、Drill の Hand は Orchestrator で通常の Hand として進める。
  // Drill の判断の Review は既存の Review の API をそのまま使う（D116）。集計は通常の Score と別の系列（D105）。
  registerDrillRoutes(
    app,
    new DrillService({
      events: store,
      reviews: reviewStore,
      drills: drillStore,
      orchestrator,
      heroId,
      table: setup.table,
      nextSeed,
      nextHandId,
      // Drill の系列の Score も、通常の Score と同じ Learning Reset のカテゴリ（score）で区切る（D114。暫定）。
      scoreBoundary: () => learningResets.boundaries().score,
    }),
    orchestrator,
  );

  return app;
}
