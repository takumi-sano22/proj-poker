// Targeted Drill の記録（D105・D116・#117）。マイグレーション v7 の追記型の drills テーブルに、元の Hand・判断・Pass A の Review の id
// （provenance）・変形・seed・Policy の Version・Drill の Hand の id を残す。行は書き換えず消さない（UPDATE / DELETE は Trigger で拒否する）。
// Drill の Hand そのものは Event Log（正本）に通常の Hand として残り、このテーブルは通常の Play と区別するためだけに使う
// （Stats・Score・Profile・Hypothesis・Resume・Replay の一覧の集計から drillHandIds を除く。D116）。
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { DrillVariant } from "./drill-plan.js";

export interface DrillRecord {
  readonly drillId: string;
  /** ISO 8601（UTC）。 */
  readonly createdAt: string;
  readonly sourceHandId: string;
  readonly sourceDecisionIndex: number;
  /** 元の判断の Pass A の Review（Drill を作った時点の最新の Version）。 */
  readonly sourceReviewId: string;
  readonly variant: DrillVariant;
  readonly policyVersion: string;
  readonly seed: number;
  readonly drillHandId: string;
}

export type NewDrillRecord = Omit<DrillRecord, "drillId" | "createdAt">;

export interface DrillStore {
  /** Drill を 1 行足す（Drill の Hand を始める前に呼ぶ）。 */
  add(record: NewDrillRecord): DrillRecord;
  /** すべての Drill（足した順）。 */
  list(): readonly DrillRecord[];
  /** Drill の Hand の id から Drill を引く。Drill の Hand でなければ null。 */
  byDrillHandId(handId: string): DrillRecord | null;
  /** Drill の Hand の id の集合（通常の集計から除く。D116）。 */
  drillHandIds(): ReadonlySet<string>;
}

export interface DrillStoreOptions {
  readonly now?: () => Date;
  readonly newDrillId?: () => string;
}

/** プロセス内のメモリだけに持つ実装（テスト用。再起動で消える）。 */
export class InMemoryDrillStore implements DrillStore {
  private readonly rows: DrillRecord[] = [];
  private readonly now: () => Date;
  private readonly newDrillId: () => string;

  constructor(options: DrillStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newDrillId = options.newDrillId ?? randomUUID;
  }

  add(record: NewDrillRecord): DrillRecord {
    if (this.rows.some((r) => r.drillHandId === record.drillHandId)) {
      throw new RangeError(`Drill の Hand が重複した: ${record.drillHandId}`);
    }
    const row: DrillRecord = {
      ...record,
      drillId: this.newDrillId(),
      createdAt: this.now().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  list(): readonly DrillRecord[] {
    return [...this.rows];
  }

  byDrillHandId(handId: string): DrillRecord | null {
    return this.rows.find((r) => r.drillHandId === handId) ?? null;
  }

  drillHandIds(): ReadonlySet<string> {
    return new Set(this.rows.map((r) => r.drillHandId));
  }
}

interface DrillRow {
  drill_id: string;
  created_at: string;
  source_hand_id: string;
  source_decision_index: number;
  source_review_id: string;
  variant: string;
  policy_version: string;
  seed: number;
  drill_hand_id: string;
}

const COLUMNS =
  "drill_id, created_at, source_hand_id, source_decision_index, source_review_id, variant_kind, variant, policy_version, seed, drill_hand_id";

/** SQLite の実装（v7 の drills。DB は Event Store と共有する）。 */
export class SqliteDrillStore implements DrillStore {
  private readonly insert: StatementSync;
  private readonly selectAll: StatementSync;
  private readonly selectByHand: StatementSync;
  private readonly now: () => Date;
  private readonly newDrillId: () => string;

  constructor(db: DatabaseSync, options: DrillStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newDrillId = options.newDrillId ?? randomUUID;
    this.insert = db.prepare(
      `INSERT INTO drills (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 足した順（rowid）。
    this.selectAll = db.prepare(`SELECT ${COLUMNS} FROM drills ORDER BY rowid`);
    this.selectByHand = db.prepare(
      `SELECT ${COLUMNS} FROM drills WHERE drill_hand_id = ?`,
    );
  }

  add(record: NewDrillRecord): DrillRecord {
    const row: DrillRecord = {
      ...record,
      drillId: this.newDrillId(),
      createdAt: this.now().toISOString(),
    };
    this.insert.run(
      row.drillId,
      row.createdAt,
      row.sourceHandId,
      row.sourceDecisionIndex,
      row.sourceReviewId,
      row.variant.kind,
      JSON.stringify(row.variant),
      row.policyVersion,
      row.seed,
      row.drillHandId,
    );
    return row;
  }

  list(): readonly DrillRecord[] {
    return (this.selectAll.all() as unknown as DrillRow[]).map(toRecord);
  }

  byDrillHandId(handId: string): DrillRecord | null {
    const row = this.selectByHand.get(handId) as unknown as
      DrillRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  drillHandIds(): ReadonlySet<string> {
    return new Set(this.list().map((r) => r.drillHandId));
  }
}

function toRecord(row: DrillRow): DrillRecord {
  return {
    drillId: row.drill_id,
    createdAt: row.created_at,
    sourceHandId: row.source_hand_id,
    sourceDecisionIndex: row.source_decision_index,
    sourceReviewId: row.source_review_id,
    variant: JSON.parse(row.variant) as DrillVariant,
    policyVersion: row.policy_version,
    seed: row.seed,
    drillHandId: row.drill_hand_id,
  };
}
