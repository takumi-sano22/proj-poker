// Review Orchestrator（docs/03 §2・§7）。保存済みの Hand の Hero の判断ごとに、Pass A（Decision Review）・Pass B（Reveal Review。#83）の
// Review と、Review の Version への Follow-up の答えを非同期で作り、Version / ターン付きで追記する。
// - Pass A の入力は Event Log（正本）から作る判断時点の Hero Information Set だけ（heroInformationSets。Hindsight Leak の防止・不変条件 3）
//   と、判断の Hand より前に保存した同じ Session の Hand の public の Event だけから作る Hero の Table Tendency（D122・#153）
// - Pass B だけが Hand 後の Learning-only Full Reveal（projectLearningReveal）を使う。Pass B の Evidence は Pass A・CPU の入力に渡さない
// - Follow-up は指定した Pass の Review の Evidence だけで答える（Pass A への質問に Hand 後の情報を混ぜない）
// - 生成は Hand の進行と切り離して裏で進め、呼び出し側には「待ち（pending）」の状態を返す（docs/03 §7・async ガイダンス 3）
// - 同じ対象の生成は同時に 1 つだけ（二重に要求しても 2 回は作らない。LC-030）。生成は Pass A・Pass B・Follow-up をまとめて 1 つずつ順に進める
//   （Claude・Solver の負荷を抑える）
// - Claude の呼び出しの失敗（未ログイン・利用枠・Timeout 等）は Review を作らず、失敗の状態を返して再実行を待つ。Event Log は書き換えない
import {
  extractImportantSpots,
  heroInformationSets,
  projectLearningReveal,
  type HandEvent,
} from "@proj-poker/engine";
import {
  ClaudeCallError,
  type ClaudeQuery,
} from "../claude/structured-query.js";
import { isHandEnd, type EventStore } from "../event-store.js";
import type { LoadedKb } from "../kb/index.js";
import {
  buildHeroTableTendencyFromStore,
  type TableTendency,
} from "../memory/table-tendency.js";
import type { SolverAdapter } from "../solver/types.js";
import { buildReviewEvidence } from "./evidence.js";
import { generateReview } from "./generate.js";
import { toPlayerNames } from "./identifiers.js";
import { generateRevealReview } from "./generate-reveal.js";
import { FOLLOWUP_MAX_TURNS, generateFollowUp } from "./followup.js";
import { buildRevealEvidence } from "./reveal-evidence.js";
import type { FollowUpStore, RevealReviewStore } from "./reveal-store.js";
import type {
  FollowUpRecord,
  FollowUpTarget,
  RevealReviewRecord,
} from "./reveal-types.js";
import type { ReviewStore } from "./review-store.js";
import type { ReviewDepth, ReviewPass, ReviewRecord } from "./types.js";

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

/** 1 つの判断の Pass B の状態（API の応答）。latest は最新の Version。 */
export interface RevealStatus {
  readonly handId: string;
  readonly decisionIndex: number;
  readonly generation: ReviewGeneration;
  readonly latest: RevealReviewRecord | null;
  readonly versions: number;
}

/** 1 つの Review の Version への Follow-up の状態（API の応答）。turns は古い順の全ターン。 */
export interface FollowUpStatus {
  readonly handId: string;
  readonly decisionIndex: number;
  readonly pass: ReviewPass;
  readonly version: number;
  readonly reviewId: string;
  readonly generation: ReviewGeneration;
  readonly turns: readonly FollowUpRecord[];
  /** 続けられるターン数の上限（FOLLOWUP_MAX_TURNS）。 */
  readonly maxTurns: number;
}

export interface ReviewServiceError {
  readonly kind:
    | "hand_not_found"
    | "hand_not_finished"
    | "decision_not_found"
    /** 指定した Pass・Version の Review が無い */
    | "review_not_found"
    /** 同じ Review の Version への前の質問の答えを作っている */
    | "followup_in_progress"
    /** Follow-up のターン数が上限に達した */
    | "followup_limit"
    /** 質問が空 */
    | "invalid_question";
  readonly message: string;
}

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ReviewServiceError };

export type ReviewResult = ServiceResult<ReviewStatus>;
export type RevealResult = ServiceResult<RevealStatus>;
export type FollowUpResult = ServiceResult<FollowUpStatus>;

