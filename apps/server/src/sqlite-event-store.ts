// SQLite の Event Store（D72）。Interface は EventStore（event-store.ts）と同じで、Orchestrator からは差し替えるだけ。
// 保存の境界は Completed Hand（D62・docs/04 §10）: Hand 途中の Event はメモリに持ち、
// HAND_FINISHED を追記した時点でその Hand の全 Event を 1 トランザクションで SQLite へ書く。
// 再起動すると途中の Hand は消え、終わった Hand だけが残る（Hand 途中の完全復帰は要求しない）。
// Hand の終わりは HAND_FINISHED か、AI 障害の後の打ち切り HAND_ABORTED（D95）。同じトランザクションで、その Session の
// Session Projection（session-projection.ts）も書き替える（docs/04 §10。再起動後の Resume に使う）。
// 同じトランザクションで ordinals（v9）に保存の論理順序の行を足す。Hand の順（Replay の一覧・Session 内の順・Recent の順・最新の Session）は
// この番号で決め、壁時計の列（started_at・finished_at・updated_at）では並べない（D117。OS の時刻は後ろへ戻ることがある）。
// Session の最初の Hand の保存では、同じトランザクションで CPU の席の参加者（Fixed CPU / Guest）を session_participants（v10）に足す（D118）。
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
import { MissingOrdinalError } from "./logical-order.js";
import type { SessionParticipant } from "./opponents/cpu-pool.js";
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
  /** 保存の論理順序（ordinals.ord。行が欠けていれば null）。 */
  ord: number | null;
}

