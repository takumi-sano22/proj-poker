// Reveal Review（Pass B）と Follow-up の履歴の Store（#83・docs/04 §8）。どちらも追記だけで、過去の行を上書きしない（D39）。
// 起動時は SQLite（reveal_reviews・review_followups テーブル。マイグレーション v4）、テストの既定はメモリ内実装を使う。
// Pass A の reviews テーブル（review-store.ts）は変えない。
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { inTransaction } from "../db/database.js";
import type {
  FollowUpDraft,
  FollowUpRecord,
  RevealReviewDraft,
  RevealReviewRecord,
} from "./reveal-types.js";
import type { ReviewStoreOptions } from "./review-store.js";

export interface RevealReviewStore {
  /** 次の Version を付けて追記する（同じ Hand・判断の最大 Version + 1）。 */
  append(draft: RevealReviewDraft): RevealReviewRecord;
  /** その判断の Pass B を Version の昇順で返す。無ければ空配列。 */
  list(handId: string, decisionIndex: number): RevealReviewRecord[];
}

export interface FollowUpStore {
  /** 次のターンの番号を付けて追記する（同じ Review の Version の最大ターン + 1）。 */
  append(draft: FollowUpDraft): FollowUpRecord;
  /** その Review の Version の Follow-up をターンの昇順で返す。無ければ空配列。 */
  list(reviewId: string): FollowUpRecord[];
}

/** Pass B のメモリ内実装（テスト用。再起動で消える）。 */
export class InMemoryRevealReviewStore implements RevealReviewStore {
  private readonly records: RevealReviewRecord[] = [];
  private readonly now: () => Date;
  private readonly newReviewId: () => string;

  constructor(options: ReviewStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newReviewId = options.newReviewId ?? randomUUID;
  }

  append(draft: RevealReviewDraft): RevealReviewRecord {
    const version = this.list(draft.handId, draft.decisionIndex).length + 1;
    // 呼び出し側が持つ値と切り離す（保存後に書き換えられない）。
    const record: RevealReviewRecord = structuredClone({
      ...draft,
      reviewId: this.newReviewId(),
      version,
      createdAt: this.now().toISOString(),
    });
    this.records.push(record);
    return structuredClone(record);
  }

  list(handId: string, decisionIndex: number): RevealReviewRecord[] {
    return this.records
      .filter((r) => r.handId === handId && r.decisionIndex === decisionIndex)
      .map((r) => structuredClone(r));
  }
}

/** Follow-up のメモリ内実装（テスト用。再起動で消える）。 */
export class InMemoryFollowUpStore implements FollowUpStore {
  private readonly records: FollowUpRecord[] = [];
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: ReviewStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newReviewId ?? randomUUID;
  }

  append(draft: FollowUpDraft): FollowUpRecord {
    const record: FollowUpRecord = structuredClone({
      ...draft,
      followupId: this.newId(),
      turn: this.list(draft.reviewId).length + 1,
      createdAt: this.now().toISOString(),
    });
    this.records.push(record);
    return structuredClone(record);
  }

  list(reviewId: string): FollowUpRecord[] {
    return this.records
      .filter((r) => r.reviewId === reviewId)
      .map((r) => structuredClone(r));
  }
}

interface RevealRow {
  review_id: string;
  hand_id: string;
  decision_index: number;
  action_seq: number;
  version: number;
  created_at: string;
  depth: RevealReviewRecord["depth"];
  model_role: RevealReviewRecord["modelRole"];
  concrete_model: string | null;
  generated_by: RevealReviewRecord["generatedBy"];
  evidence_ids: string;
  explanation: string;
  evidence: string;
  failure: string | null;
}