/** ログの出し先（Fastify の logger と同じ形の一部）。 */
export interface ReviewLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ReviewServiceDeps {
  readonly events: EventStore;
  readonly reviews: ReviewStore;
  /** Pass B（reveal_reviews）。 */
  readonly reveals: RevealReviewStore;
  /** Follow-up の履歴（review_followups）。 */
  readonly followUps: FollowUpStore;
  readonly heroId: string;
  /** 卓の Player。Review の文で席を呼ぶ表示名（Hero の画面に出ている名前）を Evidence に添える（#96）。 */
  readonly players: readonly {
    readonly playerId: string;
    readonly displayName: string;
  }[];
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

/** 生成 1 回分の処理。Claude の呼び出しまでを行い、保存（追記）は返り値の関数で行う（終了中なら保存しない）。 */
type GenerationWork = (
  signalFor: () => AbortSignal,
) => Promise<() => Record<string, unknown>>;

export class ReviewService {
  private readonly generations = new Map<string, ReviewGeneration>();
  /** 生成は 1 つずつ順に進める（前の生成の終わりに次をつなぐ）。 */
  private queue: Promise<void> = Promise.resolve();
  /** アプリの終了で、進行中の Claude・Solver の子プロセスを止める。 */
  private readonly closing = new AbortController();

  constructor(private readonly deps: ReviewServiceDeps) {}

  /** その判断の Pass A の Review の状態（最新の Version と生成の状態）。 */
  status(handId: string, decisionIndex: number): ReviewResult {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    return { ok: true, value: this.snapshot(handId, decisionIndex) };
  }

  /**
   * その判断の Pass A の Review の新しい Version の生成を始め、待ちの状態を返す。同じ判断を生成中なら、新しくは始めずに今の状態を返す。
   * 生成済みの判断でも、要求するたびに次の Version を作る（過去の Version は残る。D39）。
   */
  request(
    handId: string,
    decisionIndex: number,
    depth: ReviewDepth,
  ): ReviewResult {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    this.schedule(
      keyOf(handId, decisionIndex),
      depth,
      { handId, decisionIndex, pass: "decision" },
      (signalFor) =>
        this.generateDecision(
          handId,
          decisionIndex,
          depth,
          target.events,
          signalFor,
        ),
    );
    return { ok: true, value: this.snapshot(handId, decisionIndex) };
  }

  /** その判断の Pass A の、指定した Version の Review（#84。Version を選んで読む）。 */
  version(
    handId: string,
    decisionIndex: number,
    version: number,
  ): ServiceResult<ReviewRecord> {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    const record = this.deps.reviews
      .list(handId, decisionIndex, "decision")
      .find((r) => r.version === version);
    return record === undefined
      ? reviewNotFound(handId, decisionIndex, "decision", version)
      : { ok: true, value: record };
  }

  /** その判断の Pass B（Reveal Review）の状態。 */
  revealStatus(handId: string, decisionIndex: number): RevealResult {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    return { ok: true, value: this.revealSnapshot(handId, decisionIndex) };
  }

  /**
   * その判断の Pass B の新しい Version の生成を始め、待ちの状態を返す（Pass A と同じ作法）。
   * Pass A の Review は読みも書き換えもしない（docs/05 §7: Pass B の情報で Pass A を変えない）。
   */
  requestReveal(
    handId: string,
    decisionIndex: number,
    depth: ReviewDepth,
  ): RevealResult {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    this.schedule(
      revealKeyOf(handId, decisionIndex),
      depth,
      { handId, decisionIndex, pass: "reveal" },
      (signalFor) =>
        this.generateReveal(
          handId,
          decisionIndex,
          depth,
          target.events,
          signalFor,
        ),
    );
    return { ok: true, value: this.revealSnapshot(handId, decisionIndex) };
  }

  /** その判断の Pass B の、指定した Version（#84。Version を選んで読む）。 */
  revealVersion(
    handId: string,
    decisionIndex: number,
    version: number,
  ): ServiceResult<RevealReviewRecord> {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    const record = this.deps.reveals
      .list(handId, decisionIndex)
      .find((r) => r.version === version);
    return record === undefined
      ? reviewNotFound(handId, decisionIndex, "reveal", version)
      : { ok: true, value: record };
  }

