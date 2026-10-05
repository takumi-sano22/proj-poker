// SQLite の Event Store（D72）。Interface は EventStore（event-store.ts）と同じで、Orchestrator からは差し替えるだけ。
// 保存の境界は Completed Hand（D62・docs/04 §10）: Hand 途中の Event はメモリに持ち、
// HAND_FINISHED を追記した時点でその Hand の全 Event を 1 トランザクションで SQLite へ書く。
// 再起動すると途中の Hand は消え、終わった Hand だけが残る（Hand 途中の完全復帰は要求しない）。
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { HandEvent } from "@proj-poker/engine";
import { inTransaction, openDatabase } from "./db/database.js";
import {
  upcastV1ToV2,
  upcastV2ToV3,
  type HandEventV1,
  type HandEventV2,
} from "./event-upcast.js";
import {
  assertAppendable,
  deepFreeze,
  EventSeqConflictError,
  toStoredEvents,
  type EventStore,
  type StoredHandEvent,
} from "./event-store.js";

/**
 * 保存する Event（payload）の形の版。Engine の HandEvent の形を互換の無い形で変えたら上げる。
 * 読み出しはこの版と、upcast を持つ旧版だけを受け付け、知らない版は UnsupportedEventSchemaError にする（D76・docs/04 §3）。
 * - 1: Phase 1（単一 Pot）
 * - 2: POT_AWARDED を Pot ごとに発行し、potIndex と eligible を持つ（D78）。版 1 は読み込み時に upcast する
 * - 3: HAND_STARTED に reopenRule（Short All-in の後の Raise の再開規則）を持つ（D79）。版 1・2 は読み込み時に upcast する
 */
export const EVENT_SCHEMA_VERSION = 3;

/** 保存済みの Event の schema_version を、このアプリが読めない。 */
export class UnsupportedEventSchemaError extends Error {
  override readonly name = "UnsupportedEventSchemaError";
}

export interface SqliteEventStoreOptions {
  readonly now?: () => Date;
  readonly newEventId?: () => string;
  /** この Store が保存する Hand の Session。省略時は新しい UUID（起動ごとに 1 Session）。 */
  readonly sessionId?: string;
}

interface EventRow {
  event_id: string;
  hand_id: string;
  schema_version: number;
  recorded_at: string;
  payload: string;
}

export class SqliteEventStore implements EventStore {
  /** まだ HAND_FINISHED に達していない Hand の Event（メモリだけ）。 */
  private readonly pending = new Map<string, StoredHandEvent[]>();
  private readonly now: () => Date;
  private readonly newEventId: () => string;
  private readonly sessionId: string;
  private readonly sessionStartedAt: string;
  private readonly insertSession: StatementSync;
  private readonly insertHand: StatementSync;
  private readonly insertEvent: StatementSync;
  private readonly selectEvents: StatementSync;
  private readonly selectHand: StatementSync;

  /** DB ファイル（":memory:" も可）を開いてマイグレーションを当て、Store を作る。close で DB も閉じる。 */
  static open(
    path: string,
    options: SqliteEventStoreOptions = {},
  ): SqliteEventStore {
    return new SqliteEventStore(openDatabase(path), options);
  }

  constructor(
    private readonly db: DatabaseSync,
    options: SqliteEventStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newEventId = options.newEventId ?? randomUUID;
    this.sessionId = options.sessionId ?? randomUUID();
    this.sessionStartedAt = this.now().toISOString();
    // Session の行は、その Session で最初に Hand を保存するときに作る（Hand の無い Session を残さない）。
    this.insertSession = db.prepare(
      "INSERT OR IGNORE INTO sessions (session_id, started_at) VALUES (?, ?)",
    );
    this.insertHand = db.prepare(
      "INSERT INTO hands (hand_id, session_id, started_at, finished_at) VALUES (?, ?, ?, ?)",
    );
    this.insertEvent = db.prepare(
      "INSERT INTO events (event_id, hand_id, seq, type, schema_version, recorded_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.selectEvents = db.prepare(
      "SELECT event_id, hand_id, schema_version, recorded_at, payload FROM events WHERE hand_id = ? ORDER BY seq",
    );
    this.selectHand = db.prepare("SELECT 1 FROM hands WHERE hand_id = ?");
  }

