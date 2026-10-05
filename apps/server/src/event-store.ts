// Event Store。Hand の Event Log を append-only で持つ（D37: Event Log が唯一の正本）。
// Interface だけを Orchestrator へ見せる。起動時は SQLite 実装（sqlite-event-store.ts。D72）、テストの既定はメモリ内実装を使う。
import { randomUUID } from "node:crypto";
import type { HandEvent } from "@proj-poker/engine";

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
}

export interface EventStore {
  /**
   * Hand の Event Log の末尾へ追記する。更新・削除の API は持たない（append-only）。
   * 先頭の Event の seq は「その Hand の保存済み件数」と一致し、連番でなければならない。
   * 一致しなければ何も書かずに EventSeqConflictError を投げる（二重追記・抜けを拒否する）。
   * HAND_FINISHED は Hand の最後の Event で、その後ろへの追記も同じく拒否する。
   */
  append(
    handId: string,
    events: readonly HandEvent[],
    context?: AppendContext,
  ): readonly StoredHandEvent[];
  /** Hand の Event を seq 順で返す。未知の Hand なら空配列。 */
  read(handId: string): readonly StoredHandEvent[];
}

export class EventSeqConflictError extends Error {
  override readonly name = "EventSeqConflictError";
}

export interface InMemoryEventStoreOptions {
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

/** プロセス内のメモリだけに持つ実装。再起動で消える（テスト用。永続化は SqliteEventStore）。 */
export class InMemoryEventStore implements EventStore {
  private readonly logs = new Map<string, StoredHandEvent[]>();
  private readonly now: () => Date;
  private readonly newEventId: () => string;

  constructor(options: InMemoryEventStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newEventId = options.newEventId ?? randomUUID;
  }

  append(
    handId: string,
    events: readonly HandEvent[],
  ): readonly StoredHandEvent[] {
    const log = this.logs.get(handId) ?? [];
    assertAppendable(handId, log, events);
    const stored = toStoredEvents(
      handId,
      events,
      this.now().toISOString(),
      this.newEventId,
    );
    log.push(...stored);
    this.logs.set(handId, log);
    return stored;
  }

  read(handId: string): readonly StoredHandEvent[] {
    // 呼び出し側が配列を書き換えても Log が変わらないよう、写しを返す。
    return [...(this.logs.get(handId) ?? [])];
  }
}

/**
 * 追記してよいかを書く前に全件で検査する（途中まで書いて失敗する、を作らない）。
 * - 先頭の seq が保存済み件数と一致し、連番であること
 * - HAND_FINISHED（Hand の最後の Event）の後ろに Event が続かないこと（保存済み・追記分とも）
 * 崩れていれば EventSeqConflictError。
 */
export function assertAppendable(
  handId: string,
  saved: readonly StoredHandEvent[],
  events: readonly HandEvent[],
): void {
  if (saved.at(-1)?.event.type === "HAND_FINISHED") {
    throw new EventSeqConflictError(
      `Hand ${handId} は終了していて追記できない`,
    );
  }
  events.forEach((event, i) => {
    const expected = saved.length + i;
    if (event.seq !== expected) {
      throw new EventSeqConflictError(
        `Hand ${handId} の seq が連続しない: 期待 ${expected}・実際 ${event.seq}`,
      );
    }
    if (event.type === "HAND_FINISHED" && i !== events.length - 1) {
      throw new EventSeqConflictError(
        `Hand ${handId} の HAND_FINISHED の後ろに Event がある`,
      );
    }
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
