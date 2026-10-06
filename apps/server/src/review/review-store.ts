// Review Version Store（docs/03 §2・docs/04 §8）。Review は判断ごとに Version 付きで追記し、過去の Review を上書きしない（D39）。
// 起動時は SQLite（reviews テーブル。マイグレーション v3・D95）、テストの既定はメモリ内実装を使う。
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { inTransaction } from "../db/database.js";
import type { ReviewDraft, ReviewPass, ReviewRecord } from "./types.js";

export interface ReviewStore {
  /** 次の Version を付けて追記する（同じ Hand・判断・Pass の最大 Version + 1）。 */
  append(draft: ReviewDraft): ReviewRecord;
  /** その判断の Review を Version の昇順で返す。無ければ空配列。 */
  list(handId: string, decisionIndex: number, pass: ReviewPass): ReviewRecord[];
}

export interface ReviewStoreOptions {
  readonly now?: () => Date;
  readonly newReviewId?: () => string;
}

/** プロセス内のメモリだけに持つ実装（テスト用。再起動で消える）。 */
export class InMemoryReviewStore implements ReviewStore {
  private readonly records: ReviewRecord[] = [];
  private readonly now: () => Date;
  private readonly newReviewId: () => string;

  constructor(options: ReviewStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newReviewId = options.newReviewId ?? randomUUID;
  }

  append(draft: ReviewDraft): ReviewRecord {
    const version =
      this.list(draft.handId, draft.decisionIndex, draft.pass).length + 1;
    // 呼び出し側が持つ値と切り離す（保存後に書き換えられない）。
    const record: ReviewRecord = structuredClone({
      ...draft,
      reviewId: this.newReviewId(),
      version,
      createdAt: this.now().toISOString(),
    });
    this.records.push(record);
    return structuredClone(record);
  }

  list(
    handId: string,
    decisionIndex: number,
    pass: ReviewPass,
  ): ReviewRecord[] {
    return this.records
      .filter(
        (r) =>
          r.handId === handId &&
          r.decisionIndex === decisionIndex &&
          r.pass === pass,
      )
      .map((r) => structuredClone(r));
  }
}

interface ReviewRow {
  review_id: string;
  hand_id: string;
  decision_index: number;
  action_seq: number;
  pass: ReviewPass;
  version: number;
  created_at: string;
  depth: ReviewRecord["depth"];
  model_role: ReviewRecord["modelRole"];
  concrete_model: string | null;
  kb_version: string;
  solver_version: string | null;
  generated_by: ReviewRecord["generatedBy"];
  assessment: ReviewRecord["assessment"];
  confidence: ReviewRecord["confidence"];
  assumptions: string;
  evidence_ids: string;
  explanation: string;
  evidence: string;
  failure: string | null;
}

/**
 * SQLite の実装。DB は Event Store と共有する（reviews.hand_id は hands を参照する。Review を作れるのは保存済みの Hand だけ）。
 * DB を閉じるのは DB を開いた側（index.ts）。
 */
export class SqliteReviewStore implements ReviewStore {
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
      "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM reviews WHERE hand_id = ? AND decision_index = ? AND pass = ?",
    );
    this.insert = db.prepare(
      `INSERT INTO reviews (review_id, hand_id, decision_index, action_seq, pass, version, created_at, depth, model_role,
        concrete_model, kb_version, solver_version, generated_by, assessment, confidence, assumptions, evidence_ids,
        explanation, evidence, failure)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.select = db.prepare(
      "SELECT * FROM reviews WHERE hand_id = ? AND decision_index = ? AND pass = ? ORDER BY version",
    );
  }

  append(draft: ReviewDraft): ReviewRecord {
    // Version の採番と追記を 1 つの書き込みトランザクション（BEGIN IMMEDIATE）で行い、一意制約でも二重の Version を拒否する（LC-022）。
    return inTransaction(this.db, () => {
      const row = this.nextVersion.get(
        draft.handId,
        draft.decisionIndex,
        draft.pass,
      ) as { version: number } | undefined;
      const record: ReviewRecord = {
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
        record.pass,
        record.version,
        record.createdAt,
        record.depth,
        record.modelRole,
        record.concreteModel,
        record.kbVersion,
        record.solverVersion,
        record.generatedBy,
        record.assessment,
        record.confidence,
        JSON.stringify(record.assumptions),
        JSON.stringify(record.evidenceIds),
        JSON.stringify(record.explanation),
        JSON.stringify(record.evidence),
        record.failure === null ? null : JSON.stringify(record.failure),
      );
      return structuredClone(record);
    });
  }

  list(
    handId: string,
    decisionIndex: number,
    pass: ReviewPass,
  ): ReviewRecord[] {
    const rows = this.select.all(
      handId,
      decisionIndex,
      pass,
    ) as unknown as ReviewRow[];
    return rows.map(toRecord);
  }
}

function toRecord(row: ReviewRow): ReviewRecord {
  return {
    reviewId: row.review_id,
    handId: row.hand_id,
    decisionIndex: row.decision_index,
    actionSeq: row.action_seq,
    pass: row.pass,
    version: row.version,
    createdAt: row.created_at,
    depth: row.depth,
    modelRole: row.model_role,
    concreteModel: row.concrete_model,
    kbVersion: row.kb_version,
    solverVersion: row.solver_version,
    generatedBy: row.generated_by,
    assessment: row.assessment,
    confidence: row.confidence,
    assumptions: JSON.parse(row.assumptions) as ReviewRecord["assumptions"],
    evidenceIds: JSON.parse(row.evidence_ids) as ReviewRecord["evidenceIds"],
    explanation: JSON.parse(row.explanation) as ReviewRecord["explanation"],
    evidence: JSON.parse(row.evidence) as ReviewRecord["evidence"],
    failure:
      row.failure === null
        ? null
        : (JSON.parse(row.failure) as ReviewRecord["failure"]),
  };
}
