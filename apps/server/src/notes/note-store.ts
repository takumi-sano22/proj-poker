// Hero の Note / Tag の Store（D31・D112・#115）。Note / Tag は Hand に属さない Hero の入力なので、Event Log ではなく追記型のテーブル
// （マイグレーション v5 の user_notes / user_tags）に置く。行は書き換えず消さない（UPDATE / DELETE は Trigger で拒否する）。
// - Note の削除は、同じ note_id の次の revision に本文の無い行（tombstone）を足して表す。編集を足すときも次の revision の行にする
// - Tag の付け外しは、add / remove の行を足して表し、対象と Tag ごとに最後の行で今の状態を決める
// 今の Note / Tag はこの行の列から作る派生（projectSubjectNotes）で、保存しない。
// Note / Tag は Hero だけのもので、CPU の KnowledgeState・Prompt・CPU Memory、Review の Evidence には渡さない（不変条件 2・D105）。
// Learning Reset でも Opponent Memory Reset でも消さない（D114）。
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { inTransaction } from "../db/database.js";
import { subjectKey, type SubjectRef } from "./subject.js";

/** Note の本文の上限（字）。CPU 1 人ごとの自由記述として十分な長さの暫定値（v5 の CHECK と同じ値）。 */
export const NOTE_BODY_MAX = 500;
/** Tag の上限（字）。短いラベルとして十分な長さの暫定値（v5 の CHECK と同じ値）。 */
export const TAG_MAX = 20;

/** 今の Note 1 つ。noteId は revision をまたいで同じ。 */
export interface SubjectNote {
  readonly noteId: string;
  readonly body: string;
  /** 最初に書いた時刻（ISO 8601・UTC）。 */
  readonly createdAt: string;
}

/** ある対象の今の Note（書いた順）と Tag（付けた順）。 */
export interface SubjectNotes {
  readonly notes: readonly SubjectNote[];
  readonly tags: readonly string[];
}

export interface NoteStore {
  /**
   * Note を足す。noteId を渡すと、その ID の Note がすでにあれば行を足さない（応答が失われた追加の再送を冪等にする）。
   * 同じ対象の Note ならその最初の revision を返し、別の対象の Note の ID なら null（何も足さない）。
   */
  addNote(
    subject: SubjectRef,
    body: string,
    noteId?: string,
  ): SubjectNote | null;
  /** Note を消す（tombstone の行を足す）。その対象の今ある Note でなければ false（行を足さない）。 */
  deleteNote(subject: SubjectRef, noteId: string): boolean;
  /** Tag を付ける。もう付いていれば行を足さない。 */
  addTag(subject: SubjectRef, tag: string): void;
  /** Tag を外す。付いていなければ false（行を足さない）。 */
  removeTag(subject: SubjectRef, tag: string): boolean;
  notesOf(subject: SubjectRef): SubjectNotes;
}

/** Note の本文を前後の空白を除いて検証する。空・長すぎるなら null。 */
export function normalizeNoteBody(body: string): string | null {
  const trimmed = body.trim();
  return trimmed.length === 0 || trimmed.length > NOTE_BODY_MAX
    ? null
    : trimmed;
}

/** Tag を前後の空白を除いて検証する。空・長すぎる・改行を含むなら null。 */
export function normalizeTag(tag: string): string | null {
  const trimmed = tag.trim();
  return trimmed.length === 0 ||
    trimmed.length > TAG_MAX ||
    /[\r\n]/.test(trimmed)
    ? null
    : trimmed;
}

/** user_notes の 1 行（seq は追記の順）。body が null の行は削除（tombstone）。 */
export interface NoteRow {
  readonly seq: number;
  readonly noteId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly body: string | null;
}

/** user_tags の 1 行（seq は追記の順）。 */
export interface TagRow {
  readonly seq: number;
  readonly tag: string;
  readonly op: "add" | "remove";
}

/** ある対象の行（追記の順）から今の Note / Tag を作る。 */
export function projectSubjectNotes(
  noteRows: readonly NoteRow[],
  tagRows: readonly TagRow[],
): SubjectNotes {
  const sorted = [...noteRows].sort((a, b) => a.seq - b.seq);
  const firstAt = new Map<string, string>();
  const latest = new Map<string, NoteRow>();
  for (const row of sorted) {
    if (!firstAt.has(row.noteId)) firstAt.set(row.noteId, row.createdAt);
    latest.set(row.noteId, row);
  }
  const notes: SubjectNote[] = [];
  for (const [noteId, row] of latest) {
    if (row.body === null) continue;
    notes.push({
      noteId,
      body: row.body,
      createdAt: firstAt.get(noteId) ?? row.createdAt,
    });
  }
  // Tag ごとの最後の行で今の状態を決め、付いている Tag を最後に付けた順に並べる。
  const lastOp = new Map<string, TagRow>();
  for (const row of [...tagRows].sort((a, b) => a.seq - b.seq)) {
    lastOp.delete(row.tag);
    lastOp.set(row.tag, row);
  }
  const tags = [...lastOp.values()]
    .filter((row) => row.op === "add")
    .map((row) => row.tag);
  return { notes, tags };
}

