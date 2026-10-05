// Event Store。Hand の Event Log を append-only で持つ（D37: Event Log が唯一の正本）。
// Interface だけを Orchestrator へ見せ、今はメモリ内実装を使う（SQLite 実装は #20 で差し替える。D72）。
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

export interface EventStore {
  /**
   * Hand の Event Log の末尾へ追記する。更新・削除の API は持たない（append-only）。
   * 先頭の Event の seq は「その Hand の保存済み件数」と一致し、連番でなければならない。
   * 一致しなければ何も書かずに EventSeqConflictError を投げる（二重追記・抜けを拒否する）。
   */
  append(
    handId: string,
    events: readonly HandEvent[],
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

/** プロセス内のメモリだけに持つ実装。再起動で消える（永続化は #20）。 */
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
    // 書く前に全件の seq を検査する（途中まで書いて失敗する、を作らない）。
    events.forEach((event, i) => {
      const expected = log.length + i;
      if (event.seq !== expected) {
        throw new EventSeqConflictError(
          `Hand ${handId} の seq が連続しない: 期待 ${expected}・実際 ${event.seq}`,
        );
      }
    });
    const recordedAt = this.now().toISOString();
    const stored = events.map((event): StoredHandEvent =>
      Object.freeze({ eventId: this.newEventId(), handId, recordedAt, event }),
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
