// Event Store。Hand の Event Log を append-only で持つ（D37: Event Log が唯一の正本）。
// Interface だけを Orchestrator へ見せる。起動時は SQLite 実装（sqlite-event-store.ts。D72）、テストの既定はメモリ内実装を使う。
import { randomUUID } from "node:crypto";
import type { HandEvent } from "@proj-poker/engine";
import { processOrdinals, type OrdinalCounter } from "./logical-order.js";
import type { SessionParticipant } from "./opponents/cpu-pool.js";
import {
  nextSessionProjection,
  type SessionProjection,
} from "./session-projection.js";

/** 保存した Event。event_id と記録時刻は永続化する側が付ける（Engine は I/O と時刻を持たない。docs/04 §3）。 */
export interface StoredHandEvent {
  readonly eventId: string;
  readonly handId: string;
  /** ISO 8601（UTC）。 */
  readonly recordedAt: string;
  readonly event: HandEvent;
}

/** 追記の付帯情報。Event そのものには入れない（Event の形は Engine が決める。docs/04 §3）。 */
export interface AppendContext {
  /** Hand が属する Session（D80）。Hand の最初の追記の値を使い、以降の追記では見ない。 */
  readonly sessionId?: string;
  /**
   * Session の Persona の割り当て（CPU の playerId → Preset ID）。Session の最初の Hand が終わったときに Session Projection へ
   * 保存する（D95。Event には入れない）。Hand の最初の追記の値を使い、以降の追記では見ない。
   */
  readonly personas?: Readonly<Record<string, string>>;
  /**
   * Session の CPU の席の参加者（Fixed CPU / Guest。D118・#136）。Session の最初の Hand が終わったとき（Session の行を作るとき）だけ
   * 保存し、同じ Session の 2 Hand 目以降の値は見ない（参加者は Session の途中で変えない）。Hand の最初の追記の値を使う。
   */
  readonly participants?: readonly SessionParticipant[];
}

/** Hand の一覧の 1 行（Replay の Hand 一覧。#68）。Event の中身は持たない（中身は read で読む）。 */
export interface StoredHandSummary {
  readonly handId: string;
  /** ISO 8601（UTC）。Hand の最初の Event を記録した時刻。 */
  readonly startedAt: string;
  /** HAND_FINISHED を記録した時刻。HAND_FINISHED の無い Hand（進行中・打ち切った Hand）は null。 */
  readonly finishedAt: string | null;
  /** AI 障害の後の Session 終了で打ち切った（HAND_ABORTED で終えた）Hand（D95）。 */
  readonly aborted: boolean;
}

