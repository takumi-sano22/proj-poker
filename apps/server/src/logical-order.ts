// 意味上の順序（D117・#132）。「どちらが先か」で結果が変わる判定（Learning Reset の前後・Replay の新しい順・Session 内の Hand の順・
// Recent の順・最新の Session Projection の選択・Resume）は、壁時計（OS の時刻。後ろへ戻ることがある）ではなく、記録の順に振る
// 単調増加の番号（論理順序）で決める。壁時計の列（started_at・recorded_at・created_at 等）は表示・監査の Metadata として残す。
// - SQLite: マイグレーション v9 の追記型の ordinals（ord は AUTOINCREMENT）。Hand の保存と Learning Reset の追加の同じトランザクションで 1 行足す
// - メモリ内の実装（テスト用）: このモジュールのカウンタ。Event Store と Learning Reset Store が同じカウンタを使うと、番号どうしを比べられる

/** 論理順序の番号を振るカウンタ（メモリ内の実装用）。 */
export interface OrdinalCounter {
  /** 次の番号（1 から。呼ぶたびに増える）。 */
  next(): number;
}

export function createOrdinalCounter(): OrdinalCounter {
  let last = 0;
  return { next: () => ++last };
}

/**
 * メモリ内の Store が既定で使う、プロセスで 1 つのカウンタ。
 * Store ごとにカウンタを分けると、Event Store の Hand の番号と Learning Reset Store の Reset の番号を比べられなくなるため、既定は共有する。
 */
export const processOrdinals: OrdinalCounter = createOrdinalCounter();

/** 保存済みの Hand・Learning Reset に論理順序の行が無い（v9 の backfill 後は必ずある。欠けていれば順序を決められない）。 */
export class MissingOrdinalError extends Error {
  override readonly name = "MissingOrdinalError";
}