/** Hand と保存の論理順序の番号（行が欠けていれば null）。 */
interface HandOrdinalRow {
  hand_id: string;
  ord: number | null;
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

/** 最新の Session Projection の行と、その最後の Hand の保存の論理順序（ordinals.ord。行が欠けていれば null）。 */
interface LatestProjectionRow extends SessionProjectionRow {
  ord: number | null;
}

interface ParticipantRow {
  player_id: string;
  kind: SessionParticipant["kind"];
  cpu_profile_id: string | null;
  guest_id: string | null;
  pool_version: string;
}

interface EventRow {
  event_id: string;
  hand_id: string;
  schema_version: number;
  recorded_at: string;
  payload: string;
}

/** まだ終わっていない Hand（メモリだけ）。Session と Persona の割り当てと参加者は Hand の最初の追記で決まる。 */
interface PendingHand {
  readonly sessionId: string;
  readonly personas: Readonly<Record<string, string>>;
  readonly participants: readonly SessionParticipant[];
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
  private readonly insertOrdinal: StatementSync;
  private readonly selectEvents: StatementSync;
  private readonly selectHand: StatementSync;
  private readonly selectRecentHands: StatementSync;
  private readonly selectSessionOfHand: StatementSync;
  private readonly selectSessionHands: StatementSync;
  private readonly selectFinishedHands: StatementSync;
  private readonly selectSavedOrder: StatementSync;
  private readonly selectProjection: StatementSync;
  private readonly selectLatestProjection: StatementSync;
  private readonly upsertProjection: StatementSync;
  private readonly insertParticipant: StatementSync;
  private readonly selectParticipants: StatementSync;

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
    this.insertOrdinal = db.prepare(
      "INSERT INTO ordinals (kind, ref_id) VALUES ('hand_saved', ?)",
    );
    this.selectHand = db.prepare("SELECT 1 FROM hands WHERE hand_id = ?");
    // Hand の順は保存の論理順序（ordinals.ord。D117）。ordinals は LEFT JOIN で引き、欠けた行（ord が NULL）は先頭に並べて
    // 読み出しで見つける（LIMIT で落とさない。見つけたら MissingOrdinalError）。
    const handOrdinal =
      "LEFT JOIN ordinals o ON o.kind = 'hand_saved' AND o.ref_id = h.hand_id";
    // 打ち切った Hand（HAND_ABORTED を持つ）は Event の type で見分ける（hands の列は変えない。D95）。
    // 除く Hand（Drill の Hand。D116）は JSON の配列で渡し、LIMIT の前に除く。
    this.selectRecentHands = db.prepare(
      `SELECT h.hand_id, h.started_at, h.finished_at, o.ord,
         EXISTS (SELECT 1 FROM events e WHERE e.hand_id = h.hand_id AND e.type = 'HAND_ABORTED') AS aborted
       FROM hands h ${handOrdinal}
       WHERE h.hand_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY o.ord IS NULL DESC, o.ord DESC LIMIT ?`,
    );
    // Session Review（#116）と Player Profile（#116）の読み出し。hands にあるのは終わった Hand だけ（D62）。保存の古い順。
    this.selectSessionOfHand = db.prepare(
      "SELECT session_id FROM hands WHERE hand_id = ?",
    );
    this.selectSessionHands = db.prepare(
      `SELECT h.hand_id, o.ord FROM hands h ${handOrdinal} WHERE h.session_id = ? ORDER BY o.ord`,
    );
    this.selectFinishedHands = db.prepare(
      `SELECT h.hand_id, o.ord FROM hands h ${handOrdinal} ORDER BY o.ord`,
    );
    this.selectSavedOrder = db.prepare(
      `SELECT h.hand_id, o.ord FROM hands h ${handOrdinal} WHERE h.hand_id = ?`,
    );
    const projectionColumns =
      "session_id, last_hand_id, state, end_reason, stacks, personas, emergency_bots, updated_at";
    this.selectProjection = db.prepare(
      `SELECT ${projectionColumns} FROM session_projections WHERE session_id = ?`,
    );
    // 最後に Hand が終わった Session＝最後の Hand の保存の論理順序が最も大きい行（D117。updated_at の時刻では選ばない）。
    // 最後の Hand が除く Hand（Drill の専用の Session の Hand。D116）の Session は選ばない（JSON の配列で渡す）。
    this.selectLatestProjection = db.prepare(
      `SELECT p.session_id, p.last_hand_id, p.state, p.end_reason, p.stacks, p.personas, p.emergency_bots, p.updated_at, o.ord
       FROM session_projections p
       LEFT JOIN ordinals o ON o.kind = 'hand_saved' AND o.ref_id = p.last_hand_id
       WHERE p.last_hand_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY o.ord IS NULL DESC, o.ord DESC LIMIT 1`,
    );
    // CPU の席の参加者（v10。D118）。追記だけで、保存した順（席順）に読む。
    this.insertParticipant = db.prepare(
      "INSERT INTO session_participants (session_id, player_id, kind, cpu_profile_id, guest_id, pool_version) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.selectParticipants = db.prepare(
      "SELECT player_id, kind, cpu_profile_id, guest_id, pool_version FROM session_participants WHERE session_id = ? ORDER BY seq",
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
    const participants = pending?.participants ?? context.participants ?? [];
    assertAppendable(handId, log, events);

    const stored = toStoredEvents(
      handId,
      events,
      this.now().toISOString(),
      this.newEventId,
    );
    const next = [...log, ...stored];
    if (!events.some(isHandEnd)) {
      this.pending.set(handId, {
        sessionId,
        personas,
        participants,
        log: next,
      });
    } else {
      // 書き込みに失敗したら例外のまま返し、メモリ側も変えない（Hand は未完了のまま残る）。
      this.persist(handId, sessionId, personas, participants, next);
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
   * 止まった Hand。D62）を合わせて、新しい順に最大 limit 件返す。メモリの Hand（このプロセスで始めた順の逆）を先に、保存済みの Hand
   * （保存の論理順序の逆。D117）を後に並べる。メモリの Hand は再起動で消えるので、一覧からも消える。
   */
  listHands(
    limit: number,
    exclude: ReadonlySet<string> = new Set(),
  ): readonly StoredHandSummary[] {
    const persisted = (
      this.selectRecentHands.all(
        JSON.stringify([...exclude]),
        limit,
      ) as unknown as HandRow[]
    ).map((row): StoredHandSummary => {
      requireOrdinal(row);
      const aborted = row.aborted === 1;
      return {
        handId: row.hand_id,
        startedAt: row.started_at,
        // hands.finished_at は Hand の終わりの時刻。打ち切った Hand は HAND_FINISHED を持たないので null にする。
        finishedAt: aborted ? null : row.finished_at,
        aborted,
      };
    });
    // メモリの Hand は Map の追記の順（このプロセスで始めた順）なので、逆順が新しい順。壁時計の時刻では並べない（D117）。
    const pending = [...this.pending.entries()]
      .reverse()
      .filter(([handId]) => !exclude.has(handId))
      .map(([handId, p]) => summarizeLog(handId, p.log));
    return [...pending, ...persisted].slice(0, limit);
  }

  latestSessionProjection(
    exclude: ReadonlySet<string> = new Set(),
  ): SessionProjection | null {
    const row = this.selectLatestProjection.get(
      JSON.stringify([...exclude]),
    ) as unknown as LatestProjectionRow | undefined;
    if (row === undefined) return null;
    requireOrdinal({ hand_id: row.last_hand_id, ord: row.ord });
    return toProjection(row);
  }

  sessionHandIds(handId: string): readonly string[] {
    // 進行中の Hand（メモリだけ）は、最初の追記で決まった Session を使う。終わった Hand は hands の行から引く。
    const sessionId =
      this.pending.get(handId)?.sessionId ??
      (
        this.selectSessionOfHand.get(handId) as
          { session_id: string } | undefined
      )?.session_id;
    if (sessionId === undefined) return [];
    return (
      this.selectSessionHands.all(sessionId) as unknown as HandOrdinalRow[]
    ).map(savedHandId);
  }

  finishedHandIds(): readonly string[] {
    return (this.selectFinishedHands.all() as unknown as HandOrdinalRow[]).map(
      savedHandId,
    );
  }

  savedOrder(handId: string): number | null {
    const row = this.selectSavedOrder.get(handId) as unknown as
      HandOrdinalRow | undefined;
    // hands に無い Hand（進行中・未知）は保存されていない。
    return row === undefined ? null : requireOrdinal(row);
  }

  sessionParticipants(sessionId: string): readonly SessionParticipant[] {
    return (
      this.selectParticipants.all(sessionId) as unknown as ParticipantRow[]
    ).map(toParticipant);
  }

  /** DB を閉じる。以降は使えない。途中の Hand（メモリ側）は保存されずに消える（D62）。 */
  close(): void {
    this.pending.clear();
    if (this.db.isOpen) this.db.close();
  }

  /**
   * 終わった Hand の全 Event と、その Session の Session Projection を 1 トランザクションで書く。
   * Session の最初の Hand（まだ Projection が無い）なら、CPU の席の参加者も同じトランザクションで足す。
   */
  private persist(
    handId: string,
    sessionId: string,
    personas: Readonly<Record<string, string>>,
    participants: readonly SessionParticipant[],
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
      // 参加者は Session の途中で変えないので、Session の最初の Hand のときだけ書く（2 Hand 目以降の値は見ない）。
      if (previous === undefined) {
        for (const p of participants) {
          this.insertParticipant.run(
            sessionId,
            p.playerId,
            p.kind,
            p.kind === "fixed" ? p.cpuProfileId : null,
            p.kind === "guest" ? p.guestId : null,
            p.poolVersion,
          );
        }
      }
      this.insertHand.run(handId, sessionId, first.recordedAt, last.recordedAt);
      // 保存の論理順序（D117）。Hand の順はこの番号で決める（started_at・finished_at は表示・監査用に残す）。
      this.insertOrdinal.run(handId);
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

/** 保存済みの Hand の論理順序の番号。行が欠けていれば MissingOrdinalError（v9 の backfill 後は必ずある。D117）。 */
function requireOrdinal(row: HandOrdinalRow): number {
  if (row.ord === null) {
    throw new MissingOrdinalError(
      `保存済みの Hand ${row.hand_id} に論理順序（ordinals）の行が無い`,
    );
  }
  return row.ord;
}

/** 論理順序の行があることを確かめて handId を返す（並びは SQL の ORDER BY o.ord）。 */
function savedHandId(row: HandOrdinalRow): string {
  requireOrdinal(row);
  return row.hand_id;
}

/** session_participants の行を読む（kind と ID の列の組は CHECK で守られている）。 */
function toParticipant(row: ParticipantRow): SessionParticipant {
  return row.kind === "fixed"
    ? {
        playerId: row.player_id,
        kind: "fixed",
        cpuProfileId: row.cpu_profile_id as string,
        poolVersion: row.pool_version,
      }
    : {
        playerId: row.player_id,
        kind: "guest",
        guestId: row.guest_id as string,
        poolVersion: row.pool_version,
      };
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
