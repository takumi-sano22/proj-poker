import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  openDatabase,
  UnsupportedDatabaseVersionError,
  userVersion,
} from "./database.js";

// マイグレーションは使い捨ての DB ファイルへ最初から当てる（開発用の DB を汚さない）。
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-db-"));
  // 置き場所のディレクトリが無くても作る。
  dbPath = join(dir, "nested", "poker.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(path: string): string[] {
  const db = openDatabase(path);
  try {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name",
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

describe("openDatabase（マイグレーション）", () => {
  it("新しいファイルへ最初から当て、user_version が最新の版になる", () => {
    const db = openDatabase(dbPath);
    try {
      expect(userVersion(db)).toBe(MIGRATIONS.length);
    } finally {
      db.close();
    }
    expect(tableNames(dbPath)).toEqual([
      "events",
      "events_append_only",
      "events_no_delete",
      "hands",
      "hypothesis_snapshots",
      "reveal_reviews",
      "reveal_reviews_append_only",
      "reveal_reviews_no_delete",
      "review_followups",
      "review_followups_append_only",
      "review_followups_no_delete",
      "review_followups_target",
      "reviews",
      "reviews_append_only",
      "reviews_no_delete",
      "session_projections",
      "sessions",
      "user_notes",
      "user_notes_append_only",
      "user_notes_no_delete",
      "user_notes_revision_follows",
      "user_tags",
      "user_tags_append_only",
      "user_tags_no_delete",
    ]);
  });

  it("版 5 の DB に版 6（hypothesis_snapshots）を当てても、既存のテーブルの定義と行は変わらない（D76・D113）", () => {
    const legacyPath = join(dir, "v5.sqlite");
    const v5 = new DatabaseSync(legacyPath);
    try {
      for (const sql of MIGRATIONS.slice(0, 5)) v5.exec(sql);
      v5.exec("PRAGMA user_version = 5");
      v5.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
        INSERT INTO events VALUES ('e1', 'h1', 0, 'HAND_STARTED', 8, '2026-10-05T00:00:00.000Z', '{}');
        INSERT INTO user_tags VALUES (1, '2026-10-05T00:02:00.000Z', 'k', '{}', 'tight', 'add');
      `);
    } finally {
      v5.close();
    }
    const snapshot = (db: DatabaseSync) => ({
      schema: db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE tbl_name <> 'hypothesis_snapshots' ORDER BY name",
        )
        .all(),
      events: db.prepare("SELECT * FROM events").all(),
      tags: db.prepare("SELECT * FROM user_tags").all(),
    });
    const before = new DatabaseSync(legacyPath);
    const expected = snapshot(before);
    before.close();
    const db = openDatabase(legacyPath);
    try {
      expect(userVersion(db)).toBe(MIGRATIONS.length);
      expect(snapshot(db)).toEqual(expected);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM hypothesis_snapshots").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("版 4 の DB に版 5（user_notes・user_tags）を当てても、既存のテーブルの定義と行は変わらない（D76・D112）", () => {
    const legacyPath = join(dir, "v4.sqlite");
    const v4 = new DatabaseSync(legacyPath);
    try {
      for (const sql of MIGRATIONS.slice(0, 4)) v4.exec(sql);
      v4.exec("PRAGMA user_version = 4");
      v4.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
        INSERT INTO events VALUES ('e1', 'h1', 0, 'HAND_STARTED', 7, '2026-10-05T00:00:00.000Z', '{}');
      `);
    } finally {
      v4.close();
    }
    const snapshot = (db: DatabaseSync) => ({
      schema: db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE tbl_name NOT IN ('user_notes', 'user_tags', 'hypothesis_snapshots') ORDER BY name",
        )
        .all(),
      events: db.prepare("SELECT * FROM events").all(),
      hands: db.prepare("SELECT * FROM hands").all(),
    });
    const before = new DatabaseSync(legacyPath);
    const expected = snapshot(before);
    before.close();
    const db = openDatabase(legacyPath);
    try {
      expect(userVersion(db)).toBe(MIGRATIONS.length);
      expect(snapshot(db)).toEqual(expected);
      expect(db.prepare("SELECT COUNT(*) AS n FROM user_notes").get()).toEqual({
        n: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM user_tags").get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });

  it("user_notes は追記だけで、削除（tombstone）は同じ対象の消していない直前の revision にだけ続けられる（D112）", () => {
    const db = openDatabase(":memory:");
    try {
      const insert = db.prepare(
        "INSERT INTO user_notes (note_id, revision, created_at, subject_key, subject, body) VALUES (?, ?, '2026-10-07T00:00:00.000Z', ?, '{}', ?)",
      );
      insert.run("n1", 1, "k1", "Value 寄り");
      // 最初の revision は本文を持つ。本文の長さは 1〜500 字。
      expect(() => insert.run("n2", 1, "k1", null)).toThrow(/CHECK/);
      expect(() => insert.run("n3", 1, "k1", "あ".repeat(501))).toThrow(
        /CHECK/,
      );
      // 同じ revision は一意。直前の revision が無い・別の対象の revision には続けられない。
      expect(() => insert.run("n1", 1, "k1", "x")).toThrow(/UNIQUE/);
      expect(() => insert.run("n1", 3, "k1", null)).toThrow(/revision/);
      expect(() => insert.run("n1", 2, "k2", null)).toThrow(/revision/);
      insert.run("n1", 2, "k1", null);
      // 消した Note には続けられない（戻さない）。
      expect(() => insert.run("n1", 3, "k1", "戻す")).toThrow(/revision/);
      expect(() =>
        db.exec("UPDATE user_notes SET body = 'x' WHERE note_id = 'n1'"),
      ).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM user_notes")).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("user_tags は追記だけで、op は add / remove、Tag は 1〜20 字", () => {
    const db = openDatabase(":memory:");
    try {
      const insert = db.prepare(
        "INSERT INTO user_tags (created_at, subject_key, subject, tag, op) VALUES ('2026-10-07T00:00:00.000Z', 'k1', '{}', ?, ?)",
      );
      insert.run("Loose", "add");
      insert.run("Loose", "remove");
      expect(() => insert.run("Loose", "toggle")).toThrow(/CHECK/);
      expect(() => insert.run("", "add")).toThrow(/CHECK/);
      expect(() => insert.run("あ".repeat(21), "add")).toThrow(/CHECK/);
      expect(() => db.exec("UPDATE user_tags SET op = 'add'")).toThrow(
        /append-only/,
      );
      expect(() => db.exec("DELETE FROM user_tags")).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("版 2 の DB に版 3（reviews）を当てても、既存の行は変わらない（D95・D76）", () => {
    const legacyPath = join(dir, "v2.sqlite");
    const v2 = new DatabaseSync(legacyPath);
    try {
      v2.exec(MIGRATIONS[0] as string);
      v2.exec(MIGRATIONS[1] as string);
      v2.exec("PRAGMA user_version = 2");
      v2.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
        INSERT INTO session_projections VALUES ('s1', 'h1', 'ready_for_next_hand', NULL, '[]', '{}', '[]', '2026-10-05T00:01:00.000Z');
      `);
    } finally {
      v2.close();
    }
    const db = openDatabase(legacyPath);
    try {
      expect(userVersion(db)).toBe(MIGRATIONS.length);
      expect(
        db
          .prepare(
            "SELECT session_id, last_hand_id, state FROM session_projections",
          )
          .all(),
      ).toEqual([
        { session_id: "s1", last_hand_id: "h1", state: "ready_for_next_hand" },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });

  it("reviews は追記だけ: UPDATE を拒否し、同じ Hand・判断・Pass の同じ Version は一意制約で拒否する（D39・LC-022）", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
      `);
      const insert = db.prepare(
        `INSERT INTO reviews VALUES (?, 'h1', 0, 5, 'decision', ?, '2026-10-05T00:02:00.000Z', 'standard', 'review_standard',
          NULL, '1.0.0', NULL, 'sufficiency_gate', ?, 'low', '[]', '{}', '{}', '{}', NULL)`,
      );
      insert.run("r1", 1, "insufficient_evidence");
      expect(() => insert.run("r2", 1, "insufficient_evidence")).toThrow(
        /UNIQUE/,
      );
      expect(() => insert.run("r3", 2, "unknown")).toThrow(/CHECK/);
      expect(() =>
        db.exec(
          "UPDATE reviews SET assessment = 'strong' WHERE review_id = 'r1'",
        ),
      ).toThrow(/append-only/);
      // 存在しない Hand の Review は作れない（保存済みの Hand だけ）。
      expect(() =>
        db.exec(
          `INSERT INTO reviews VALUES ('r4', 'nope', 0, 5, 'decision', 1, '2026-10-05T00:02:00.000Z', 'standard',
            'review_standard', NULL, '1.0.0', NULL, 'sufficiency_gate', 'strong', 'low', '[]', '{}', '{}', '{}', NULL)`,
        ),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  it("版 3 の DB に版 4（reveal_reviews・review_followups）を当てても、reviews を含む既存の行は変わらない（D76）", () => {
    const legacyPath = join(dir, "v3.sqlite");
    const v3 = new DatabaseSync(legacyPath);
    const reviewRow = `('r1', 'h1', 0, 5, 'decision', 1, '2026-10-05T00:02:00.000Z', 'standard', 'review_standard',
      'claude-sonnet-5-5', '1.0.0', NULL, 'review_ai', 'reasonable', 'medium', '[]', '{}', '{}', '{}', NULL)`;
    try {
      for (const sql of MIGRATIONS.slice(0, 3)) v3.exec(sql);
      v3.exec("PRAGMA user_version = 3");
      v3.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
        INSERT INTO reviews VALUES ${reviewRow};
      `);
    } finally {
      v3.close();
    }
    const before = new DatabaseSync(legacyPath);
    const reviewsBefore = before.prepare("SELECT * FROM reviews").all();
    const schemaBefore = before
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'reviews'")
      .get();
    before.close();
    const db = openDatabase(legacyPath);
    try {
      expect(userVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare("SELECT * FROM reviews").all()).toEqual(reviewsBefore);
      // reviews の定義（列・CHECK）も変えない。
      expect(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'reviews'")
          .get(),
      ).toEqual(schemaBefore);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM reveal_reviews").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM review_followups").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("reveal_reviews は追記だけで Assessment の列を持たない。同じ Hand・判断の同じ Version は一意制約で拒否する（D39・LC-022）", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
      `);
      const columns = (
        db.prepare("PRAGMA table_info(reveal_reviews)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(columns).not.toContain("assessment");
      expect(columns).not.toContain("confidence");
      const insert = db.prepare(
        `INSERT INTO reveal_reviews VALUES (?, ?, 0, 5, ?, '2026-10-05T00:02:00.000Z', 'standard', 'review_standard',
          'claude-sonnet-5-5', ?, '{}', '{}', '{}', NULL)`,
      );
      insert.run("v1", "h1", 1, "review_ai");
      expect(() => insert.run("v2", "h1", 1, "review_ai")).toThrow(/UNIQUE/);
      expect(() => insert.run("v3", "h1", 2, "unknown")).toThrow(/CHECK/);
      expect(() => insert.run("v4", "nope", 1, "review_ai")).toThrow(
        /FOREIGN KEY/,
      );
      expect(() =>
        db.exec(
          "UPDATE reveal_reviews SET explanation = '{}' WHERE review_id = 'v1'",
        ),
      ).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("review_followups は実在する Review の Version（pass に合うテーブルの行）だけを指し、追記だけ", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
        INSERT INTO reviews VALUES ('r1', 'h1', 0, 5, 'decision', 1, '2026-10-05T00:02:00.000Z', 'standard', 'review_standard',
          'claude-sonnet-5-5', '1.0.0', NULL, 'review_ai', 'reasonable', 'medium', '[]', '{}', '{}', '{}', NULL);
        INSERT INTO reveal_reviews VALUES ('v1', 'h1', 0, 5, 1, '2026-10-05T00:03:00.000Z', 'standard', 'review_standard',
          'claude-sonnet-5-5', 'review_ai', '{}', '{}', '{}', NULL);
      `);
      const insert = db.prepare(
        `INSERT INTO review_followups VALUES (?, ?, ?, 'h1', 0, ?, ?, '2026-10-05T00:04:00.000Z', 'standard', 'review_standard',
          'claude-sonnet-5-5', 'review_ai', '質問', '{}', NULL)`,
      );
      insert.run("f1", "decision", "r1", 1, 1);
      insert.run("f2", "reveal", "v1", 1, 1);
      expect(() => insert.run("f3", "decision", "r1", 1, 1)).toThrow(/UNIQUE/);
      // Pass が合わない・Version が違う・無い Review は拒否する。
      for (const [pass, reviewId, version] of [
        ["reveal", "r1", 1],
        ["decision", "v1", 1],
        ["decision", "r1", 2],
        ["decision", "nope", 1],
      ] as const) {
        expect(() => insert.run("fx", pass, reviewId, version, 9)).toThrow(
          /existing review version/,
        );
      }
      expect(() =>
        db.exec(
          "UPDATE review_followups SET question = 'x' WHERE followup_id = 'f1'",
        ),
      ).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("events・reviews・reveal_reviews・review_followups は DELETE を Trigger で拒否する（追記専用。D37・D39・D99）", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
        INSERT INTO events VALUES ('e1', 'h1', 0, 'HAND_STARTED', 6, '2026-10-05T00:00:00.000Z', '{"type":"HAND_STARTED"}');
        INSERT INTO reviews VALUES ('r1', 'h1', 0, 5, 'decision', 1, '2026-10-05T00:02:00.000Z', 'standard', 'review_standard',
          'claude-sonnet-5-5', '1.0.0', NULL, 'review_ai', 'reasonable', 'medium', '[]', '{}', '{}', '{}', NULL);
        INSERT INTO reveal_reviews VALUES ('v1', 'h1', 0, 5, 1, '2026-10-05T00:03:00.000Z', 'standard', 'review_standard',
          'claude-sonnet-5-5', 'review_ai', '{}', '{}', '{}', NULL);
        INSERT INTO review_followups VALUES ('f1', 'reveal', 'v1', 'h1', 0, 1, 1, '2026-10-05T00:04:00.000Z', 'standard',
          'review_standard', 'claude-sonnet-5-5', 'review_ai', '質問', '{}', NULL);
      `);
      for (const table of [
        "review_followups",
        "reveal_reviews",
        "reviews",
        "events",
      ]) {
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(
          new RegExp(`${table} is append-only`),
        );
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
          n: 1,
        });
      }
    } finally {
      db.close();
    }
  });

  it("版 1 の DB に版 2（Session Projection）を当てても、既存の行は変わらない（D76・D95）", () => {
    // 版 1 だけを当てた DB（このアプリの前の版で作った DB）に行を入れる。
    const legacyPath = join(dir, "legacy.sqlite");
    const v1 = new DatabaseSync(legacyPath);
    try {
      v1.exec(MIGRATIONS[0] as string);
      v1.exec("PRAGMA user_version = 1");
      v1.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
        INSERT INTO events VALUES ('e1', 'h1', 0, 'HAND_STARTED', 5, '2026-10-05T00:00:00.000Z', '{"type":"HAND_STARTED"}');
      `);
    } finally {
      v1.close();
    }
    const db = openDatabase(legacyPath);
    try {
      expect(userVersion(db)).toBe(MIGRATIONS.length);
      expect(db.prepare("SELECT * FROM sessions").all()).toEqual([
        { session_id: "s1", started_at: "2026-10-05T00:00:00.000Z" },
      ]);
      expect(
        db.prepare("SELECT hand_id, finished_at FROM hands").all(),
      ).toEqual([{ hand_id: "h1", finished_at: "2026-10-05T00:01:00.000Z" }]);
      expect(
        db
          .prepare("SELECT event_id, schema_version, payload FROM events")
          .all(),
      ).toEqual([
        {
          event_id: "e1",
          schema_version: 5,
          payload: '{"type":"HAND_STARTED"}',
        },
      ]);
      // 前の版の Session には Projection が無い（作り直さない。Resume の対象にならない）。
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM session_projections").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("Session Projection は終わった Session だけが理由を持つ（state と end_reason の組を CHECK で守る）", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(`
        INSERT INTO sessions VALUES ('s1', '2026-10-05T00:00:00.000Z');
        INSERT INTO hands VALUES ('h1', 's1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:01:00.000Z');
      `);
      const insert = db.prepare(
        "INSERT INTO session_projections VALUES ('s1', 'h1', ?, ?, '[]', '{}', '[]', '2026-10-05T00:01:00.000Z')",
      );
      expect(() => insert.run("ended", null)).toThrow(/CHECK/);
      expect(() => insert.run("ready_for_next_hand", "ai_outage")).toThrow(
        /CHECK/,
      );
      expect(() => insert.run("ended", "unknown")).toThrow(/CHECK/);
      insert.run("ended", "ai_outage");
    } finally {
      db.close();
    }
  });

  it("開き直しても当て直さない（2 回目は何もしない）", () => {
    openDatabase(dbPath).close();
    const db = openDatabase(dbPath);
    try {
      expect(userVersion(db)).toBe(MIGRATIONS.length);
    } finally {
      db.close();
    }
  });

  it("このアプリより新しい版の DB は開かない", () => {
    const db = openDatabase(dbPath);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    expect(() => openDatabase(dbPath)).toThrow(UnsupportedDatabaseVersionError);
  });

  it(":memory: はファイルを作らずに使える", () => {
    const db = openDatabase(":memory:");
    try {
      expect(userVersion(db)).toBe(MIGRATIONS.length);
    } finally {
      db.close();
    }
  });
});