export interface NoteStoreOptions {
  readonly now?: () => Date;
  readonly newNoteId?: () => string;
}

/** プロセス内のメモリだけに持つ実装（テスト用。再起動で消える）。 */
export class InMemoryNoteStore implements NoteStore {
  private readonly noteRows = new Map<string, NoteRow[]>();
  private readonly tagRows = new Map<string, TagRow[]>();
  private seq = 0;
  private readonly now: () => Date;
  private readonly newNoteId: () => string;

  constructor(options: NoteStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newNoteId = options.newNoteId ?? randomUUID;
  }

  addNote(
    subject: SubjectRef,
    body: string,
    noteId?: string,
  ): SubjectNote | null {
    const normalized = requireBody(body);
    if (noteId !== undefined) {
      const key = subjectKey(subject);
      for (const [k, rows] of this.noteRows) {
        const first = rows.find((r) => r.noteId === noteId);
        if (first === undefined) continue;
        return k === key ? firstRevisionOf(first) : null;
      }
    }
    const row: NoteRow = {
      seq: ++this.seq,
      noteId: noteId ?? this.newNoteId(),
      revision: 1,
      createdAt: this.now().toISOString(),
      body: normalized,
    };
    rowsOf(this.noteRows, subjectKey(subject)).push(row);
    return firstRevisionOf(row);
  }

  deleteNote(subject: SubjectRef, noteId: string): boolean {
    const rows = rowsOf(this.noteRows, subjectKey(subject));
    const last = rows.filter((r) => r.noteId === noteId).at(-1);
    if (last === undefined || last.body === null) return false;
    rows.push({
      seq: ++this.seq,
      noteId,
      revision: last.revision + 1,
      createdAt: this.now().toISOString(),
      body: null,
    });
    return true;
  }

  addTag(subject: SubjectRef, tag: string): void {
    const normalized = requireTag(tag);
    if (this.notesOf(subject).tags.includes(normalized)) return;
    rowsOf(this.tagRows, subjectKey(subject)).push({
      seq: ++this.seq,
      tag: normalized,
      op: "add",
    });
  }

  removeTag(subject: SubjectRef, tag: string): boolean {
    const normalized = tag.trim();
    if (!this.notesOf(subject).tags.includes(normalized)) return false;
    rowsOf(this.tagRows, subjectKey(subject)).push({
      seq: ++this.seq,
      tag: normalized,
      op: "remove",
    });
    return true;
  }

  notesOf(subject: SubjectRef): SubjectNotes {
    const key = subjectKey(subject);
    return projectSubjectNotes(
      this.noteRows.get(key) ?? [],
      this.tagRows.get(key) ?? [],
    );
  }
}

function rowsOf<T>(map: Map<string, T[]>, key: string): T[] {
  let rows = map.get(key);
  if (rows === undefined) {
    rows = [];
    map.set(key, rows);
  }
  return rows;
}

/** 呼び出し側（route）が検証済みの値を渡す前提。外れていれば呼び出し側の誤りなので投げる。 */
function requireBody(body: string): string {
  const normalized = normalizeNoteBody(body);
  if (normalized === null) {
    throw new RangeError(`Note の本文は空白を除いて 1〜${NOTE_BODY_MAX} 字`);
  }
  return normalized;
}

function requireTag(tag: string): string {
  const normalized = normalizeTag(tag);
  if (normalized === null) {
    throw new RangeError(`Tag は空白を除いて 1〜${TAG_MAX} 字で改行を含まない`);
  }
  return normalized;
}

interface NoteRowSql {
  seq: number;
  note_id: string;
  revision: number;
  created_at: string;
  body: string | null;
}

function toNoteRow(r: NoteRowSql): NoteRow {
  return {
    seq: r.seq,
    noteId: r.note_id,
    revision: r.revision,
    createdAt: r.created_at,
    body: r.body,
  };
}

/** 最初の revision の行を、返す Note の形にする（最初の revision は必ず本文を持つ）。 */
function firstRevisionOf(row: NoteRow): SubjectNote {
  return { noteId: row.noteId, body: row.body ?? "", createdAt: row.createdAt };
}

