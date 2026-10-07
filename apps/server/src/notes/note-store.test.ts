// Note / Tag の Store（D31・D112・#115）。メモリ内と SQLite（v5）の実装が同じ振る舞いになることと、
// 削除・Tag の付け外しが行の追記で表され、保存済みの行を書き換えないことを確かめる。
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import {
  InMemoryNoteStore,
  normalizeNoteBody,
  normalizeTag,
  NOTE_BODY_MAX,
  SqliteNoteStore,
  TAG_MAX,
  type NoteStore,
  type NoteStoreOptions,
} from "./note-store.js";
import type { SubjectRef } from "./subject.js";

const CPU1: SubjectRef = {
  kind: "session_player",
  sessionId: "s1",
  playerId: "cpu1",
};
const CPU2: SubjectRef = { ...CPU1, playerId: "cpu2" };
// 同じ席でも別の Session は別の対象（席の playerId を永続の Identity とみなさない。D105）。
const CPU1_NEXT_SESSION: SubjectRef = { ...CPU1, sessionId: "s2" };

function options(): NoteStoreOptions {
  let tick = 0;
  let id = 0;
  return {
    now: () => new Date(Date.UTC(2026, 9, 7, 0, 0, tick++)),
    newNoteId: () => `n${++id}`,
  };
}

const implementations: [
  string,
  () => { store: NoteStore; db?: DatabaseSync },
][] = [
  ["メモリ内", () => ({ store: new InMemoryNoteStore(options()) })],
  [
    "SQLite",
    () => {
      const db = openDatabase(":memory:");
      return { store: new SqliteNoteStore(db, options()), db };
    },
  ],
];

describe.each(implementations)("NoteStore（%s）", (_name, create) => {
  it("Note を書いた順に返し、対象（Session と席の組）ごとに分ける", () => {
    const { store } = create();
    const first = store.addNote(CPU1, "  River の大きい Bet は Value 寄り  ");
    store.addNote(CPU1, "Preflop は広く Call する");
    store.addNote(CPU2, "Tight");
    expect(first).toEqual({
      noteId: "n1",
      body: "River の大きい Bet は Value 寄り",
      createdAt: "2026-10-07T00:00:00.000Z",
    });
    expect(store.notesOf(CPU1).notes.map((n) => n.body)).toEqual([
      "River の大きい Bet は Value 寄り",
      "Preflop は広く Call する",
    ]);
    expect(store.notesOf(CPU2).notes.map((n) => n.body)).toEqual(["Tight"]);
    expect(store.notesOf(CPU1_NEXT_SESSION)).toEqual({ notes: [], tags: [] });
  });

  it("noteId を渡した追加は冪等: 同じ noteId の再送は行を足さず最初の Note を返し、別の対象の noteId なら null", () => {
    const { store, db } = create();
    const first = added(store.addNote(CPU1, "Value 寄り", "id-1"));
    expect(first.noteId).toBe("id-1");
    expect(store.addNote(CPU1, "Value 寄り", "id-1")).toEqual(first);
    expect(store.addNote(CPU2, "別の席", "id-1")).toBeNull();
    expect(store.notesOf(CPU1).notes).toEqual([first]);
    expect(store.notesOf(CPU2).notes).toEqual([]);
    if (db !== undefined) {
      expect(db.prepare("SELECT COUNT(*) AS n FROM user_notes").get()).toEqual({
        n: 1,
      });
    }
  });

  it("Note の削除は tombstone の行を足して表し、消した Note は返さない。別の対象・消した Note は消せない", () => {
    const { store, db } = create();
    const kept = added(store.addNote(CPU1, "残す"));
    const removed = added(store.addNote(CPU1, "消す"));
    expect(store.deleteNote(CPU2, removed.noteId)).toBe(false);
    expect(store.deleteNote(CPU1, removed.noteId)).toBe(true);
    expect(store.deleteNote(CPU1, removed.noteId)).toBe(false);
    expect(store.deleteNote(CPU1, "nope")).toBe(false);
    expect(store.notesOf(CPU1).notes).toEqual([kept]);
    if (db !== undefined) {
      // 行は消さず、次の revision に本文の無い行を足している。
      expect(
        db
          .prepare(
            "SELECT note_id, revision, body FROM user_notes ORDER BY seq",
          )
          .all(),
      ).toEqual([
        { note_id: kept.noteId, revision: 1, body: "残す" },
        { note_id: removed.noteId, revision: 1, body: "消す" },
        { note_id: removed.noteId, revision: 2, body: null },
      ]);
    }
  });

  it("Tag の付け外しは add / remove の行で表し、最後に付けた順に今の Tag を返す。付いている Tag の add・付いていない Tag の remove は行を足さない", () => {
    const { store, db } = create();
    store.addTag(CPU1, "Loose");
    store.addTag(CPU1, " Aggressive ");
    store.addTag(CPU1, "Loose");
    expect(store.notesOf(CPU1).tags).toEqual(["Loose", "Aggressive"]);
    expect(store.removeTag(CPU1, "Loose")).toBe(true);
    expect(store.removeTag(CPU1, "Loose")).toBe(false);
    expect(store.removeTag(CPU2, "Aggressive")).toBe(false);
    store.addTag(CPU1, "Loose");
    expect(store.notesOf(CPU1).tags).toEqual(["Aggressive", "Loose"]);
    expect(store.notesOf(CPU2).tags).toEqual([]);
    if (db !== undefined) {
      expect(
        db.prepare("SELECT tag, op FROM user_tags ORDER BY seq").all(),
      ).toEqual([
        { tag: "Loose", op: "add" },
        { tag: "Aggressive", op: "add" },
        { tag: "Loose", op: "remove" },
        { tag: "Loose", op: "add" },
      ]);
    }
  });

  it("検証を通らない本文・Tag は呼び出し側の誤りとして投げ、行を足さない", () => {
    const { store } = create();
    expect(() => store.addNote(CPU1, "   ")).toThrow(RangeError);
    expect(() => store.addTag(CPU1, "a\nb")).toThrow(RangeError);
    expect(store.notesOf(CPU1)).toEqual({ notes: [], tags: [] });
  });
});

describe("SqliteNoteStore の永続化", () => {
  it("同じ DB を開き直した Store から同じ Note / Tag を読む", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteNoteStore(db, options());
    store.addNote(CPU1, "Value 寄り");
    store.addTag(CPU1, "Loose");
    expect(new SqliteNoteStore(db).notesOf(CPU1)).toEqual(store.notesOf(CPU1));
    db.close();
  });
});

describe("normalizeNoteBody / normalizeTag", () => {
  it("前後の空白を除き、空・上限超えを null にする", () => {
    expect(normalizeNoteBody(" a ")).toBe("a");
    expect(normalizeNoteBody(" ")).toBeNull();
    expect(normalizeNoteBody("あ".repeat(NOTE_BODY_MAX))).not.toBeNull();
    expect(normalizeNoteBody("あ".repeat(NOTE_BODY_MAX + 1))).toBeNull();
    expect(normalizeTag(" Loose ")).toBe("Loose");
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("a\nb")).toBeNull();
    expect(normalizeTag("あ".repeat(TAG_MAX + 1))).toBeNull();
  });
});

/** 追加できた Note（null なら失敗にする）。 */
function added<T>(note: T | null): T {
  if (note === null) throw new Error("Note を追加できなかった");
  return note;
}
