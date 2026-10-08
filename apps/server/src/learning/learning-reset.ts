// Learning Reset（docs/04 §11・D64・D114・#118）。Reset は行の削除ではなく、マイグレーション v8 の追記型の learning_resets に
// 区切りの行（Reset の時刻・対象カテゴリ）を足す。Event Log・reviews 等の正本は消さず、削除拒否の Trigger も外さない。
// - カテゴリは D114 の 3 つ（Ability Score・Weakness Hypothesis・自然言語の Player Profile）。Stats は対象に無いので Reset で変えない
// - 区切りの判定（決定論・D117）: Hand の保存（Hand の終わり）の論理順序の番号が、そのカテゴリの最後の Reset の番号より大きい Hand だけを、
//   そのカテゴリの Evidence にする。最後の Reset はカテゴリごとに learning_resets.seq が最大の行。壁時計（Hand の終わりの記録時刻・
//   Reset の created_at）では比べない（OS の時刻は後ろへ戻ることがある。#130）。Review の作成の順では切らない（Reset 前の Hand を
//   Reset 後に Review しても、Reset 前の Evidence のまま。M 件中 N 件の M も同じ Hand で数える）
// - Reset の番号は追加と同じトランザクションで ordinals（v9）に足す。Event Store の Hand の番号と同じ順序の源（同じ DB、またはメモリ内の
//   同じカウンタ）を使う
// - User Read / Note / Tag はどのカテゴリでも消さない（D114）。Opponent Memory Reset（Phase 7・P7-8）はこのテーブルに入れない
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { inTransaction } from "../db/database.js";
import {
  MissingOrdinalError,
  processOrdinals,
  type OrdinalCounter,
} from "../logical-order.js";

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

/** 1 つのカテゴリの最後の Reset。ord は論理順序の番号（区切りの判定に使う）、createdAt は表示用の時刻（ISO 8601・UTC）。 */
export interface ResetBoundary {
  readonly ord: number;
  readonly createdAt: string;
}

/** カテゴリごとの最後の Reset。Reset していないカテゴリは null（全期間）。 */
export type ResetBoundaries = Readonly<
  Record<LearningResetCategory, ResetBoundary | null>
>;

/** API の応答の形: カテゴリごとの最後の Reset の時刻（表示用。区切りの判定には使わない）。Reset していないカテゴリは null。 */
export type ResetTimes = Readonly<Record<LearningResetCategory, string | null>>;

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
  /** カテゴリごとの最後の Reset（追加の順で最後のもの）。 */
  boundaries(): ResetBoundaries;
}

export interface LearningResetStoreOptions {
  readonly now?: () => Date;
  readonly newResetId?: () => string;
}

export interface InMemoryLearningResetStoreOptions extends LearningResetStoreOptions {
  /** Reset の論理順序の番号を振るカウンタ（D117）。省略時はプロセスで 1 つのカウンタ（メモリ内の Event Store と共有する）。 */
  readonly ordinals?: OrdinalCounter;
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

function noBoundaries(): Record<LearningResetCategory, ResetBoundary | null> {
  return { score: null, hypothesis: null, profile: null };
}

/** API の応答に出す時刻だけにする（区切りの判定は ord で行い、時刻は表示用）。 */
export function resetTimes(boundaries: ResetBoundaries): ResetTimes {
  return {
    score: boundaries.score?.createdAt ?? null,
    hypothesis: boundaries.hypothesis?.createdAt ?? null,
    profile: boundaries.profile?.createdAt ?? null,
  };
}

/** プロセス内のメモリだけに持つ実装（テスト用。再起動で消える）。 */
export class InMemoryLearningResetStore implements LearningResetStore {
  /** 追加の順（SQLite の learning_resets.seq と同じ意味）。 */
  private readonly rows: (LearningResetRecord & { readonly ord: number })[] =
    [];
  private readonly now: () => Date;
  private readonly newResetId: () => string;
  private readonly ordinals: OrdinalCounter;

  constructor(options: InMemoryLearningResetStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newResetId = options.newResetId ?? randomUUID;
    this.ordinals = options.ordinals ?? processOrdinals;
  }

  add(categories: readonly LearningResetCategory[]): LearningResetRecord {
    const record: LearningResetRecord = {
      resetId: this.newResetId(),
      createdAt: this.now().toISOString(),
      categories: normalize(categories),
    };
    this.rows.push({ ...record, ord: this.ordinals.next() });
    return record;
  }

  boundaries(): ResetBoundaries {
    // 追加の順で後の行が、そのカテゴリの最後の Reset（created_at の時刻では比べない。D117）。
    const result = noBoundaries();
    for (const row of this.rows) {
      for (const c of row.categories) {
        result[c] = { ord: row.ord, createdAt: row.createdAt };
      }
    }
    return result;
  }
}

/** SQLite の実装（v8 の learning_resets。DB は Event Store と共有する）。 */
export class SqliteLearningResetStore implements LearningResetStore {
  private readonly insert: StatementSync;
  private readonly insertOrdinal: StatementSync;
  private readonly selectLast: StatementSync;
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
    this.insertOrdinal = db.prepare(
      "INSERT INTO ordinals (kind, ref_id) VALUES ('learning_reset', ?)",
    );
    // カテゴリごとに seq が最大の行（追加の順で最後の Reset）と、その Reset の論理順序の番号（欠けていれば NULL）。
    this.selectLast = db.prepare(
      `SELECT r.reset_id, r.created_at, r.category, o.ord
       FROM learning_resets r
       LEFT JOIN ordinals o ON o.kind = 'learning_reset' AND o.ref_id = r.reset_id
       WHERE r.seq = (SELECT MAX(seq) FROM learning_resets l WHERE l.category = r.category)`,
    );
  }

  add(categories: readonly LearningResetCategory[]): LearningResetRecord {
    const record: LearningResetRecord = {
      resetId: this.newResetId(),
      createdAt: this.now().toISOString(),
      categories: normalize(categories),
    };
    // カテゴリごとの行と論理順序の行（1 回の Reset に 1 行）を 1 トランザクションで足す（一部のカテゴリだけの区切り・番号の無い区切りを残さない）。
    inTransaction(this.db, () => {
      for (const c of record.categories) {
        this.insert.run(record.resetId, record.createdAt, c);
      }
      this.insertOrdinal.run(record.resetId);
    });
    return record;
  }

  boundaries(): ResetBoundaries {
    const rows = this.selectLast.all() as unknown as {
      reset_id: string;
      created_at: string;
      category: LearningResetCategory;
      ord: number | null;
    }[];
    const result = noBoundaries();
    for (const row of rows) {
      if (row.ord === null) {
        throw new MissingOrdinalError(
          `Learning Reset ${row.reset_id} に論理順序（ordinals）の行が無い`,
        );
      }
      result[row.category] = { ord: row.ord, createdAt: row.created_at };
    }
    return result;
  }
}

/**
 * Hand が区切りより後に保存された（終わった）か（D117）。savedOrder は Event Store の savedOrder（終わっていない Hand は null）。
 * 区切りが null（Reset していない）なら終わった Hand はすべて入る。番号の比較なので、壁時計が戻っても前後は変わらない。
 */
export function savedAfter(
  savedOrder: number | null,
  boundary: ResetBoundary | null,
): boolean {
  if (savedOrder === null) return false;
  return boundary === null || savedOrder > boundary.ord;
}