  /** Pass と Version で指定した Review への Follow-up の状態（履歴の全ターン）。 */
  followUpStatus(
    handId: string,
    decisionIndex: number,
    pass: ReviewPass,
    version: number,
  ): FollowUpResult {
    const found = this.followUpTarget(handId, decisionIndex, pass, version);
    if (!found.ok) return found;
    return { ok: true, value: this.followUpSnapshot(found.value) };
  }

  /**
   * Pass と Version で指定した Review に質問し、答えの生成を始めて待ちの状態を返す。
   * 前の質問の答えを作っている間は受け付けない（質問を黙って捨てない）。答えはその Review の Evidence の範囲だけで作る。
   */
  askFollowUp(
    handId: string,
    decisionIndex: number,
    pass: ReviewPass,
    version: number,
    rawQuestion: string,
    depth: ReviewDepth,
  ): FollowUpResult {
    const found = this.followUpTarget(handId, decisionIndex, pass, version);
    if (!found.ok) return found;
    const target = found.value;
    const question = rawQuestion.trim();
    if (question === "") {
      return error("invalid_question", "質問が空");
    }
    const key = followUpKeyOf(target.reviewId);
    if (this.generations.get(key)?.state === "pending") {
      return error(
        "followup_in_progress",
        `前の質問の答えを作っている: ${target.reviewId}`,
      );
    }
    if (
      this.deps.followUps.list(target.reviewId).length >= FOLLOWUP_MAX_TURNS
    ) {
      return error(
        "followup_limit",
        `Follow-up は 1 つの Review の Version につき ${FOLLOWUP_MAX_TURNS} ターンまで`,
      );
    }
    this.schedule(
      key,
      depth,
      { handId, decisionIndex, pass, version },
      (signalFor) =>
        this.generateFollowUpTurn(target, question, depth, signalFor),
    );
    return { ok: true, value: this.followUpSnapshot(target) };
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
    const records = this.deps.reviews.list(handId, decisionIndex, "decision");
    return {
      handId,
      decisionIndex,
      generation: this.generationOf(keyOf(handId, decisionIndex)),
      latest: records.at(-1) ?? null,
      versions: records.length,
    };
  }

  private revealSnapshot(handId: string, decisionIndex: number): RevealStatus {
    const records = this.deps.reveals.list(handId, decisionIndex);
    return {
      handId,
      decisionIndex,
      generation: this.generationOf(revealKeyOf(handId, decisionIndex)),
      latest: records.at(-1) ?? null,
      versions: records.length,
    };
  }

  private followUpSnapshot(target: FollowUpTarget): FollowUpStatus {
    return {
      handId: target.handId,
      decisionIndex: target.decisionIndex,
      pass: target.pass,
      version: target.version,
      reviewId: target.reviewId,
      generation: this.generationOf(followUpKeyOf(target.reviewId)),
      turns: this.deps.followUps.list(target.reviewId),
      maxTurns: FOLLOWUP_MAX_TURNS,
    };
  }

  private generationOf(key: string): ReviewGeneration {
    return this.generations.get(key) ?? { state: "idle" };
  }

  /** Review を作れる判断か（保存済みで終わった Hand の、Hero の判断）。 */
  private target(
    handId: string,
    decisionIndex: number,
  ):
    | { readonly ok: false; readonly error: ReviewServiceError }
    | { readonly ok: true; readonly events: readonly HandEvent[] } {
    const events = this.deps.events.read(handId).map((s) => s.event);
    if (events.length === 0) {
      return error("hand_not_found", `Hand が無い: ${handId}`);
    }
    // Review は終わった Hand だけ（docs/03 §4: Hand Finished → Review 可能）。打ち切った Hand（D95）の判断も対象にする。
    if (!events.some(isHandEnd)) {
      return error("hand_not_finished", `Hand が終わっていない: ${handId}`);
    }
    const decisions = heroInformationSets(events, this.deps.heroId);
    if (decisions[decisionIndex] === undefined) {
      return error(
        "decision_not_found",
        `Hero の判断が無い: ${handId} の ${decisionIndex}`,
      );
    }
    return { ok: true, events };
  }

