// Opponent Memory Reset（docs/04 §11・D64・D120・#143）。Reset は行の削除ではなく、マイグレーション v11 の追記型の
// opponent_memory_resets に区切りの行を足す。Event Log・reviews・User Read / Note / Tag・Learning Reset の区切り（learning_resets）は
// 変えない（このモジュールは learning/ を import しない。Hero の弱点の計算とは別の層）。
// - 対象は全 CPU（all）か 1 つの Fixed CPU（cpu_profile。Fixed CPU Factory Reset）。Reset は Observer（記憶を持つ CPU）の
//   Memory を消すもので、「その CPU について他の CPU が持つ Memory」（Subject 側）は消さない（D120 に書かれていない範囲を広げない）
// - 区切りの判定（決定論・D117）: 追加した時点の ordinals の最大の ord（Hand が 0 件なら 0）を区切りに持ち、Observer の Observation・
//   Hypothesis・Memory の注入は、その Observer に効く最後の区切りより ord が大きい保存済みの Hand だけを入力にする。
//   Fixed CPU X に効くのは scope = all の行と cpu_profile_id = X の行で、ord が大きい方（同じなら seq が大きい方）。Guest
//   （Session 限り）に効くのは scope = all の行だけ。壁時計（created_at）では比べない（OS の時刻は後ろへ戻ることがある。#129・#130）
// - Reset より後に始まった Hand は区切りより後に保存されるので入る。Reset の時点で進行中の Hand（保存は Reset の後）も入る
//   （Learning Reset と同じく、Hand の保存の順で切る）。Hand の開始時に作った今の Hand の Memory は、その Hand の間は変えない
// - 区切りの最大の ord の取得と挿入は 1 トランザクションで行う（SQLite は挿入の Trigger でも最大と一致することを確かめる）
// - ordinals には行を足さない（kind の CHECK を変えない。D120）。区切りと同じ ord の Hand は Reset 前（ord は Hand の保存で増える）
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { inTransaction } from "../db/database.js";
import { processOrdinals, type OrdinalCounter } from "../logical-order.js";
import type { ObserverRef } from "./observation.js";

/** Reset の対象。並びは API・画面の順。 */
export const OPPONENT_MEMORY_RESET_SCOPES = ["all", "cpu_profile"] as const;

export type OpponentMemoryResetScope =
  (typeof OPPONENT_MEMORY_RESET_SCOPES)[number];

/** Reset の対象の指定。cpu_profile は 1 つの Fixed CPU（Pool の cpuProfileId）。 */
export type OpponentMemoryResetTarget =
  | { readonly scope: "all" }
  | { readonly scope: "cpu_profile"; readonly cpuProfileId: string };

/** 追加した区切り 1 つ（API の応答の形。ord〔判定用〕と Persona・Hypothesis の中身は持たない）。 */
export interface OpponentMemoryResetRecord {
  readonly resetId: string;
  /** ISO 8601（UTC）。表示用で、区切りの判定には使わない。 */
  readonly createdAt: string;
  readonly scope: OpponentMemoryResetScope;
  /** scope が cpu_profile のときだけ。all は null。 */
  readonly cpuProfileId: string | null;
}

/** Observer に効く最後の区切り。ord より大きい ord で保存された Hand だけを Memory の入力にする。 */
export interface MemoryResetBoundary {
  readonly ord: number;
  readonly createdAt: string;
}

export interface OpponentMemoryResetStore {
  /** 区切りを 1 つ足す（追加した時点の最大の ord を区切りに持つ）。 */
  add(target: OpponentMemoryResetTarget): OpponentMemoryResetRecord;
  /** Observer に効く最後の区切り。Reset していなければ null（全期間）。 */
  boundaryFor(observer: ObserverRef): MemoryResetBoundary | null;
}

export interface OpponentMemoryResetStoreOptions {
  readonly now?: () => Date;
  readonly newResetId?: () => string;
}

export interface InMemoryOpponentMemoryResetStoreOptions extends OpponentMemoryResetStoreOptions {
  /**
   * 区切りに使う論理順序のカウンタ（D117）。Event Store と同じカウンタを渡す（番号を比べられるように）。
   * 省略時はプロセスで 1 つのカウンタ（メモリ内の Event Store の既定と共有する）。
   */
  readonly ordinals?: OrdinalCounter;
}

