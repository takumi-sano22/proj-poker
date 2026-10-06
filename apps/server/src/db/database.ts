// SQLite の接続と自前の小さなマイグレーション（D72: node:sqlite・ORM なし・生 SQL）。
// 永続化は Runtime（apps/server）だけが扱う（D67）。Engine はこのモジュールを import しない。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * マイグレーション。添字 + 1 が適用後の schema の版で、PRAGMA user_version に記録する。
 * 適用済みの要素は書き換えない（既存の DB と食い違う）。変更は末尾に新しい要素を足す。
 */
export const MIGRATIONS: readonly string[] = [
  // v1: Session・Hand・Event（docs/04 §1・§10）。Event Log が正本で、Hand は HAND_FINISHED の時点で 1 トランザクションで保存する（D62）。
  `
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE hands (
    hand_id     TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions (session_id),
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL
  ) STRICT;

  -- payload は Engine の HandEvent をそのまま JSON にしたもの（seq・visibility を含む）。
  -- schema_version は payload の形の版。読み出し側が知らない版は読まずに失敗させる（docs/04 §3）。
  CREATE TABLE events (
    event_id       TEXT PRIMARY KEY,
    hand_id        TEXT NOT NULL REFERENCES hands (hand_id),
    seq            INTEGER NOT NULL CHECK (seq >= 0),
    type           TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    recorded_at    TEXT NOT NULL,
    payload        TEXT NOT NULL CHECK (json_valid(payload)),
    UNIQUE (hand_id, seq)
  ) STRICT;

  -- append-only（D37）。保存済みの Event は書き換えさせない。
  -- 削除は Reset（docs/04 §11）の設計と一緒に扱うため、ここでは塞がない。
  CREATE TRIGGER events_append_only
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
  END;
  `,
  // v2: Session Projection（docs/04 §10・D95）。Session の最後に終わった Hand の時点の状態で、Hand の保存と同じトランザクションで
  // 書き替える（Event Log から作り直せる派生データ。D37）。再起動後の Resume の入口に使う。既存のテーブル・行は変えない（D76）。
  // stacks・personas・emergency_bots は JSON（席順の Stack / CPU → Persona の Preset ID / 切り替えた CPU ときっかけの障害の種類）。
  // personas は Hero への応答・CPU の入力には出さない（他 CPU の Secret Persona。#51）。
  `
  CREATE TABLE session_projections (
    session_id     TEXT PRIMARY KEY REFERENCES sessions (session_id),
    last_hand_id   TEXT NOT NULL REFERENCES hands (hand_id),
    state          TEXT NOT NULL CHECK (state IN ('ready_for_next_hand', 'ended')),
    end_reason     TEXT CHECK (end_reason IN ('hero_busted', 'hero_last_standing', 'ai_outage')),
    stacks         TEXT NOT NULL CHECK (json_valid(stacks)),
    personas       TEXT NOT NULL CHECK (json_valid(personas)),
    emergency_bots TEXT NOT NULL CHECK (json_valid(emergency_bots)),
    updated_at     TEXT NOT NULL,
    -- 終わった Session だけが理由を持つ（state は NOT NULL、IS NOT NULL は NULL にならないので比較は真偽のどちらかになる）。
    CHECK ((state = 'ended') = (end_reason IS NOT NULL))
  ) STRICT;
  `,
];

/** DB の schema の版が、このアプリが知る版より新しい（新しい版のアプリで作った DB を古い版で開いた）。 */
export class UnsupportedDatabaseVersionError extends Error {
  override readonly name = "UnsupportedDatabaseVersionError";
}

/** DB ファイルを開き、未適用のマイグレーションを当てる。":memory:" ならファイルを作らない。 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  // 外部キー制約は既定で有効（enableForeignKeyConstraints）。明示しておく。
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** user_version より新しいマイグレーションを、1 版ずつトランザクションで当てる。 */
export function migrate(db: DatabaseSync): void {
  const current = userVersion(db);
  if (current > MIGRATIONS.length) {
    throw new UnsupportedDatabaseVersionError(
      `DB の schema の版 ${current} は、このアプリが知る版 ${MIGRATIONS.length} より新しい`,
    );
  }
  MIGRATIONS.slice(current).forEach((sql, i) => {
    const version = current + i + 1;
    inTransaction(db, () => {
      db.exec(sql);
      // PRAGMA はパラメータを受け付けないため、整数を埋め込む（外部入力ではない）。
      db.exec(`PRAGMA user_version = ${version}`);
    });
  });
}

export function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/** fn を 1 トランザクションで実行する。例外なら ROLLBACK して投げ直す（途中まで書いた状態を残さない）。 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // SQLite が自分でトランザクションを終えている場合（一部のエラー）は ROLLBACK しない（元の例外を隠さない）。
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
