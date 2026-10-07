// SQLite の Event Store（D72）。Interface は EventStore（event-store.ts）と同じで、Orchestrator からは差し替えるだけ。
// 保存の境界は Completed Hand（D62・docs/04 §10）: Hand 途中の Event はメモリに持ち、
// HAND_FINISHED を追記した時点でその Hand の全 Event を 1 トランザクションで SQLite へ書く。
// 再起動すると途中の Hand は消え、終わった Hand だけが残る（Hand 途中の完全復帰は要求しない）。
// Hand の終わりは HAND_FINISHED か、AI 障害の後の打ち切り HAND_ABORTED（D95）。同じトランザクションで、その Session の
// Session Projection（session-projection.ts）も書き替える（docs/04 §10。再起動後の Resume に使う）。
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
  endedSessionGuard,
  EventSeqConflictError,
  isHandEnd,
  summarizeLog,
  toStoredEvents,
  type AppendContext,
  type EventStore,
  type StoredHandEvent,
  type StoredHandSummary,
} from "./event-store.js";
import {
  nextSessionProjection,
  type SessionProjection,
} from "./session-projection.js";

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
 * - 6: Session の開始・終了・Hand の打ち切り・Emergency Bot への切り替え SESSION_STARTED / SESSION_ENDED / HAND_ABORTED /
 *   EMERGENCY_BOT_ENGAGED を足す（D95）。既存の Event の形は変えていないので、版 5 の行も変換せずに読む（版 1〜5 の行にこの 4 種類は無い）
 * - 7: Hand ごとの Best-effort Metadata HAND_METADATA_RECORDED を足す（#97）。既存の Event の形は変えていないので、版 6 の行も
 *   変換せずに読む（版 1〜6 の行にこの種類は無く、作り直しもしない）
 * - 8: Hero の User Read USER_READ_RECORDED を足す（D112・#115）。既存の Event の形は変えていないので、版 7 の行も変換せずに読む
 *   （版 1〜7 の行にこの種類は無い）
 */
export const EVENT_SCHEMA_VERSION = 8;

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

interface HandRow {
  hand_id: string;
  started_at: string;
  finished_at: string;
  /** HAND_ABORTED で終えた Hand なら 1。 */
  aborted: number;
}

interface SessionProjectionRow {
  session_id: string;
  last_hand_id: string;
  state: SessionProjection["state"];
  end_reason: SessionProjection["endReason"];
  stacks: string;
  personas: string;
  emergency_bots: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  hand_id: string;
  schema_version: number;
  recorded_at: string;
  payload: string;
}

