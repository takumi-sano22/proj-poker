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
      "session_projections",
      "sessions",
    ]);
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
