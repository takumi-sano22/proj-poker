// Note / Tag の Subject（D105・D118・#136）。cpu_profile の kind を足しても、既存の session_player の鍵（保存済みの行の subject_key）は
// バイト単位で変わらないこと、保存済みの行を書き換えずに Session の参加者から永続の CPU へ引けることを確かめる。
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import type { SessionParticipant } from "../opponents/cpu-pool.js";
import { SqliteNoteStore } from "./note-store.js";
import {
  persistentSubjectOf,
  subjectKey,
  type SessionPlayerSubject,
} from "./subject.js";

const CPU1: SessionPlayerSubject = {
  kind: "session_player",
  sessionId: "s1",
  playerId: "cpu1",
};

const PARTICIPANTS: readonly SessionParticipant[] = [
  {
    playerId: "cpu1",
    kind: "fixed",
    cpuProfileId: "fixed_aki",
    poolVersion: "phase7_pool_v1",
  },
  {
    playerId: "cpu2",
    kind: "guest",
    guestId: "guest/s1/cpu2",
    poolVersion: "phase7_pool_v1",
  },
];

describe("subjectKey", () => {
  it("session_player の鍵は #115 の形のまま（保存済みの subject_key とバイト単位で同じ）", () => {
    expect(subjectKey(CPU1)).toBe('["session_player","s1","cpu1"]');
    // 文字を含む値も JSON の配列のまま（区切りの文字で衝突しない）。
    expect(
      subjectKey({
        kind: "session_player",
        sessionId: 'a","b',
        playerId: "c",
      }),
    ).toBe('["session_player","a\\",\\"b","c"]');
  });

  it("cpu_profile の鍵は kind を先頭に置き、session_player の鍵と衝突しない", () => {
    expect(subjectKey({ kind: "cpu_profile", cpuProfileId: "fixed_aki" })).toBe(
      '["cpu_profile","fixed_aki"]',
    );
    expect(subjectKey({ kind: "cpu_profile", cpuProfileId: "s1" })).not.toBe(
      subjectKey(CPU1),
    );
  });
});

describe("persistentSubjectOf", () => {
  it("Fixed CPU の席は cpu_profile、Guest・参加者の無い席（Hero・v10 より前の Session）は null", () => {
    expect(persistentSubjectOf(CPU1, PARTICIPANTS)).toEqual({
      kind: "cpu_profile",
      cpuProfileId: "fixed_aki",
    });
    expect(
      persistentSubjectOf({ ...CPU1, playerId: "cpu2" }, PARTICIPANTS),
    ).toBeNull();
    expect(
      persistentSubjectOf({ ...CPU1, playerId: "hero" }, PARTICIPANTS),
    ).toBeNull();
    expect(persistentSubjectOf(CPU1, [])).toBeNull();
  });

  it("保存済みの session_player の行を書き換えずに、永続の CPU の対象を引ける（cpu_profile の行は同じ列に入る）", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteNoteStore(db);
      store.addNote(CPU1, "River は Value 寄り");
      store.addTag(CPU1, "tight");
      const before = db.prepare("SELECT * FROM user_notes").all();

      const persistent = persistentSubjectOf(CPU1, PARTICIPANTS);
      if (persistent === null) throw new Error("Fixed CPU を引けない");
      store.addTag(persistent, "regular");
      // 既存の行はそのまま、session_player の対象で同じように読める。
      expect(
        db
          .prepare("SELECT * FROM user_notes WHERE subject_key = ?")
          .all(subjectKey(CPU1)),
      ).toEqual(before);
      expect(store.notesOf(CPU1).tags).toEqual(["tight"]);
      expect(store.notesOf(persistent).tags).toEqual(["regular"]);
      expect(
        db
          .prepare("SELECT subject_key, subject FROM user_tags ORDER BY seq")
          .all(),
      ).toEqual([
        {
          subject_key: '["session_player","s1","cpu1"]',
          subject: JSON.stringify(CPU1),
        },
        {
          subject_key: '["cpu_profile","fixed_aki"]',
          subject: '{"kind":"cpu_profile","cpuProfileId":"fixed_aki"}',
        },
      ]);
    } finally {
      db.close();
    }
  });
});
