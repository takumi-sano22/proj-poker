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
  // v3: Review（docs/04 §8・D95・D39）。Hand の判断ごとの Review を Version 付きで追記し、上書きしない（UPDATE は Trigger で拒否）。
  // 再生成は同じ Hand・判断・Pass の次の version の行になる（(hand_id, decision_index, pass, version) が一意）。既存のテーブル・行は変えない。
  // evidence は Review AI に渡した構造化 Evidence（判断時点の情報だけ）、explanation は説明（Practical → Theory → Exploit と結論が変わる条件）、
  // assumptions・evidence_ids は JSON。concrete_model は Review AI を呼ばなかった（Gate で止めた）とき NULL、
  // solver_version は Supported の Solver Evidence を使わなかったとき NULL、failure は出力の検証に失敗したときだけ持つ。
  `
  CREATE TABLE reviews (
    review_id      TEXT PRIMARY KEY,
    hand_id        TEXT NOT NULL REFERENCES hands (hand_id),
    decision_index INTEGER NOT NULL CHECK (decision_index >= 0),
    action_seq     INTEGER NOT NULL CHECK (action_seq >= 0),
    pass           TEXT NOT NULL CHECK (pass IN ('decision')),
    version        INTEGER NOT NULL CHECK (version >= 1),
    created_at     TEXT NOT NULL,
    depth          TEXT NOT NULL CHECK (depth IN ('standard', 'deep')),
    model_role     TEXT NOT NULL CHECK (model_role IN ('review_standard', 'review_deep')),
    concrete_model TEXT,
    kb_version     TEXT NOT NULL,
    solver_version TEXT,
    generated_by   TEXT NOT NULL CHECK (generated_by IN ('review_ai', 'sufficiency_gate', 'invalid_output_fallback')),
    assessment     TEXT NOT NULL CHECK (assessment IN ('strong', 'reasonable', 'mixed_marginal', 'improvement_suggested', 'major_leak', 'insufficient_evidence')),
    confidence     TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
    assumptions    TEXT NOT NULL CHECK (json_valid(assumptions)),
    evidence_ids   TEXT NOT NULL CHECK (json_valid(evidence_ids)),
    explanation    TEXT NOT NULL CHECK (json_valid(explanation)),
    evidence       TEXT NOT NULL CHECK (json_valid(evidence)),
    failure        TEXT CHECK (failure IS NULL OR json_valid(failure)),
    UNIQUE (hand_id, decision_index, pass, version)
  ) STRICT;

  -- 過去の Review を上書きしない（D39）。削除は Hand History Delete（docs/04 §11）と一緒に設計するため、ここでは塞がない。
  CREATE TRIGGER reviews_append_only
  BEFORE UPDATE ON reviews
  BEGIN
    SELECT RAISE(ABORT, 'reviews is append-only');
  END;
  `,
  // v4: Reveal Review（Pass B）と Follow-up の履歴（#83・docs/04 §8・D99）。どちらも追記だけで、UPDATE と DELETE は Trigger で拒否する（D39）。
  // 既存のテーブル（reviews を含む）の列・行は変えない（D76）。追記専用を機械で守るため、既存の events（D37）・reviews（D39）にも
  // DELETE を拒否する Trigger だけを足す（v1・v3 では UPDATE だけを拒否していた）。Reset / Hand History Delete（docs/04 §11）を設計するときは、
  // 削除の経路と一緒にこの Trigger の扱いを決める。Pass B は判断時点の評価を付け直さないので assessment 列を持たない（結果論を混ぜない）。
  // reveal_reviews: Hand の判断ごとの Pass B を Version 付きで追記する（(hand_id, decision_index, version) が一意）。evidence は Hand 後に見せた
  //   全員の札（Learning-only Full Reveal）と、そこから決定論で計算した実際の Equity・Bluff / Value の答え合わせを含む。
  // review_followups: Review の Version（pass と review_id）ごとに、Follow-up の質問と答えを 1 ターン 1 行で追記する（(review_id, turn) が一意）。
  //   review_id は pass が decision なら reviews、reveal なら reveal_reviews の行を指す。外部キーは 1 つのテーブルしか指せないので、
  //   挿入の Trigger で、指す行が実在し Hand・判断・Version が合うことを確かめる。answer は答え（scope・本文・根拠の id）の JSON。
  `
  CREATE TABLE reveal_reviews (
    review_id      TEXT PRIMARY KEY,
    hand_id        TEXT NOT NULL REFERENCES hands (hand_id),
    decision_index INTEGER NOT NULL CHECK (decision_index >= 0),
    action_seq     INTEGER NOT NULL CHECK (action_seq >= 0),
    version        INTEGER NOT NULL CHECK (version >= 1),
    created_at     TEXT NOT NULL,
    depth          TEXT NOT NULL CHECK (depth IN ('standard', 'deep')),
    model_role     TEXT NOT NULL CHECK (model_role IN ('review_standard', 'review_deep')),
    concrete_model TEXT,
    generated_by   TEXT NOT NULL CHECK (generated_by IN ('review_ai', 'sufficiency_gate', 'invalid_output_fallback')),
    evidence_ids   TEXT NOT NULL CHECK (json_valid(evidence_ids)),
    explanation    TEXT NOT NULL CHECK (json_valid(explanation)),
    evidence       TEXT NOT NULL CHECK (json_valid(evidence)),
    failure        TEXT CHECK (failure IS NULL OR json_valid(failure)),
    UNIQUE (hand_id, decision_index, version)
  ) STRICT;

  CREATE TRIGGER reveal_reviews_append_only
  BEFORE UPDATE ON reveal_reviews
  BEGIN
    SELECT RAISE(ABORT, 'reveal_reviews is append-only');
  END;

  CREATE TRIGGER reveal_reviews_no_delete
  BEFORE DELETE ON reveal_reviews
  BEGIN
    SELECT RAISE(ABORT, 'reveal_reviews is append-only');
  END;

  CREATE TABLE review_followups (
    followup_id    TEXT PRIMARY KEY,
    pass           TEXT NOT NULL CHECK (pass IN ('decision', 'reveal')),
    review_id      TEXT NOT NULL,
    hand_id        TEXT NOT NULL REFERENCES hands (hand_id),
    decision_index INTEGER NOT NULL CHECK (decision_index >= 0),
    review_version INTEGER NOT NULL CHECK (review_version >= 1),
    turn           INTEGER NOT NULL CHECK (turn >= 1),
    created_at     TEXT NOT NULL,
    depth          TEXT NOT NULL CHECK (depth IN ('standard', 'deep')),
    model_role     TEXT NOT NULL CHECK (model_role IN ('review_standard', 'review_deep')),
    concrete_model TEXT NOT NULL,
    generated_by   TEXT NOT NULL CHECK (generated_by IN ('review_ai', 'invalid_output_fallback')),
    question       TEXT NOT NULL,
    answer         TEXT NOT NULL CHECK (json_valid(answer)),
    failure        TEXT CHECK (failure IS NULL OR json_valid(failure)),
    UNIQUE (review_id, turn)
  ) STRICT;

  CREATE TRIGGER review_followups_target
  BEFORE INSERT ON review_followups
  WHEN NOT EXISTS (
    SELECT 1 FROM reviews
    WHERE NEW.pass = 'decision' AND review_id = NEW.review_id AND hand_id = NEW.hand_id
      AND decision_index = NEW.decision_index AND version = NEW.review_version
  ) AND NOT EXISTS (
    SELECT 1 FROM reveal_reviews
    WHERE NEW.pass = 'reveal' AND review_id = NEW.review_id AND hand_id = NEW.hand_id
      AND decision_index = NEW.decision_index AND version = NEW.review_version
  )
  BEGIN
    SELECT RAISE(ABORT, 'review_followups must point to an existing review version');
  END;

  CREATE TRIGGER review_followups_append_only
  BEFORE UPDATE ON review_followups
  BEGIN
    SELECT RAISE(ABORT, 'review_followups is append-only');
  END;

  CREATE TRIGGER review_followups_no_delete
  BEFORE DELETE ON review_followups
  BEGIN
    SELECT RAISE(ABORT, 'review_followups is append-only');
  END;

  CREATE TRIGGER events_no_delete
  BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
  END;

  CREATE TRIGGER reviews_no_delete
  BEFORE DELETE ON reviews
  BEGIN
    SELECT RAISE(ABORT, 'reviews is append-only');
  END;
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
