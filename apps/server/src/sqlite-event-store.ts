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
  type AppendContext,
  type EventStore,
  type StoredHandEvent,
} from "./event-store.js";

/**
 * 保存する Event（payload）の形の版。Engine の HandEvent の形を互換の無い形で変えたら上げる。
 * 読み出しはこの版と、upcast を持つ旧版だけを受け付け、知らない版は UnsupportedEventSchemaError にする（D76・docs/04 §3）。
 * - 1: Phase 1（単一 Pot）
 * - 2: POT_AWARDED を Pot ごとに発行し、potIndex と eligible を持つ（D78）。版 1 は読み込み時に upcast する
 * - 3: HAND_STARTED に reopenRule（Short All-in の後の Raise の再開規則）を持つ（D79）。版 1・2 は読み込み時に upcast する
 * - 4: CPU の判断の経緯 AI_ACTION_INVALID / AI_FALLBACK_USED を足す（D83）。既存の Event の形は変えていないので、
 *   版 3 の行は変換せずに読む（版 1〜3 の行にこの 2 種類は無い）
 * - 5: Hero の宣言・Chip の操作・Dealer の裁定 PLAYER_DECLARED / PHYSICAL_CHIP_ACTION / DEALER_RULING を足す（D90）。
 *   既存の Event の形は変えていないので、版 4 の行も変換せずに読む（版 1〜4 の行にこの 3 種類は無い）
 */
export const EVENT_SCHEMA_VERSION = 5;

/** 保存済みの Event の schema_version を、このアプリが読めない。 */
export class UnsupportedEventSchemaError extends Error {
  override readonly name = "UnsupportedEventSchemaError";
}

export interface SqliteEventStoreOptions {
  readonly now?: () => Date;
  readonly newEventId?: () => string;
  /** 追記で Session を指定しなかった Hand の Session。省略時は新しい UUID。 */
  readonly sessionId?: string;
}

interface EventRow {
  event_id: string;
  hand_id: string;
  schema_version: number;
  recorded_at: string;
  payload: string;
}

/** まだ HAND_FINISHED に達していない Hand（メモリだけ）。Session は Hand の最初の追記で決まる。 */
interface PendingHand {
  readonly sessionId: string;
  readonly log: StoredHandEvent[];
}

export class SqliteEventStore implements EventStore {
  private readonly pending = new Map<string, PendingHand>();
  private readonly now: () => Date;
  private readonly newEventId: () => string;
  private readonly defaultSessionId: string;
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
    this.defaultSessionId = options.sessionId ?? randomUUID();
    // Session の行は、その Session で最初に Hand を保存するときに作る（Hand の無い Session を残さない）。
    // started_at はその Hand の開始時刻（Session の最初の Hand の開始＝Session の開始）。
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
    context: AppendContext = {},
  ): readonly StoredHandEvent[] {
    const pending = this.pending.get(handId);
    if (pending === undefined && this.selectHand.get(handId) !== undefined) {
      // 保存済み＝HAND_FINISHED まで済んだ Hand。その後ろへは追記させない。
      throw new EventSeqConflictError(
        `Hand ${handId} は終了して保存済みのため追記できない`,
      );
    }
    const log = pending?.log ?? [];
    const sessionId =
      pending?.sessionId ?? context.sessionId ?? this.defaultSessionId;
    assertAppendable(handId, log, events);

    const stored = toStoredEvents(
      handId,
      events,
      this.now().toISOString(),
      this.newEventId,
    );
    const next = [...log, ...stored];
    if (events.at(-1)?.type !== "HAND_FINISHED") {
      this.pending.set(handId, { sessionId, log: next });
    } else {
      // 書き込みに失敗したら例外のまま返し、メモリ側も変えない（Hand は未完了のまま残る）。
      this.persist(handId, sessionId, next);
      this.pending.delete(handId);
    }
    return stored;
  }

  read(handId: string): readonly StoredHandEvent[] {
    const pending = this.pending.get(handId);
    // 呼び出し側が配列を書き換えても Log が変わらないよう、写しを返す。
    if (pending !== undefined) return [...pending.log];
    return this.readPersisted(handId);
  }

  /** DB を閉じる。以降は使えない。途中の Hand（メモリ側）は保存されずに消える（D62）。 */
  close(): void {
    this.pending.clear();
    if (this.db.isOpen) this.db.close();
  }

  /** 終わった Hand の全 Event を 1 トランザクションで書く。 */
  private persist(
    handId: string,
    sessionId: string,
    log: readonly StoredHandEvent[],
  ): void {
    const first = log[0];
    const last = log.at(-1);
    if (first === undefined || last === undefined) return;
    inTransaction(this.db, () => {
      this.insertSession.run(sessionId, first.recordedAt);
      this.insertHand.run(handId, sessionId, first.recordedAt, last.recordedAt);
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
    // 版 2 → 3 は 1 Event ずつ変換できるので、版 3 未満の行にだけ通す。版 3 → 4・4 → 5 は変換が要らない（Event の種類を足しただけ）。
    const parsed = rows.map((row) => JSON.parse(row.payload) as HandEventV1);
    const asV2 = rows.some((row) => row.schema_version === 1)
      ? upcastV1ToV2(parsed)
      : null;
    const toCurrent = (row: EventRow, i: number): HandEvent => {
      // 版 3 以上は reopenRule を持つ。補う変換に通すと保存した値を上書きするので、そのまま返す。
      if (row.schema_version >= 3) {
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