export interface EventStore {
  /**
   * Hand の Event Log の末尾へ追記する。更新・削除の API は持たない（append-only）。
   * 先頭の Event の seq は「その Hand の保存済み件数」と一致し、連番でなければならない。
   * 一致しなければ何も書かずに EventSeqConflictError を投げる（二重追記・抜けを拒否する）。
   * Hand の終わり（HAND_FINISHED か HAND_ABORTED）の後ろに置けるのは、同じ追記の SESSION_ENDED 1 つだけで、
   * 終わった Hand への追記も同じく拒否する。Hand が終わったら、その Session の Session Projection も更新する（D95）。
   */
  append(
    handId: string,
    events: readonly HandEvent[],
    context?: AppendContext,
  ): readonly StoredHandEvent[];
  /** Hand の Event を seq 順で返す。未知の Hand なら空配列。 */
  read(handId: string): readonly StoredHandEvent[];
  /**
   * Event のある Hand を新しい順に最大 limit 件返す（HAND_FINISHED の無い Hand も含む）。順は論理順序（D117・logical-order.ts）で、
   * 先にメモリにある終わっていない Hand（このプロセスで始めた順の逆）、続けて終わった Hand（保存の順の逆）。壁時計の時刻では並べない。
   * exclude の Hand（Drill の Hand。D116）は数えずに除く（除いた後で最大 limit 件）。
   */
  listHands(
    limit: number,
    exclude?: ReadonlySet<string>,
  ): readonly StoredHandSummary[];
  /**
   * 最後に Hand が終わった Session の Session Projection（D95。再起動後の Resume に使う）。まだ無ければ null。
   * 「最後」は最後の Hand の保存の順（論理順序。D117）で決める。最後の Hand が exclude にある Session（Drill の専用の Session。D116）は選ばない。
   */
  latestSessionProjection(
    exclude?: ReadonlySet<string>,
  ): SessionProjection | null;
  /**
   * handId と同じ Session の、終わった（HAND_FINISHED か HAND_ABORTED まで済んだ）Hand の handId を保存の古い順（論理順序。D117）に返す
   * （Session Review。#116）。handId が進行中の Hand でも、その Session の終わった Hand を返す。未知の Hand なら空配列。
   */
  sessionHandIds(handId: string): readonly string[];
  /**
   * Hand が属する Session の ID（Hand の最初の追記で決まった値。進行中の Hand も返す）。未知の Hand なら null。
   * CPU の Observation の抽出（memory/observation.ts。#137）が、Hand ごとにその Session の参加者を引くために使う。
   */
  sessionIdOfHand(handId: string): string | null;
  /** 終わった Hand の handId を、保存の古い順（論理順序。D117）にすべて返す（Recent / Long-term の Player Profile。#116）。 */
  finishedHandIds(): readonly string[];
  /**
   * 終わった Hand の保存の論理順序の番号（D117。Learning Reset の前後の判定に使う）。終わっていない・未知の Hand は null。
   * 同じ順序の源（同じ DB の ordinals、またはメモリ内の同じカウンタ）を使う Learning Reset Store の番号と比べられる。
   */
  savedOrder(handId: string): number | null;
  /**
   * 今までに振った論理順序の最後の番号（D117。SQLite は MAX(ordinals.ord)、メモリ内はカウンタの最後の番号。無ければ 0）。
   * Opponent Memory Reset（D120・memory/memory-reset.ts）の区切りに使う。番号は振らない。
   */
  lastOrdinal(): number;
  /**
   * Session の CPU の席の参加者（D118・#136）を、保存した順（席順）に返す。Session の最初の Hand が終わるまでは空。
   * 参加者を渡さずに始めた Session（v10 より前の Session・Drill の専用の Session）も空。
   */
  sessionParticipants(sessionId: string): readonly SessionParticipant[];
}

export class EventSeqConflictError extends Error {
  override readonly name = "EventSeqConflictError";
}

export interface InMemoryEventStoreOptions {
  readonly now?: () => Date;
  readonly newEventId?: () => string;
  /** 保存の論理順序の番号を振るカウンタ（D117）。省略時はプロセスで 1 つのカウンタ（Learning Reset Store と共有する）。 */
  readonly ordinals?: OrdinalCounter;
}

/** Hand の Session と Persona の割り当てと参加者（Hand の最初の追記で決まる）。 */
interface HandSession {
  readonly sessionId: string;
  readonly personas: Readonly<Record<string, string>>;
  readonly participants: readonly SessionParticipant[];
}

/** プロセス内のメモリだけに持つ実装。再起動で消える（テスト用。永続化は SqliteEventStore）。 */
export class InMemoryEventStore implements EventStore {
  private readonly logs = new Map<string, StoredHandEvent[]>();
  private readonly sessions = new Map<string, HandSession>();
  /** Session ID → Session Projection。 */
  private readonly projections = new Map<string, SessionProjection>();
  /** Session ID → CPU の席の参加者（Session の最初の Hand が終わったときに入れ、以降は変えない。v10 の session_participants と同じ意味）。 */
  private readonly participants = new Map<
    string,
    readonly SessionParticipant[]
  >();
  /** Hand が終わった Session の ID（終わった順。同じ Session は最後に終わった位置へ移す）。 */
  private readonly finishedOrder: string[] = [];
  /** 終わった Hand → 保存の論理順序の番号（D117。SqliteEventStore の ordinals と同じ意味）。 */
  private readonly saved = new Map<string, number>();
  private readonly now: () => Date;
  private readonly newEventId: () => string;
  /** 保存の論理順序のカウンタ。buildApp が既定の Learning Reset Store に同じカウンタを渡す（D117。別の源だと番号を比べられない）。 */
  readonly ordinals: OrdinalCounter;
  private readonly defaultSessionId = randomUUID();