/** 対象を検査して記録の形にする（cpu_profile の id は空にしない）。 */
function recordOf(
  target: OpponentMemoryResetTarget,
  resetId: string,
  createdAt: string,
): OpponentMemoryResetRecord {
  if (target.scope === "all") {
    return { resetId, createdAt, scope: "all", cpuProfileId: null };
  }
  if (target.scope !== "cpu_profile" || target.cpuProfileId.length === 0) {
    throw new RangeError("Opponent Memory Reset の対象が不正");
  }
  return {
    resetId,
    createdAt,
    scope: "cpu_profile",
    cpuProfileId: target.cpuProfileId,
  };
}

/** その区切りの行が Observer に効くか（all は全 CPU、cpu_profile は同じ Fixed CPU だけ）。 */
function appliesTo(
  row: {
    readonly scope: OpponentMemoryResetScope;
    readonly cpuProfileId: string | null;
  },
  observer: ObserverRef,
): boolean {
  return (
    row.scope === "all" ||
    (observer.kind === "cpu_profile" &&
      row.cpuProfileId === observer.cpuProfileId)
  );
}

/** プロセス内のメモリだけに持つ実装（テスト用。再起動で消える）。 */
export class InMemoryOpponentMemoryResetStore implements OpponentMemoryResetStore {
  /** 追加の順（SQLite の opponent_memory_resets.seq と同じ意味）。 */
  private readonly rows: (OpponentMemoryResetRecord & {
    readonly ord: number;
  })[] = [];
  private readonly now: () => Date;
  private readonly newResetId: () => string;
  private readonly ordinals: OrdinalCounter;

  constructor(options: InMemoryOpponentMemoryResetStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newResetId = options.newResetId ?? randomUUID;
    this.ordinals = options.ordinals ?? processOrdinals;
  }

  add(target: OpponentMemoryResetTarget): OpponentMemoryResetRecord {
    const record = recordOf(
      target,
      this.newResetId(),
      this.now().toISOString(),
    );
    this.rows.push({ ...record, ord: this.ordinals.current() });
    return record;
  }

  boundaryFor(observer: ObserverRef): MemoryResetBoundary | null {
    // ord が大きい方、同じなら追加の順で後の行（created_at の時刻では比べない。D117）。
    let last: MemoryResetBoundary | null = null;
    for (const row of this.rows) {
      if (!appliesTo(row, observer)) continue;
      if (last === null || row.ord >= last.ord) {
        last = { ord: row.ord, createdAt: row.createdAt };
      }
    }
    return last;
  }
}

/** SQLite の実装（v11 の opponent_memory_resets。DB は Event Store と共有する）。 */
export class SqliteOpponentMemoryResetStore implements OpponentMemoryResetStore {
  private readonly insert: StatementSync;
  private readonly selectAll: StatementSync;
  private readonly selectFixed: StatementSync;
  private readonly now: () => Date;
  private readonly newResetId: () => string;

  constructor(
    private readonly db: DatabaseSync,
    options: OpponentMemoryResetStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newResetId = options.newResetId ?? randomUUID;
    // 区切りの ord は、挿入と同じ文・同じトランザクションで ordinals の最大から取る（Hand が 0 件なら 0）。
    this.insert = db.prepare(
      `INSERT INTO opponent_memory_resets (reset_id, created_at, scope, cpu_profile_id, ord)
       SELECT ?, ?, ?, ?, COALESCE(MAX(ord), 0) FROM ordinals`,
    );
    // Observer に効く行のうち、ord が最大の行（同じなら seq が最大の行）。
    this.selectAll = db.prepare(
      `SELECT ord, created_at FROM opponent_memory_resets
       WHERE scope = 'all'
       ORDER BY ord DESC, seq DESC LIMIT 1`,
    );
    this.selectFixed = db.prepare(
      `SELECT ord, created_at FROM opponent_memory_resets
       WHERE scope = 'all' OR (scope = 'cpu_profile' AND cpu_profile_id = ?)
       ORDER BY ord DESC, seq DESC LIMIT 1`,
    );
  }

  add(target: OpponentMemoryResetTarget): OpponentMemoryResetRecord {
    const record = recordOf(
      target,
      this.newResetId(),
      this.now().toISOString(),
    );
    inTransaction(this.db, () => {
      this.insert.run(
        record.resetId,
        record.createdAt,
        record.scope,
        record.cpuProfileId,
      );
    });
    return record;
  }

  boundaryFor(observer: ObserverRef): MemoryResetBoundary | null {
    const row = (
      observer.kind === "cpu_profile"
        ? this.selectFixed.get(observer.cpuProfileId)
        : this.selectAll.get()
    ) as { ord: number; created_at: string } | undefined;
    return row === undefined
      ? null
      : { ord: row.ord, createdAt: row.created_at };
  }
}
