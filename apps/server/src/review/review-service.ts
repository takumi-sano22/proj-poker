// Review Orchestrator（docs/03 §2・§7）。保存済みの Hand の Hero の判断ごとに、Pass A の Review を非同期で作り、Version 付きで保存する。
// - 入力は Event Log（正本）から作る判断時点の Hero Information Set だけ（heroInformationSets。Hindsight Leak の防止・不変条件 3）
// - 生成は Hand の進行と切り離して裏で進め、呼び出し側には「待ち（pending）」の状態を返す（docs/03 §7・async ガイダンス 3）
// - 同じ判断の生成は同時に 1 つだけ（二重に要求しても 2 回は作らない。LC-030）。生成は 1 つずつ順に進める（Claude・Solver の負荷を抑える）
// - Claude の呼び出しの失敗（未ログイン・利用枠・Timeout 等）は Review を作らず、失敗の状態を返して再実行を待つ。Event Log は書き換えない
import {
  extractImportantSpots,
  heroInformationSets,
  type HandEvent,
} from "@proj-poker/engine";
import {
  ClaudeCallError,
  type ClaudeQuery,
} from "../claude/structured-query.js";
import { isHandEnd, type EventStore } from "../event-store.js";
import type { LoadedKb } from "../kb/index.js";
import type { SolverAdapter } from "../solver/types.js";
import { buildReviewEvidence } from "./evidence.js";
import { generateReview } from "./generate.js";
import type { ReviewStore } from "./review-store.js";
import type { ReviewDepth, ReviewRecord } from "./types.js";

/** 生成の失敗の種類。Hero に返すのは種類だけで、内部のエラー本文（資格情報やパスを含みうる）はログにだけ残す。 */
export type ReviewFailureKind =
  "unauthenticated" | "usage_limit" | "timeout" | "error";

export type ReviewGeneration =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly depth: ReviewDepth }
  | {
      readonly state: "failed";
      readonly depth: ReviewDepth;
      readonly kind: ReviewFailureKind;
    };

/** 1 つの判断の Review の状態（API の応答）。latest は最新の Version（生成中・失敗中も前の Version を返す）。 */
export interface ReviewStatus {
  readonly handId: string;
  readonly decisionIndex: number;
  readonly generation: ReviewGeneration;
  readonly latest: ReviewRecord | null;
  readonly versions: number;
}

export interface ReviewServiceError {
  readonly kind: "hand_not_found" | "hand_not_finished" | "decision_not_found";
  readonly message: string;
}

export type ReviewResult =
  | { readonly ok: true; readonly value: ReviewStatus }
  | { readonly ok: false; readonly error: ReviewServiceError };

/** ログの出し先（Fastify の logger と同じ形の一部）。 */
export interface ReviewLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ReviewServiceDeps {
  readonly events: EventStore;
  readonly reviews: ReviewStore;
  readonly heroId: string;
  readonly kb: LoadedKb;
  readonly solver: SolverAdapter;
  /** Claude を呼ぶ子プロセスの環境（buildClaudeEnv の結果）。 */
  readonly env: Record<string, string>;
  /** 省略時は SDK の query()。テストは Fake。 */
  readonly query?: ClaudeQuery;
  /** Review AI の 1 回の呼び出しの上限（ミリ秒）。 */
  readonly timeoutMs: number;
  readonly logger?: ReviewLogger;
}

const PASS = "decision" as const;

export class ReviewService {
  private readonly generations = new Map<string, ReviewGeneration>();
  /** 生成は 1 つずつ順に進める（前の生成の終わりに次をつなぐ）。 */
  private queue: Promise<void> = Promise.resolve();
  /** アプリの終了で、進行中の Claude・Solver の子プロセスを止める。 */
  private readonly closing = new AbortController();

  constructor(private readonly deps: ReviewServiceDeps) {}

  /** その判断の Review の状態（最新の Version と生成の状態）。 */
  status(handId: string, decisionIndex: number): ReviewResult {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    return { ok: true, value: this.snapshot(handId, decisionIndex) };
  }

  /**
   * その判断の Review の新しい Version の生成を始め、待ちの状態を返す。同じ判断を生成中なら、新しくは始めずに今の状態を返す。
   * 生成済みの判断でも、要求するたびに次の Version を作る（過去の Version は残る。D39）。
   */
  request(
    handId: string,
    decisionIndex: number,
    depth: ReviewDepth,
  ): ReviewResult {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    const key = keyOf(handId, decisionIndex);
    if (
      this.generations.get(key)?.state !== "pending" &&
      !this.closing.signal.aborted
    ) {
      this.generations.set(key, { state: "pending", depth });
      const run = () =>
        this.generate(handId, decisionIndex, depth, target.events);
      this.queue = this.queue.then(run, run);
    }
    return { ok: true, value: this.snapshot(handId, decisionIndex) };
  }

