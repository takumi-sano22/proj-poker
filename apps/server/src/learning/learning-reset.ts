// Learning Reset（docs/04 §11・D64・D114・#118）。Reset は行の削除ではなく、マイグレーション v8 の追記型の learning_resets に
// 区切りの行（Reset の時刻・対象カテゴリ）を足す。Event Log・reviews 等の正本は消さず、削除拒否の Trigger も外さない。
// - カテゴリは D114 の 3 つ（Ability Score・Weakness Hypothesis・自然言語の Player Profile）。Stats は対象に無いので Reset で変えない
// - 区切りの判定（決定論）: Hand の終わりの Event（HAND_FINISHED / HAND_ABORTED）の記録時刻が、そのカテゴリの最後の Reset の時刻より
//   後（同じ時刻は含めない）の Hand だけを、そのカテゴリの Evidence にする。Review の作成時刻では切らない（Reset 前の Hand を Reset 後に
//   Review しても、Reset 前の Evidence のまま。M 件中 N 件の M も同じ Hand で数える）
// - User Read / Note / Tag はどのカテゴリでも消さない（D114）。Opponent Memory Reset（Phase 7・P7-8）はこのテーブルに入れない
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { inTransaction } from "../db/database.js";
import { isHandEnd, type StoredHandEvent } from "../event-store.js";

/** Learning Reset の対象カテゴリ（D114）。並びは画面と応答の順。 */
export const LEARNING_RESET_CATEGORIES = [
  "score",
  "hypothesis",
  "profile",
] as const;

/**
 * - `score`: Ability / Overall Score（Player Profile の Recent / Long-term と M 件中 N 件、Drill の系列の Score〔暫定〕）
 * - `hypothesis`: Weakness Hypothesis（Snapshot〔v6〕も作り直す）
 * - `profile`: 自然言語の Player Profile（まとめの文）
 */
export type LearningResetCategory = (typeof LEARNING_RESET_CATEGORIES)[number];

/** カテゴリごとの最後の Reset の時刻（ISO 8601・UTC）。Reset していないカテゴリは null（全期間）。 */
export type ResetBoundaries = Readonly<
  Record<LearningResetCategory, string | null>
>;

export interface LearningResetRecord {
  readonly resetId: string;
  /** ISO 8601（UTC）。 */
  readonly createdAt: string;
  /** LEARNING_RESET_CATEGORIES の順。 */
  readonly categories: readonly LearningResetCategory[];
}

export interface LearningResetStore {
  /** 区切りを 1 つ足す（カテゴリは 1 つ以上・重複なし）。 */
  add(categories: readonly LearningResetCategory[]): LearningResetRecord;
  /** カテゴリごとの最後の Reset の時刻。 */
  boundaries(): ResetBoundaries;
}

export interface LearningResetStoreOptions {
  readonly now?: () => Date;
  readonly newResetId?: () => string;
}

/** カテゴリを LEARNING_RESET_CATEGORIES の順にそろえる。空・重複・未知のカテゴリは受け付けない。 */
function normalize(
  categories: readonly LearningResetCategory[],
): readonly LearningResetCategory[] {
  const set = new Set(categories);
  if (set.size === 0 || set.size !== categories.length) {
    throw new RangeError("Learning Reset のカテゴリは 1 つ以上・重複なし");
  }
  for (const c of set) {
    if (!LEARNING_RESET_CATEGORIES.includes(c)) {
      throw new RangeError(`Learning Reset のカテゴリではない: ${String(c)}`);
    }
  }
  return LEARNING_RESET_CATEGORIES.filter((c) => set.has(c));
}

function noBoundaries(): Record<LearningResetCategory, string | null> {
  return { score: null, hypothesis: null, profile: null };
}

/** 後の時刻を返す（記録順で時計が戻っても、区切りを前へ戻さない）。 */
function later(a: string | null, b: string): string {
  return a === null || Date.parse(b) > Date.parse(a) ? b : a;
}

/** プロセス内のメモリだけに持つ実装（テスト用。再起動で消える）。 */
export class InMemoryLearningResetStore implements LearningResetStore {
  private readonly rows: LearningResetRecord[] = [];
  private readonly now: () => Date;
  private readonly newResetId: () => string;

  constructor(options: LearningResetStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newResetId = options.newResetId ?? randomUUID;
  }

  add(categories: readonly LearningResetCategory[]): LearningResetRecord {
    const record: LearningResetRecord = {
      resetId: this.newResetId(),
      createdAt: this.now().toISOString(),
      categories: normalize(categories),
    };
    this.rows.push(record);
    return record;
  }

  boundaries(): ResetBoundaries {
    const result = noBoundaries();
    for (const row of this.rows) {
      for (const c of row.categories) {
        result[c] = later(result[c], row.createdAt);
      }
    }
    return result;
  }
}

/** SQLite の実装（v8 の learning_resets。DB は Event Store と共有する）。 */
export class SqliteLearningResetStore implements LearningResetStore {
  private readonly insert: StatementSync;
  private readonly selectAll: StatementSync;
  private readonly now: () => Date;
  private readonly newResetId: () => string;

  constructor(
    private readonly db: DatabaseSync,
    options: LearningResetStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newResetId = options.newResetId ?? randomUUID;
    this.insert = db.prepare(
      "INSERT INTO learning_resets (reset_id, created_at, category) VALUES (?, ?, ?)",
    );
    this.selectAll = db.prepare(
      "SELECT created_at, category FROM learning_resets ORDER BY seq",
    );
  }

  add(categories: readonly LearningResetCategory[]): LearningResetRecord {
    const record: LearningResetRecord = {
      resetId: this.newResetId(),
      createdAt: this.now().toISOString(),
      categories: normalize(categories),
    };
    // カテゴリごとの行を 1 トランザクションで足す（一部のカテゴリだけの区切りを残さない）。
    inTransaction(this.db, () => {
      for (const c of record.categories) {
        this.insert.run(record.resetId, record.createdAt, c);
      }
    });
    return record;
  }

  boundaries(): ResetBoundaries {
    const rows = this.selectAll.all() as unknown as {
      created_at: string;
      category: LearningResetCategory;
    }[];
    const result = noBoundaries();
    for (const row of rows) {
      result[row.category] = later(result[row.category], row.created_at);
    }
    return result;
  }
}

/** Hand の終わりの Event（HAND_FINISHED / HAND_ABORTED）の記録時刻。終わっていない Hand は null。 */
export function handEndedAt(stored: readonly StoredHandEvent[]): string | null {
  return stored.find((s) => isHandEnd(s.event))?.recordedAt ?? null;
}

/**
 * Hand が区切り（since）より後に終わったか。since が null（Reset していない）なら終わった Hand はすべて入る。
 * 同じ時刻は「後」に入れない（Reset と同時に終わった Hand は Reset 前として扱う）。
 */
export function endedAfter(
  stored: readonly StoredHandEvent[],
  since: string | null,
): boolean {
  const ended = handEndedAt(stored);
  if (ended === null) return false;
  return since === null || Date.parse(ended) > Date.parse(since);
}