  /** Follow-up の対象（Pass と Version で指定した保存済みの Review）。 */
  private followUpTarget(
    handId: string,
    decisionIndex: number,
    pass: ReviewPass,
    version: number,
  ): ServiceResult<FollowUpTarget> {
    const target = this.target(handId, decisionIndex);
    if (!target.ok) return target;
    const notFound = reviewNotFound(handId, decisionIndex, pass, version);
    if (pass === "decision") {
      const record = this.deps.reviews
        .list(handId, decisionIndex, "decision")
        .find((r) => r.version === version);
      if (record === undefined) return notFound;
      return {
        ok: true,
        value: {
          pass,
          reviewId: record.reviewId,
          handId,
          decisionIndex,
          version,
          evidence: record.evidence,
          explanation: record.explanation,
        },
      };
    }
    const record = this.deps.reveals
      .list(handId, decisionIndex)
      .find((r) => r.version === version);
    if (record === undefined) return notFound;
    return {
      ok: true,
      value: {
        pass,
        reviewId: record.reviewId,
        handId,
        decisionIndex,
        version,
        evidence: record.evidence,
        explanation: record.explanation,
      },
    };
  }

  /** 生成を待ち行列へ足す。同じ対象を生成中・アプリの終了後は何もしない。 */
  private schedule(
    key: string,
    depth: ReviewDepth,
    context: Record<string, unknown>,
    work: GenerationWork,
  ): void {
    if (
      this.generations.get(key)?.state === "pending" ||
      this.closing.signal.aborted
    ) {
      return;
    }
    this.generations.set(key, { state: "pending", depth });
    const run = () => this.execute(key, depth, context, work);
    this.queue = this.queue.then(run, run);
  }

  /** 生成 1 回分。上限の時間・アプリの終了で止め、Claude の失敗は種類だけを状態に残す（本文はログにだけ）。 */
  private async execute(
    key: string,
    depth: ReviewDepth,
    context: Record<string, unknown>,
    work: GenerationWork,
  ): Promise<void> {
    const log = this.deps.logger;
    if (this.closing.signal.aborted) return;
    let timeout: AbortSignal | undefined;
    const started = performance.now();
    try {
      const save = await work(() => {
        // 呼び出しごとに上限を掛け直す（Retry の 2 回目にも同じ上限）。
        timeout = AbortSignal.timeout(this.deps.timeoutMs);
        return AbortSignal.any([this.closing.signal, timeout]);
      });
      if (this.closing.signal.aborted) return;
      const saved = save();
      this.generations.delete(key);
      log?.info(
        { ...context, ...saved, ms: Math.round(performance.now() - started) },
        "Review を保存した",
      );
    } catch (err) {
      if (this.closing.signal.aborted) return;
      const kind: ReviewFailureKind =
        timeout?.aborted === true
          ? "timeout"
          : err instanceof ClaudeCallError
            ? err.failureKind
            : "error";
      // 本文はログにだけ残す（Hero への応答には種類だけ）。
      log?.error({ ...context, kind, err }, "Review の生成に失敗");
      this.generations.set(key, { state: "failed", depth, kind });
    }
  }

  private invalidOutputLogger(context: Record<string, unknown>) {
    return ({
      check,
    }: {
      readonly check:
        | { readonly ok: true }
        | {
            readonly ok: false;
            readonly stage: string;
            readonly reason: string;
          };
    }) => {
      if (!check.ok) {
        this.deps.logger?.warn(
          { ...context, stage: check.stage, reason: check.reason },
          "Review AI の出力が不正",
        );
      }
    };
  }

  private async generateDecision(
    handId: string,
    decisionIndex: number,
    depth: ReviewDepth,
    events: readonly HandEvent[],
    signalFor: () => AbortSignal,
  ): Promise<() => Record<string, unknown>> {
    const sets = heroInformationSets(events, this.deps.heroId);
    const set = sets[decisionIndex];
    if (set === undefined) throw new Error("判断が無い");
    const reasons =
      extractImportantSpots(sets).find((s) => s.decisionIndex === decisionIndex)
        ?.reasons ?? [];
    const evidence = await buildReviewEvidence(set, reasons, {
      playerNames: toPlayerNames(this.deps.players),
      kb: this.deps.kb,
      solver: this.deps.solver,
      tableTendency: this.heroTableTendencyBefore(handId),
      signal: this.closing.signal,
      onSolverFailure: (err) =>
        this.deps.logger?.warn(
          { handId, decisionIndex, err },
          "Solver の失敗（Math・Range・KB へ Fallback）",
        ),
    });
    const draft = await generateReview(evidence, {
      depth,
      actionSeq: set.decision.actionSeq,
      env: this.deps.env,
      query: this.deps.query,
      signalFor,
      onAttempt: this.invalidOutputLogger({
        handId,
        decisionIndex,
        pass: "decision",
      }),
    });
    return () => {
      const record = this.deps.reviews.append(draft);
      return {
        version: record.version,
        generatedBy: record.generatedBy,
        assessment: record.assessment,
      };
    };
  }