interface TagRowSql {
  seq: number;
  tag: string;
  op: "add" | "remove";
}

/** SQLite（user_notes / user_tags。マイグレーション v5）の実装。DB は Event Store と共有する。 */
export class SqliteNoteStore implements NoteStore {
  private readonly insertNote: StatementSync;
  private readonly insertTag: StatementSync;
  private readonly selectNotes: StatementSync;
  private readonly selectTags: StatementSync;
  private readonly selectFirstRevision: StatementSync;
  private readonly now: () => Date;
  private readonly newNoteId: () => string;

  constructor(
    private readonly db: DatabaseSync,
    options: NoteStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newNoteId = options.newNoteId ?? randomUUID;
    this.insertNote = db.prepare(
      "INSERT INTO user_notes (note_id, revision, created_at, subject_key, subject, body) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.insertTag = db.prepare(
      "INSERT INTO user_tags (created_at, subject_key, subject, tag, op) VALUES (?, ?, ?, ?, ?)",
    );
    this.selectNotes = db.prepare(
      "SELECT seq, note_id, revision, created_at, body FROM user_notes WHERE subject_key = ? ORDER BY seq",
    );
    this.selectTags = db.prepare(
      "SELECT seq, tag, op FROM user_tags WHERE subject_key = ? ORDER BY seq",
    );
    this.selectFirstRevision = db.prepare(
      "SELECT seq, note_id, revision, created_at, body, subject_key FROM user_notes WHERE note_id = ? AND revision = 1",
    );
  }

  addNote(
    subject: SubjectRef,
    body: string,
    noteId?: string,
  ): SubjectNote | null {
    const normalized = requireBody(body);
    const key = subjectKey(subject);
    // 同じ noteId の有無の確認と追記を 1 つの書き込みトランザクションにする（UNIQUE (note_id, revision) でも守る）。
    return inTransaction(this.db, () => {
      if (noteId !== undefined) {
        const first = this.selectFirstRevision.get(noteId) as
          (NoteRowSql & { subject_key: string }) | undefined;
        if (first !== undefined) {
          return first.subject_key === key
            ? firstRevisionOf(toNoteRow(first))
            : null;
        }
      }
      const id = noteId ?? this.newNoteId();
      const createdAt = this.now().toISOString();
      this.insertNote.run(
        id,
        1,
        createdAt,
        key,
        JSON.stringify(subject),
        normalized,
      );
      return { noteId: id, body: normalized, createdAt };
    });
  }

  deleteNote(subject: SubjectRef, noteId: string): boolean {
    // 最後の revision の読み取りと次の revision の追記を 1 つの書き込みトランザクションにする（同じ revision を 2 回足さない）。
    return inTransaction(this.db, () => {
      const last = this.noteRowsOf(subject)
        .filter((r) => r.noteId === noteId)
        .at(-1);
      if (last === undefined || last.body === null) return false;
      this.insertNote.run(
        noteId,
        last.revision + 1,
        this.now().toISOString(),
        subjectKey(subject),
        JSON.stringify(subject),
        null,
      );
      return true;
    });
  }

  addTag(subject: SubjectRef, tag: string): void {
    const normalized = requireTag(tag);
    inTransaction(this.db, () => {
      if (this.notesOf(subject).tags.includes(normalized)) return;
      this.insertTagRow(subject, normalized, "add");
    });
  }

  removeTag(subject: SubjectRef, tag: string): boolean {
    const normalized = tag.trim();
    return inTransaction(this.db, () => {
      if (!this.notesOf(subject).tags.includes(normalized)) return false;
      this.insertTagRow(subject, normalized, "remove");
      return true;
    });
  }

  notesOf(subject: SubjectRef): SubjectNotes {
    const tags = (
      this.selectTags.all(subjectKey(subject)) as unknown as TagRowSql[]
    ).map((r): TagRow => ({ seq: r.seq, tag: r.tag, op: r.op }));
    return projectSubjectNotes(this.noteRowsOf(subject), tags);
  }

  private noteRowsOf(subject: SubjectRef): NoteRow[] {
    return (
      this.selectNotes.all(subjectKey(subject)) as unknown as NoteRowSql[]
    ).map(toNoteRow);
  }

  private insertTagRow(
    subject: SubjectRef,
    tag: string,
    op: "add" | "remove",
  ): void {
    this.insertTag.run(
      this.now().toISOString(),
      subjectKey(subject),
      JSON.stringify(subject),
      tag,
      op,
    );
  }
}
