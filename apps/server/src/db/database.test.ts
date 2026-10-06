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
      "hands",
      "reveal_reviews",
      "reveal_reviews_append_only",
      "review_followups",
      "review_followups_append_only",
      "review_followups_target",
      "reviews",
      "reviews_append_only",
      "session_projections",
      "sessions",
    ]);
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