  constructor(options: InMemoryEventStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newEventId = options.newEventId ?? randomUUID;
    this.ordinals = options.ordinals ?? processOrdinals;
  }

  append(
    handId: string,
    events: readonly HandEvent[],
    context: AppendContext = {},
  ): readonly StoredHandEvent[] {
    const log = this.logs.get(handId) ?? [];
    assertAppendable(handId, log, events);
    const session = this.sessions.get(handId) ?? {
      sessionId: context.sessionId ?? this.defaultSessionId,
      personas: context.personas ?? {},
      participants: context.participants ?? [],
    };
    const stored = toStoredEvents(
      handId,
      events,
      this.now().toISOString(),
      this.newEventId,
    );
    const ended = stored.find((s) => isHandEnd(s.event));
    if (ended !== undefined) {
      // 先に Projection を作る（作れなければ Log も変えない。SqliteEventStore のトランザクションと同じ結果にする）。
      const next = nextSessionProjection(
        endedSessionGuard(this.projections.get(session.sessionId)),
        {
          sessionId: session.sessionId,
          personas: session.personas,
          handId,
          events: [...log, ...stored].map((s) => s.event),
          recordedAt: ended.recordedAt,
        },
      );
      // Session の最初の Hand（まだ Projection が無い）のときだけ参加者を残す（SqliteEventStore と同じ）。
      if (!this.projections.has(session.sessionId)) {
        this.participants.set(
          session.sessionId,
          deepFreeze(structuredClone(session.participants)),
        );
      }
      this.projections.set(session.sessionId, next);
      const at = this.finishedOrder.indexOf(session.sessionId);
      if (at >= 0) this.finishedOrder.splice(at, 1);
      this.finishedOrder.push(session.sessionId);
      this.saved.set(handId, this.ordinals.next());
    }
    log.push(...stored);
    this.logs.set(handId, log);
    this.sessions.set(handId, session);
    return stored;
  }

  read(handId: string): readonly StoredHandEvent[] {
    // 呼び出し側が配列を書き換えても Log が変わらないよう、写しを返す。
    return [...(this.logs.get(handId) ?? [])];
  }

  listHands(
    limit: number,
    exclude: ReadonlySet<string> = new Set(),
  ): readonly StoredHandSummary[] {
    // 終わっていない Hand（Map の追記の順＝このプロセスで始めた順の逆）を先に、終わった Hand を保存の新しい順に（D117）。
    const pending = [...this.logs.keys()]
      .filter((handId) => !this.saved.has(handId))
      .reverse();
    const finished = [...this.finishedHandIds()].reverse();
    return [...pending, ...finished]
      .filter((handId) => !exclude.has(handId))
      .slice(0, limit)
      .map((handId) => summarizeLog(handId, this.logs.get(handId) ?? []));
  }

  latestSessionProjection(
    exclude: ReadonlySet<string> = new Set(),
  ): SessionProjection | null {
    for (const sessionId of [...this.finishedOrder].reverse()) {
      const projection = this.projections.get(sessionId);
      if (projection !== undefined && !exclude.has(projection.lastHandId)) {
        return projection;
      }
    }
    return null;
  }

  sessionHandIds(handId: string): readonly string[] {
    const sessionId = this.sessions.get(handId)?.sessionId;
    if (sessionId === undefined) return [];
    return this.finishedHandIds().filter(
      (id) => this.sessions.get(id)?.sessionId === sessionId,
    );
  }

  sessionIdOfHand(handId: string): string | null {
    return this.sessions.get(handId)?.sessionId ?? null;
  }