/** Pass B の SQLite の実装（DB は Event Store・reviews と共有する。DB を閉じるのは開いた側）。 */
export class SqliteRevealReviewStore implements RevealReviewStore {
  private readonly now: () => Date;
  private readonly newReviewId: () => string;
  private readonly nextVersion: StatementSync;
  private readonly insert: StatementSync;
  private readonly select: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    options: ReviewStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newReviewId = options.newReviewId ?? randomUUID;
    this.nextVersion = db.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM reveal_reviews WHERE hand_id = ? AND decision_index = ?",
    );
    this.insert = db.prepare(
      `INSERT INTO reveal_reviews (review_id, hand_id, decision_index, action_seq, version, created_at, depth, model_role,
        concrete_model, generated_by, evidence_ids, explanation, evidence, failure)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.select = db.prepare(
      "SELECT * FROM reveal_reviews WHERE hand_id = ? AND decision_index = ? ORDER BY version",
    );
  }

  append(draft: RevealReviewDraft): RevealReviewRecord {
    // Version の採番と追記を 1 つの書き込みトランザクション（BEGIN IMMEDIATE）で行い、一意制約でも二重の Version を拒否する（LC-022）。
    return inTransaction(this.db, () => {
      const row = this.nextVersion.get(draft.handId, draft.decisionIndex) as
        { version: number } | undefined;
      const record: RevealReviewRecord = {
        ...draft,
        reviewId: this.newReviewId(),
        version: row?.version ?? 1,
        createdAt: this.now().toISOString(),
      };
      this.insert.run(
        record.reviewId,
        record.handId,
        record.decisionIndex,
        record.actionSeq,
        record.version,
        record.createdAt,
        record.depth,
        record.modelRole,
        record.concreteModel,
        record.generatedBy,
        JSON.stringify(record.evidenceIds),
        JSON.stringify(record.explanation),
        JSON.stringify(record.evidence),
        record.failure === null ? null : JSON.stringify(record.failure),
      );
      return structuredClone(record);
    });
  }

  list(handId: string, decisionIndex: number): RevealReviewRecord[] {
    const rows = this.select.all(
      handId,
      decisionIndex,
    ) as unknown as RevealRow[];
    return rows.map((row) => ({
      reviewId: row.review_id,
      handId: row.hand_id,
      decisionIndex: row.decision_index,
      actionSeq: row.action_seq,
      pass: "reveal",
      version: row.version,
      createdAt: row.created_at,
      depth: row.depth,
      modelRole: row.model_role,
      concreteModel: row.concrete_model,
      generatedBy: row.generated_by,
      evidenceIds: JSON.parse(
        row.evidence_ids,
      ) as RevealReviewRecord["evidenceIds"],
      explanation: JSON.parse(
        row.explanation,
      ) as RevealReviewRecord["explanation"],
      evidence: JSON.parse(row.evidence) as RevealReviewRecord["evidence"],
      failure:
        row.failure === null
          ? null
          : (JSON.parse(row.failure) as RevealReviewRecord["failure"]),
    }));
  }
}

interface FollowUpRow {
  followup_id: string;
  pass: FollowUpRecord["pass"];
  review_id: string;
  hand_id: string;
  decision_index: number;
  review_version: number;
  turn: number;
  created_at: string;
  depth: FollowUpRecord["depth"];
  model_role: FollowUpRecord["modelRole"];
  concrete_model: string;
  generated_by: FollowUpRecord["generatedBy"];
  question: string;
  answer: string;
  failure: string | null;
}

/** Follow-up の SQLite の実装。指す Review の Version が実在しない行は Trigger（review_followups_target）が拒否する。 */
export class SqliteFollowUpStore implements FollowUpStore {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly nextTurn: StatementSync;
  private readonly insert: StatementSync;
  private readonly select: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    options: ReviewStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newReviewId ?? randomUUID;
    this.nextTurn = db.prepare(
      "SELECT COALESCE(MAX(turn), 0) + 1 AS turn FROM review_followups WHERE review_id = ?",
    );
    this.insert = db.prepare(
      `INSERT INTO review_followups (followup_id, pass, review_id, hand_id, decision_index, review_version, turn, created_at,
        depth, model_role, concrete_model, generated_by, question, answer, failure)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.select = db.prepare(
      "SELECT * FROM review_followups WHERE review_id = ? ORDER BY turn",
    );
  }

  append(draft: FollowUpDraft): FollowUpRecord {
    // ターンの採番と追記を 1 つの書き込みトランザクションで行い、一意制約でも二重のターンを拒否する（LC-022）。
    return inTransaction(this.db, () => {
      const row = this.nextTurn.get(draft.reviewId) as
        { turn: number } | undefined;
      const record: FollowUpRecord = {
        ...draft,
        followupId: this.newId(),
        turn: row?.turn ?? 1,
        createdAt: this.now().toISOString(),
      };
      this.insert.run(
        record.followupId,
        record.pass,
        record.reviewId,
        record.handId,
        record.decisionIndex,
        record.reviewVersion,
        record.turn,
        record.createdAt,
        record.depth,
        record.modelRole,
        record.concreteModel,
        record.generatedBy,
        record.question,
        JSON.stringify(record.answer),
        record.failure === null ? null : JSON.stringify(record.failure),
      );
      return structuredClone(record);
    });
  }

  list(reviewId: string): FollowUpRecord[] {
    const rows = this.select.all(reviewId) as unknown as FollowUpRow[];
    return rows.map((row) => ({
      followupId: row.followup_id,
      pass: row.pass,
      reviewId: row.review_id,
      handId: row.hand_id,
      decisionIndex: row.decision_index,
      reviewVersion: row.review_version,
      turn: row.turn,
      createdAt: row.created_at,
      depth: row.depth,
      modelRole: row.model_role,
      concreteModel: row.concrete_model,
      generatedBy: row.generated_by,
      question: row.question,
      answer: JSON.parse(row.answer) as FollowUpRecord["answer"],
      failure:
        row.failure === null
          ? null
          : (JSON.parse(row.failure) as FollowUpRecord["failure"]),
    }));
  }
}