  append(
    handId: string,
    events: readonly HandEvent[],
  ): readonly StoredHandEvent[] {
    const pending = this.pending.get(handId);
    if (pending === undefined && this.selectHand.get(handId) !== undefined) {
      // 保存済み＝HAND_FINISHED まで済んだ Hand。その後ろへは追記させない。
      throw new EventSeqConflictError(
        `Hand ${handId} は終了して保存済みのため追記できない`,
      );
    }
    const log = pending ?? [];
    assertAppendable(handId, log, events);

    const stored = toStoredEvents(
      handId,
      events,
      this.now().toISOString(),
      this.newEventId,
    );
    const next = [...log, ...stored];
    if (events.at(-1)?.type !== "HAND_FINISHED") {
      this.pending.set(handId, next);
    } else {
      // 書き込みに失敗したら例外のまま返し、メモリ側も変えない（Hand は未完了のまま残る）。
      this.persist(handId, next);
      this.pending.delete(handId);
    }
    return stored;
  }

  read(handId: string): readonly StoredHandEvent[] {
    const pending = this.pending.get(handId);
    // 呼び出し側が配列を書き換えても Log が変わらないよう、写しを返す。
    if (pending !== undefined) return [...pending];
    return this.readPersisted(handId);
  }

  /** DB を閉じる。以降は使えない。途中の Hand（メモリ側）は保存されずに消える（D62）。 */
  close(): void {
    this.pending.clear();
    if (this.db.isOpen) this.db.close();
  }

  /** 終わった Hand の全 Event を 1 トランザクションで書く。 */
  private persist(handId: string, log: readonly StoredHandEvent[]): void {
    const first = log[0];
    const last = log.at(-1);
    if (first === undefined || last === undefined) return;
    inTransaction(this.db, () => {
      this.insertSession.run(this.sessionId, this.sessionStartedAt);
      this.insertHand.run(
        handId,
        this.sessionId,
        first.recordedAt,
        last.recordedAt,
      );
      for (const s of log) {
        this.insertEvent.run(
          s.eventId,
          handId,
          s.event.seq,
          s.event.type,
          EVENT_SCHEMA_VERSION,
          s.recordedAt,
          JSON.stringify(s.event),
        );
      }
    });
  }

  private readPersisted(handId: string): StoredHandEvent[] {
    const rows = this.selectEvents.all(handId) as unknown as EventRow[];
    for (const row of rows) {
      if (
        !Number.isInteger(row.schema_version) ||
        row.schema_version < 1 ||
        row.schema_version > EVENT_SCHEMA_VERSION
      ) {
        // 旧形式を黙って新形式として扱わない（Replay / Review が誤った Event を読む）。
        throw new UnsupportedEventSchemaError(
          `Event ${row.event_id} の schema_version ${row.schema_version} は読めない（対応: 1〜${EVENT_SCHEMA_VERSION}）`,
        );
      }
    }
    // 版 1 の行は Hand の前の Event（Fold の有無）を見て upcast するので、Hand 単位でまとめて変換し、
    // 版 1 の行にだけ変換結果を使う（1 Hand は 1 トランザクションで同じ版で書くが、混在しても新しい版の行を変えない）。
    // 版 2 → 3 は 1 Event ずつ変換できるので、版 3 未満の行にだけ通す。
    const parsed = rows.map((row) => JSON.parse(row.payload) as HandEventV1);
    const asV2 = rows.some((row) => row.schema_version === 1)
      ? upcastV1ToV2(parsed)
      : null;
    const toCurrent = (row: EventRow, i: number): HandEvent => {
      if (row.schema_version === EVENT_SCHEMA_VERSION) {
        return parsed[i] as HandEvent;
      }
      const v2 =
        asV2 !== null && row.schema_version === 1
          ? (asV2[i] as HandEventV2)
          : (parsed[i] as HandEventV2);
      return upcastV2ToV3(v2);
    };
    return rows.map((row, i) =>
      deepFreeze({
        eventId: row.event_id,
        handId: row.hand_id,
        recordedAt: row.recorded_at,
        event: toCurrent(row, i),
      }),
    );
  }
}