  /**
   * 判断時点の Hero の Table Tendency（D122・#153）。判断の Hand と同じ Session の、その Hand より前（論理順序。D117）に保存した Hand の
   * public の Event だけから作る（その Hand 自身・後の Hand は入らない。判断より後の情報を混ぜない）。
   * Review の対象は終わった Hand だけ（target）なので、Session と論理順序の番号は必ずある。
   */
  private heroTableTendencyBefore(handId: string): TableTendency {
    const store = this.deps.events;
    const sessionId = store.sessionIdOfHand(handId);
    const ord = store.savedOrder(handId);
    if (sessionId === null || ord === null) {
      throw new Error(
        `終わった Hand ${handId} の Session か論理順序の番号が無い`,
      );
    }
    return buildHeroTableTendencyFromStore(store, {
      sessionId,
      heroPlayerId: this.deps.heroId,
      beforeOrd: ord,
    });
  }

  private async generateReveal(
    handId: string,
    decisionIndex: number,
    depth: ReviewDepth,
    events: readonly HandEvent[],
    signalFor: () => AbortSignal,
  ): Promise<() => Record<string, unknown>> {
    const sets = heroInformationSets(events, this.deps.heroId);
    const set = sets[decisionIndex];
    if (set === undefined) throw new Error("判断が無い");
    // Learning-only Full Reveal は Hand が終わった後だけ値を持つ（target で終わった Hand に限っている）。
    const reveal = projectLearningReveal(events);
    if (reveal === null) throw new Error("Hand が終わっていない");
    const reasons =
      extractImportantSpots(sets).find((s) => s.decisionIndex === decisionIndex)
        ?.reasons ?? [];
    const evidence = await buildRevealEvidence(
      set,
      reveal,
      events,
      reasons,
      toPlayerNames(this.deps.players),
    );
    const draft = await generateRevealReview(evidence, {
      depth,
      actionSeq: set.decision.actionSeq,
      env: this.deps.env,
      query: this.deps.query,
      signalFor,
      onAttempt: this.invalidOutputLogger({
        handId,
        decisionIndex,
        pass: "reveal",
      }),
    });
    return () => {
      const record = this.deps.reveals.append(draft);
      return { version: record.version, generatedBy: record.generatedBy };
    };
  }

  private async generateFollowUpTurn(
    target: FollowUpTarget,
    question: string,
    depth: ReviewDepth,
    signalFor: () => AbortSignal,
  ): Promise<() => Record<string, unknown>> {
    // 履歴はその Review の Version に紐づくターンだけ（別の Version・別の Pass の会話は混ぜない）。
    const history = this.deps.followUps.list(target.reviewId);
    const draft = await generateFollowUp(target, history, question, {
      depth,
      env: this.deps.env,
      query: this.deps.query,
      signalFor,
      onAttempt: this.invalidOutputLogger({
        reviewId: target.reviewId,
        pass: target.pass,
      }),
    });
    return () => {
      const record = this.deps.followUps.append(draft);
      return {
        reviewId: record.reviewId,
        turn: record.turn,
        generatedBy: record.generatedBy,
        scope: record.answer.scope,
      };
    };
  }
}

function error(
  kind: ReviewServiceError["kind"],
  message: string,
): { readonly ok: false; readonly error: ReviewServiceError } {
  return { ok: false, error: { kind, message } };
}

function reviewNotFound(
  handId: string,
  decisionIndex: number,
  pass: ReviewPass,
  version: number,
): { readonly ok: false; readonly error: ReviewServiceError } {
  return error(
    "review_not_found",
    `Review が無い: ${handId} の ${decisionIndex}（${pass}・Version ${version}）`,
  );
}

function keyOf(handId: string, decisionIndex: number): string {
  return `${handId}#${decisionIndex}`;
}

function revealKeyOf(handId: string, decisionIndex: number): string {
  return `${handId}#${decisionIndex}#reveal`;
}

function followUpKeyOf(reviewId: string): string {
  return `followup#${reviewId}`;
}
