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
  // v5: Hero の Note / Tag（D31・D112・#115）。Hand に属さない Hero の入力なので、Event Log ではなく追記型のテーブルに置く。
  // 既存のテーブル・列・行は変えない（D76）。どちらも UPDATE / DELETE を Trigger で拒否し、seq（追記の順）で今の状態を決める。
  // 対象（Subject）は席の playerId を永続の Identity とみなさない参照で、subject は JSON（kind ごとの形。notes/subject.ts）、
  // subject_key はその検索の鍵。Session の行は最初の Hand が終わるまで無いので、sessions は参照しない。
  // user_notes: Note の 1 つの revision。削除は同じ note_id の次の revision の、本文の無い行（tombstone）。最初の revision は本文を持ち、
  // 次の revision は同じ対象の、まだ消していない直前の revision にだけ続けられる（消した Note は戻さない）。
  // user_tags: Tag の付け外し（add / remove）。対象と Tag ごとに最後の行が今の状態。
  `
  CREATE TABLE user_notes (
    seq         INTEGER PRIMARY KEY,
    note_id     TEXT NOT NULL,
    revision    INTEGER NOT NULL CHECK (revision >= 1),
    created_at  TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    subject     TEXT NOT NULL CHECK (json_valid(subject)),
    body        TEXT CHECK (body IS NULL OR length(body) BETWEEN 1 AND 500),
    CHECK (revision > 1 OR body IS NOT NULL),
    UNIQUE (note_id, revision)
  ) STRICT;

  CREATE INDEX user_notes_by_subject ON user_notes (subject_key, seq);

  CREATE TRIGGER user_notes_revision_follows
  BEFORE INSERT ON user_notes
  WHEN NEW.revision > 1 AND NOT EXISTS (
    SELECT 1 FROM user_notes
    WHERE note_id = NEW.note_id AND revision = NEW.revision - 1
      AND subject_key = NEW.subject_key AND body IS NOT NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'user_notes revision must follow a live revision of the same note');
  END;

  CREATE TRIGGER user_notes_append_only
  BEFORE UPDATE ON user_notes
  BEGIN
    SELECT RAISE(ABORT, 'user_notes is append-only');
  END;

  CREATE TRIGGER user_notes_no_delete
  BEFORE DELETE ON user_notes
  BEGIN
    SELECT RAISE(ABORT, 'user_notes is append-only');
  END;

  CREATE TABLE user_tags (
    seq         INTEGER PRIMARY KEY,
    created_at  TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    subject     TEXT NOT NULL CHECK (json_valid(subject)),
    tag         TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 20),
    op          TEXT NOT NULL CHECK (op IN ('add', 'remove'))
  ) STRICT;

  CREATE INDEX user_tags_by_subject ON user_tags (subject_key, seq);

  CREATE TRIGGER user_tags_append_only
  BEFORE UPDATE ON user_tags
  BEGIN
    SELECT RAISE(ABORT, 'user_tags is append-only');
  END;

  CREATE TRIGGER user_tags_no_delete
  BEFORE DELETE ON user_tags
  BEGIN
    SELECT RAISE(ABORT, 'user_tags is append-only');
  END;
  `,
  // v6: Weakness Hypothesis の Snapshot（D104・D113・#114）。reviews（Pass A）から決定論で作り直せる派生データで、正本にしない。
  // 作り直すときは全行を消して入れ直す（learning/hypothesis-snapshot.ts）ので、追記専用の Trigger は付けない。既存のテーブル・列・行は変えない（D76）。
  // hypothesis_id は `<policy_version>/<type>`。type の一覧は HypothesisPolicy の Version 付きの暫定値（OI-006）なので CHECK で固定しない。
  // supporting_evidence_ids・counter_evidence_ids は Ability Evidence の ID（`<hand_id>/d<判断の番号>/v<Review の Version>`）の JSON 配列。
  `
  CREATE TABLE hypothesis_snapshots (
    hypothesis_id           TEXT PRIMARY KEY,
    policy_version          TEXT NOT NULL,
    type                    TEXT NOT NULL,
    status                  TEXT NOT NULL CHECK (status IN ('suspected', 'supported', 'strong', 'improving', 'resolved', 'insufficient_data')),
    supporting_evidence_ids TEXT NOT NULL CHECK (json_valid(supporting_evidence_ids) AND json_type(supporting_evidence_ids) = 'array'),
    counter_evidence_ids    TEXT NOT NULL CHECK (json_valid(counter_evidence_ids) AND json_type(counter_evidence_ids) = 'array'),
    computed_at             TEXT NOT NULL
  ) STRICT;
  `,
  // v7: Targeted Drill（D105・D110・D116・#117）。Drill の Hand は専用の Session の通常の Hand として Event Log に残し（Event の形は変えない）、
  // このテーブルで通常の Play と区別する（Stats・Score・Profile・Hypothesis・Resume・Replay の一覧は drill_hand_id の Hand を除く）。
  // 既存のテーブル・列・行は変えない（D76）。追記だけで、UPDATE / DELETE は Trigger で拒否する。
  // 行は Drill の Hand を始める前に足す（Hand の保存より先に除く対象に入れる）ので、drill_hand_id は hands を参照しない
  // （途中で止まった Drill の Hand は保存されず、行だけが残る）。provenance は元の Hand・判断・Pass A の Review で、
  // 挿入の Trigger で、Review の行がその Hand・判断のものであることを確かめる。variant は変形の値（JSON）、seed と policy_version で
  // 同じ Drill を作り直せる（drill/drill-plan.ts）。
  `
  CREATE TABLE drills (
    drill_id              TEXT PRIMARY KEY,
    created_at            TEXT NOT NULL,
    source_hand_id        TEXT NOT NULL REFERENCES hands (hand_id),
    source_decision_index INTEGER NOT NULL CHECK (source_decision_index >= 0),
    source_review_id      TEXT NOT NULL REFERENCES reviews (review_id),
    variant_kind          TEXT NOT NULL,
    variant               TEXT NOT NULL CHECK (json_valid(variant) AND json_type(variant) = 'object'),
    policy_version        TEXT NOT NULL,
    seed                  INTEGER NOT NULL CHECK (seed >= 0),
    drill_hand_id         TEXT NOT NULL UNIQUE,
    CHECK (drill_hand_id <> source_hand_id)
  ) STRICT;

  CREATE TRIGGER drills_source_review
  BEFORE INSERT ON drills
  WHEN NOT EXISTS (
    SELECT 1 FROM reviews
    WHERE review_id = NEW.source_review_id AND hand_id = NEW.source_hand_id
      AND decision_index = NEW.source_decision_index
  )
  BEGIN
    SELECT RAISE(ABORT, 'drills must point to a Pass A review of the source decision');
  END;

  CREATE TRIGGER drills_append_only
  BEFORE UPDATE ON drills
  BEGIN
    SELECT RAISE(ABORT, 'drills is append-only');
  END;

  CREATE TRIGGER drills_no_delete
  BEFORE DELETE ON drills
  BEGIN
    SELECT RAISE(ABORT, 'drills is append-only');
  END;
  `,
  // v8: Learning Reset の区切り（D64・D114・#118）。Reset は行の削除ではなく、ここへ区切りの行を足す（Event Log・reviews 等の正本は消さず、
  // 削除拒否の Trigger も外さない）。Score / Profile / Hypothesis は、そのカテゴリの最後の行の created_at より後に終わった Hand の
  // Evidence だけで計算する（learning/learning-reset.ts）。1 回の Reset はカテゴリごとに 1 行で、同じ reset_id・同じ created_at を持つ。
  // カテゴリは D114 の 3 つ（Opponent Memory Reset〔P7-8〕はこのテーブルに入れない）。既存のテーブル・列・行は変えない（D76）。
  // 追記だけで、UPDATE / DELETE は Trigger で拒否する。マイグレーション v8 は D114 の人間判断の範囲。
  `
  CREATE TABLE learning_resets (
    seq        INTEGER PRIMARY KEY,
    reset_id   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    category   TEXT NOT NULL CHECK (category IN ('score', 'profile', 'hypothesis')),
    UNIQUE (reset_id, category)
  ) STRICT;

  CREATE TRIGGER learning_resets_append_only
  BEFORE UPDATE ON learning_resets
  BEGIN
    SELECT RAISE(ABORT, 'learning_resets is append-only');
  END;

  CREATE TRIGGER learning_resets_no_delete
  BEFORE DELETE ON learning_resets
  BEGIN
    SELECT RAISE(ABORT, 'learning_resets is append-only');
  END;
  `,
  // v9: 意味上の順序（D117・#132）。壁時計（started_at・recorded_at・created_at 等）は後ろへ戻ることがあるので、「どちらが先か」は
  // 記録の順に振る番号 ord で決める（logical-order.ts）。Hand の保存（kind = hand_saved・ref_id = hand_id）と Learning Reset の追加
  // （kind = learning_reset・ref_id = reset_id。1 回の Reset に 1 行）の同じトランザクションで 1 行足す。壁時計の列は消さない。
  // 既存のテーブル・列・行は変えない（D76）。追記だけで、UPDATE / DELETE は Trigger で拒否し、挿入は参照先が実在する行だけを受け付ける。
  // マイグレーション v9 は D117 の人間判断の範囲（追加のみ）。
  // backfill（INSERT のみ。既存の行は書き換えない。best-effort）: Hand どうしは hands の挿入の順（rowid）、Reset どうしは learning_resets.seq の
  // 順を保ち、両方の先頭を記録時刻（hands.finished_at と learning_resets.created_at）で比べて早い方を先に並べる（同じ時刻なら Hand を先に。
  // v8 までの判定〔同じ時刻の Hand は Reset 前〕と同じ）。番号は併合の手順の番号 n を明示して入れ、挿入の順に頼らない。
  `
  CREATE TABLE ordinals (
    ord    INTEGER PRIMARY KEY AUTOINCREMENT,
    kind   TEXT NOT NULL CHECK (kind IN ('hand_saved', 'learning_reset')),
    ref_id TEXT NOT NULL,
    UNIQUE (kind, ref_id)
  ) STRICT;

  CREATE TRIGGER ordinals_target
  BEFORE INSERT ON ordinals
  WHEN NOT EXISTS (
    SELECT 1 FROM hands WHERE NEW.kind = 'hand_saved' AND hand_id = NEW.ref_id
  ) AND NOT EXISTS (
    SELECT 1 FROM learning_resets WHERE NEW.kind = 'learning_reset' AND reset_id = NEW.ref_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'ordinals must point to an existing hand or learning reset');
  END;

  CREATE TRIGGER ordinals_append_only
  BEFORE UPDATE ON ordinals
  BEGIN
    SELECT RAISE(ABORT, 'ordinals is append-only');
  END;

  CREATE TRIGGER ordinals_no_delete
  BEFORE DELETE ON ordinals
  BEGIN
    SELECT RAISE(ABORT, 'ordinals is append-only');
  END;

  WITH RECURSIVE
    h (i, ref_id, t) AS MATERIALIZED (
      SELECT ROW_NUMBER() OVER (ORDER BY rowid), hand_id, julianday(finished_at) FROM hands
    ),
    r (j, ref_id, t) AS MATERIALIZED (
      SELECT ROW_NUMBER() OVER (ORDER BY first_seq), reset_id, julianday(created_at)
      FROM (SELECT reset_id, MIN(seq) AS first_seq, MIN(created_at) AS created_at FROM learning_resets GROUP BY reset_id)
    ),
    -- 併合の 1 手ごとの状態: n 手目に kind の ref_id を取り、i 件の Hand・j 件の Reset を並べ終えた。
    -- 次の Hand があり、次の Reset が無いか Hand の時刻が Reset の時刻以下なら Hand を取る（CASE は NULL を偽として扱うので、
    -- 時刻が読めない〔julianday が NULL〕ときは Reset を先に取る。4 つの CASE は同じ条件）。
    merged (n, i, j, kind, ref_id) AS (
      SELECT 0, 0, 0, NULL, NULL
      UNION ALL
      SELECT
        m.n + 1,
        m.i + (CASE WHEN nh.i IS NOT NULL AND (nr.j IS NULL OR nh.t <= nr.t) THEN 1 ELSE 0 END),
        m.j + (CASE WHEN nh.i IS NOT NULL AND (nr.j IS NULL OR nh.t <= nr.t) THEN 0 ELSE 1 END),
        CASE WHEN nh.i IS NOT NULL AND (nr.j IS NULL OR nh.t <= nr.t) THEN 'hand_saved' ELSE 'learning_reset' END,
        CASE WHEN nh.i IS NOT NULL AND (nr.j IS NULL OR nh.t <= nr.t) THEN nh.ref_id ELSE nr.ref_id END
      FROM merged m
      LEFT JOIN h nh ON nh.i = m.i + 1
      LEFT JOIN r nr ON nr.j = m.j + 1
      WHERE nh.i IS NOT NULL OR nr.j IS NOT NULL
    )
  INSERT INTO ordinals (ord, kind, ref_id)
  SELECT n, kind, ref_id FROM merged WHERE n > 0 ORDER BY n;
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