/** まだ終わっていない Hand（メモリだけ）。Session と Persona の割り当ては Hand の最初の追記で決まる。 */
interface PendingHand {
  readonly sessionId: string;
  readonly personas: Readonly<Record<string, string>>;
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
  private readonly selectRecentHands: StatementSync;
  private readonly selectProjection: StatementSync;
  private readonly selectLatestProjection: StatementSync;
  private readonly upsertProjection: StatementSync;

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
    // 同じ時刻に始まった Hand は、保存した順（rowid）の新しい方を先にする。
    // 打ち切った Hand（HAND_ABORTED を持つ）は Event の type で見分ける（hands の列は変えない。D95）。
    this.selectRecentHands = db.prepare(
      `SELECT h.hand_id, h.started_at, h.finished_at,
         EXISTS (SELECT 1 FROM events e WHERE e.hand_id = h.hand_id AND e.type = 'HAND_ABORTED') AS aborted
       FROM hands h ORDER BY h.started_at DESC, h.rowid DESC LIMIT ?`,
    );
    const projectionColumns =
      "session_id, last_hand_id, state, end_reason, stacks, personas, emergency_bots, updated_at";
    this.selectProjection = db.prepare(
      `SELECT ${projectionColumns} FROM session_projections WHERE session_id = ?`,
    );
    // 最後に Hand が終わった Session。同じ時刻なら、先に作った行（rowid）より後の Session を選ぶ。
    this.selectLatestProjection = db.prepare(
      `SELECT ${projectionColumns} FROM session_projections ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    );
    // Session Projection は Session ごとに 1 行で、Hand が終わるたびに書き替える（派生データ。正本は Event Log）。
    this.upsertProjection = db.prepare(
      `INSERT INTO session_projections (${projectionColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET
         last_hand_id = excluded.last_hand_id,
         state = excluded.state,
         end_reason = excluded.end_reason,
         stacks = excluded.stacks,
         personas = excluded.personas,
         emergency_bots = excluded.emergency_bots,
         updated_at = excluded.updated_at`,
    );
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
    const personas = pending?.personas ?? context.personas ?? {};
    assertAppendable(handId, log, events);

    const stored = toStoredEvents(
      handId,
      events,
      this.now().toISOString(),
      this.newEventId,
    );
    const next = [...log, ...stored];
    if (!events.some(isHandEnd)) {
      this.pending.set(handId, { sessionId, personas, log: next });
    } else {
      // 書き込みに失敗したら例外のまま返し、メモリ側も変えない（Hand は未完了のまま残る）。
      this.persist(handId, sessionId, personas, next);
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

  /**
   * 保存済みの Hand（HAND_FINISHED か打ち切りの HAND_ABORTED まで済んだ Hand）と、メモリにだけある Hand（進行中・内部エラーで
   * 止まった Hand。D62）を合わせて、開始の新しい順に最大 limit 件返す。メモリの Hand は再起動で消えるので、一覧からも消える。
   */
  listHands(limit: number): readonly StoredHandSummary[] {
    const persisted = (
      this.selectRecentHands.all(limit) as unknown as HandRow[]
    ).map((row): StoredHandSummary => {
      const aborted = row.aborted === 1;
      return {
        handId: row.hand_id,
        startedAt: row.started_at,
        // hands.finished_at は Hand の終わりの時刻。打ち切った Hand は HAND_FINISHED を持たないので null にする。
        finishedAt: aborted ? null : row.finished_at,
        aborted,
      };
    });
    // メモリの Hand は追記した順なので、逆順が開始の新しい順。sort は安定なので同じ時刻ならこの順を保つ。
    const pending = [...this.pending.entries()]
      .reverse()
      .map(([handId, p]) => summarizeLog(handId, p.log));
    return [...pending, ...persisted]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  latestSessionProjection(): SessionProjection | null {
    const row = this.selectLatestProjection.get() as unknown as
      SessionProjectionRow | undefined;
    return row === undefined ? null : toProjection(row);
  }

  /** DB を閉じる。以降は使えない。途中の Hand（メモリ側）は保存されずに消える（D62）。 */
  close(): void {
    this.pending.clear();
    if (this.db.isOpen) this.db.close();
  }

  /** 終わった Hand の全 Event と、その Session の Session Projection を 1 トランザクションで書く。 */
  private persist(
    handId: string,
    sessionId: string,
    personas: Readonly<Record<string, string>>,
    log: readonly StoredHandEvent[],
  ): void {
    const first = log[0];
    const last = log.at(-1);
    if (first === undefined || last === undefined) return;
    inTransaction(this.db, () => {
      // 前の Projection は同じトランザクション（BEGIN IMMEDIATE で書き込みを排他）の中で読む。
      const previous = this.selectProjection.get(sessionId) as unknown as
        SessionProjectionRow | undefined;
      const projection = nextSessionProjection(
        endedSessionGuard(
          previous === undefined ? null : toProjection(previous),
        ),
        {
          sessionId,
          handId,
          events: log.map((s) => s.event),
          personas,
          recordedAt: last.recordedAt,
        },
      );
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
      this.upsertProjection.run(
        projection.sessionId,
        projection.lastHandId,
        projection.state,
        projection.endReason,
        JSON.stringify(projection.stacks),
        JSON.stringify(projection.personas),
        JSON.stringify(projection.emergencyBots),
        projection.updatedAt,
      );
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
    // 版 2 → 3 は 1 Event ずつ変換できるので、版 3 未満の行にだけ通す。版 3 → 4・4 → 5・5 → 6・6 → 7・7 → 8 は変換が要らない
    // （Event の種類を足しただけ）。
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

/** Session Projection の行を読む（JSON の列を戻す）。 */
function toProjection(row: SessionProjectionRow): SessionProjection {
  return {
    sessionId: row.session_id,
    lastHandId: row.last_hand_id,
    state: row.state,
    endReason: row.end_reason,
    stacks: JSON.parse(row.stacks) as SessionProjection["stacks"],
    personas: JSON.parse(row.personas) as SessionProjection["personas"],
    emergencyBots: JSON.parse(
      row.emergency_bots,
    ) as SessionProjection["emergencyBots"],
    updatedAt: row.updated_at,
  };
}
