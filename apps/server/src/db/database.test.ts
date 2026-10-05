import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      "sessions",
    ]);
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