  /** 進行中・待ちの生成がすべて終わるまで待つ（テスト用）。 */
  idle(): Promise<void> {
    return this.queue;
  }

  /** アプリの終了。進行中の Claude・Solver の子プロセスを止め、待ちの生成は始めない。 */
  close(): void {
    this.closing.abort();
  }

  private snapshot(handId: string, decisionIndex: number): ReviewStatus {
    const records = this.deps.reviews.list(handId, decisionIndex, PASS);
    return {
      handId,
      decisionIndex,
      generation: this.generations.get(keyOf(handId, decisionIndex)) ?? {
        state: "idle",
      },
      latest: records.at(-1) ?? null,
      versions: records.length,
    };
  }

  /** Review を作れる判断か（保存済みで終わった Hand の、Hero の判断）。 */
  private target(
    handId: string,
    decisionIndex: number,
  ):
    | { readonly ok: true; readonly events: readonly HandEvent[] }
    | { readonly ok: false; readonly error: ReviewServiceError } {
    const events = this.deps.events.read(handId).map((s) => s.event);
    if (events.length === 0) {
      return {
        ok: false,
        error: { kind: "hand_not_found", message: `Hand が無い: ${handId}` },
      };
    }
    // Review は終わった Hand だけ（docs/03 §4: Hand Finished → Review 可能）。打ち切った Hand（D95）の判断も対象にする。
    if (!events.some(isHandEnd)) {
      return {
        ok: false,
        error: {
          kind: "hand_not_finished",
          message: `Hand が終わっていない: ${handId}`,
        },
      };
    }
    const decisions = heroInformationSets(events, this.deps.heroId);
    if (decisions[decisionIndex] === undefined) {
      return {
        ok: false,
        error: {
          kind: "decision_not_found",
          message: `Hero の判断が無い: ${handId} の ${decisionIndex}`,
        },
      };
    }
    return { ok: true, events };
  }

  private async generate(
    handId: string,
    decisionIndex: number,
    depth: ReviewDepth,
    events: readonly HandEvent[],
  ): Promise<void> {
    const key = keyOf(handId, decisionIndex);
    const log = this.deps.logger;
    if (this.closing.signal.aborted) return;
    let timeout: AbortSignal | undefined;
    try {
      const sets = heroInformationSets(events, this.deps.heroId);
      const set = sets[decisionIndex];
      if (set === undefined) throw new Error("判断が無い");
      const reasons =
        extractImportantSpots(sets).find(
          (s) => s.decisionIndex === decisionIndex,
        )?.reasons ?? [];
      const evidence = await buildReviewEvidence(set, reasons, {
        kb: this.deps.kb,
        solver: this.deps.solver,
        signal: this.closing.signal,
        onSolverFailure: (error) =>
          log?.warn(
            { handId, decisionIndex, err: error },
            "Solver の失敗（Math・Range・KB へ Fallback）",
          ),
      });
      const started = performance.now();
      const draft = await generateReview(evidence, {
        depth,
        actionSeq: set.decision.actionSeq,
        env: this.deps.env,
        query: this.deps.query,
        signalFor: () => {
          // 呼び出しごとに上限を掛け直す（Retry の 2 回目にも同じ上限）。
          timeout = AbortSignal.timeout(this.deps.timeoutMs);
          return AbortSignal.any([this.closing.signal, timeout]);
        },
        onAttempt: ({ check }) => {
          if (!check.ok) {
            log?.warn(
              {
                handId,
                decisionIndex,
                stage: check.stage,
                reason: check.reason,
              },
              "Review AI の出力が不正",
            );
          }
        },
      });
      if (this.closing.signal.aborted) return;
      const record = this.deps.reviews.append(draft);
      this.generations.delete(key);
      log?.info(
        {
          handId,
          decisionIndex,
          version: record.version,
          generatedBy: record.generatedBy,
          assessment: record.assessment,
          ms: Math.round(performance.now() - started),
        },
        "Review を保存した",
      );
    } catch (error) {
      if (this.closing.signal.aborted) return;
      const kind: ReviewFailureKind =
        timeout?.aborted === true
          ? "timeout"
          : error instanceof ClaudeCallError
            ? error.failureKind
            : "error";
      // 本文はログにだけ残す（Hero への応答には種類だけ）。
      log?.error(
        { handId, decisionIndex, kind, err: error },
        "Review の生成に失敗",
      );
      this.generations.set(key, { state: "failed", depth, kind });
    }
  }
}

function keyOf(handId: string, decisionIndex: number): string {
  return `${handId}#${decisionIndex}`;
}
