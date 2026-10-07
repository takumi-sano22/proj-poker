// Weakness Hypothesis の Snapshot（D104・D113・マイグレーション v6 の hypothesis_snapshots）。
// reviews（Pass A）から buildHypotheses で決定論で作り直せる派生データで、正本にしない。作り直しは全行を消して入れ直す
// （1 トランザクション。途中まで書いた状態を残さない）。Player Profile の API（#116。learning-service.ts）が読むたびに作り直す。
// Learning Reset（D114・#118）の後は、LearningService が hypothesis の区切りより後に終わった Hand の Evidence で作り直す。
import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "../db/database.js";
import type { ScoreSource } from "./ability-evidence.js";
import {
  buildHypotheses,
  type Hypothesis,
  type HypothesisOptions,
} from "./hypothesis.js";
import type { HypothesisStatus, HypothesisType } from "./hypothesis-policy.js";

/** Snapshot の 1 行。computedAt は作り直した時刻（ISO 8601・UTC）。 */
export interface HypothesisSnapshot extends Hypothesis {
  readonly computedAt: string;
}

export interface RebuildOptions extends HypothesisOptions {
  readonly now?: () => Date;
}

/** reviews から Hypothesis を作り直し、Snapshot を入れ替える。入れた Snapshot を返す。 */
export function rebuildHypothesisSnapshot(
  db: DatabaseSync,
  source: ScoreSource,
  options: RebuildOptions = {},
): readonly HypothesisSnapshot[] {
  const hypotheses = buildHypotheses(source, options);
  const computedAt = (options.now ?? (() => new Date()))().toISOString();
  writeHypothesisSnapshot(db, hypotheses, computedAt);
  return hypotheses.map((h) => ({ ...h, computedAt }));
}

/** Snapshot を全行入れ替える（派生データなので消してよい。D113）。 */
export function writeHypothesisSnapshot(
  db: DatabaseSync,
  hypotheses: readonly Hypothesis[],
  computedAt: string,
): void {
  inTransaction(db, () => {
    db.exec("DELETE FROM hypothesis_snapshots");
    const insert = db.prepare(
      `INSERT INTO hypothesis_snapshots
         (hypothesis_id, policy_version, type, status, supporting_evidence_ids, counter_evidence_ids, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const h of hypotheses) {
      insert.run(
        h.hypothesisId,
        h.policyVersion,
        h.type,
        h.status,
        JSON.stringify(h.supportingEvidenceIds),
        JSON.stringify(h.counterEvidenceIds),
        computedAt,
      );
    }
  });
}

interface SnapshotRow {
  readonly hypothesis_id: string;
  readonly policy_version: string;
  readonly type: string;
  readonly status: string;
  readonly supporting_evidence_ids: string;
  readonly counter_evidence_ids: string;
  readonly computed_at: string;
}

/** Snapshot を入れた順（Policy の type の順）に読む。 */
export function readHypothesisSnapshot(
  db: DatabaseSync,
): readonly HypothesisSnapshot[] {
  const rows = db
    .prepare(
      `SELECT hypothesis_id, policy_version, type, status, supporting_evidence_ids, counter_evidence_ids, computed_at
       FROM hypothesis_snapshots ORDER BY rowid`,
    )
    .all() as unknown as SnapshotRow[];
  return rows.map((r) => ({
    hypothesisId: r.hypothesis_id,
    // type は Policy の Version ごとの一覧（CHECK で固定しない）。読む側は policyVersion と一緒に扱う。
    type: r.type as HypothesisType,
    status: r.status as HypothesisStatus,
    supportingEvidenceIds: JSON.parse(r.supporting_evidence_ids) as string[],
    counterEvidenceIds: JSON.parse(r.counter_evidence_ids) as string[],
    policyVersion: r.policy_version,
    computedAt: r.computed_at,
  }));
}

/** Snapshot の入れ替え口（#116: Player Profile の API が使う）。起動時は SQLite、テストはメモリ内の実装を渡す。 */
export interface HypothesisSnapshotStore {
  /** Hypothesis で Snapshot を全行入れ替え、入れた行（Policy の type の順）を返す。 */
  replace(
    hypotheses: readonly Hypothesis[],
    computedAt: string,
  ): readonly HypothesisSnapshot[];
}

/** SQLite（マイグレーション v6 の hypothesis_snapshots）の Snapshot。 */
export class SqliteHypothesisSnapshotStore implements HypothesisSnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  replace(
    hypotheses: readonly Hypothesis[],
    computedAt: string,
  ): readonly HypothesisSnapshot[] {
    writeHypothesisSnapshot(this.db, hypotheses, computedAt);
    return readHypothesisSnapshot(this.db);
  }
}

/** プロセス内のメモリだけに持つ Snapshot（テスト用）。 */
export class InMemoryHypothesisSnapshotStore implements HypothesisSnapshotStore {
  private rows: readonly HypothesisSnapshot[] = [];

  replace(
    hypotheses: readonly Hypothesis[],
    computedAt: string,
  ): readonly HypothesisSnapshot[] {
    this.rows = hypotheses.map((h) => ({ ...h, computedAt }));
    return this.rows;
  }
}