  finishedHandIds(): readonly string[] {
    // 保存の古い順（D117）。Map は番号を振った順に入るが、番号で並べて意味を明示する。
    return [...this.saved.entries()]
      .sort(([, a], [, b]) => a - b)
      .map(([handId]) => handId);
  }

  savedOrder(handId: string): number | null {
    return this.saved.get(handId) ?? null;
  }

  lastOrdinal(): number {
    return this.ordinals.current();
  }

  sessionParticipants(sessionId: string): readonly SessionParticipant[] {
    return this.participants.get(sessionId) ?? [];
  }
}

/** Hand を終える Event（HAND_FINISHED か、打ち切りの HAND_ABORTED。D95）か。 */
export function isHandEnd(event: HandEvent): boolean {
  return event.type === "HAND_FINISHED" || event.type === "HAND_ABORTED";
}

/**
 * 終わった Session に Hand を足させない（Session Projection を ended から戻さない）。
 * Orchestrator は終わった Session の次を新しい Session で始めるので、ここへ来るのは呼び出し側の誤り。
 */
export function endedSessionGuard(
  previous: SessionProjection | undefined | null,
): SessionProjection | null {
  if (previous?.state === "ended") {
    throw new EventSeqConflictError(
      `Session ${previous.sessionId} は終わっていて Hand を足せない`,
    );
  }
  return previous ?? null;
}

/** メモリにある Log（1 件以上）から一覧の 1 行を作る。 */
export function summarizeLog(
  handId: string,
  log: readonly StoredHandEvent[],
): StoredHandSummary {
  const end = log.find((s) => isHandEnd(s.event));
  return {
    handId,
    startedAt: log[0]?.recordedAt ?? "",
    finishedAt: end?.event.type === "HAND_FINISHED" ? end.recordedAt : null,
    aborted: end?.event.type === "HAND_ABORTED",
  };
}

/**
 * 追記してよいかを書く前に全件で検査する（途中まで書いて失敗する、を作らない）。
 * - 先頭の seq が保存済み件数と一致し、連番であること
 * - Hand の終わり（HAND_FINISHED / HAND_ABORTED）は 1 回だけで、その後ろに続くのは同じ追記の SESSION_ENDED 1 つだけ
 *   （D95。Session の終了は Hand の終わりで決まるので、Hand の保存と一緒に書く）
 * - 終わった Hand へは追記しないこと
 * 崩れていれば EventSeqConflictError。
 */
export function assertAppendable(
  handId: string,
  saved: readonly StoredHandEvent[],
  events: readonly HandEvent[],
): void {
  if (saved.some((s) => isHandEnd(s.event))) {
    throw new EventSeqConflictError(
      `Hand ${handId} は終了していて追記できない`,
    );
  }
  let endAt: number | null = null;
  events.forEach((event, i) => {
    const expected = saved.length + i;
    if (event.seq !== expected) {
      throw new EventSeqConflictError(
        `Hand ${handId} の seq が連続しない: 期待 ${expected}・実際 ${event.seq}`,
      );
    }
    if (endAt !== null && (event.type !== "SESSION_ENDED" || i !== endAt + 1)) {
      throw new EventSeqConflictError(
        `Hand ${handId} の終わりの後ろに置けるのは SESSION_ENDED 1 つだけ: ${event.type}`,
      );
    }
    if (isHandEnd(event)) endAt = i;
  });
}

/**
 * 保存する形にする。呼び出し側が持つ Event と切り離すため複製し、配下まで凍結する
 * （保存後に書き換えられない＝append-only・D37）。
 */
export function toStoredEvents(
  handId: string,
  events: readonly HandEvent[],
  recordedAt: string,
  newEventId: () => string,
): StoredHandEvent[] {
  return events.map((event): StoredHandEvent =>
    deepFreeze({
      eventId: newEventId(),
      handId,
      recordedAt,
      event: structuredClone(event),
    }),
  );
}

/** object と配列を配下まで凍結する（Event は JSON 相当の値だけを持つ）。 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
