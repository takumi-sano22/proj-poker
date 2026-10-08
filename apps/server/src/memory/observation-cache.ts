// CPU Memory の Observation の Cache（D124・#165。docs/04 §6・§12）。Hand ごとに Observer 別に抽出した観察（observation.ts の ObservedHand）を、
// マイグレーション v12 の派生の表 observed_hand_cache に抽出の Version 付きで持ち、Hand の開始で Memory を読むときに使い回す。
// - 正本は Event Log。この表は消しても Event Log から作り直せる派生の Cache で、Cache の有無・中身で Memory の結果を変えない
//   （Cache を全部消した後・Cache を使わないとき〔メモリ内の Event Store〕と同じ結果。observation-cache.test.ts で確かめる）
// - 更新は読むときに足りない分だけ: 候補の Hand（observationCandidates。Event Log 側で選ぶ）のうち、Cache に行の無い Hand
//   （論理順序の ord と hand_id で引く。壁時計は使わない。D117）だけを Event Log から抽出して足す。Hand の保存のトランザクションでは書かない
// - Opponent Memory Reset（D120）・Guest（D118）・Observer が参加者か・論理順序は、今どおり Event Log 側（hands・session_participants・
//   ordinals・opponent_memory_resets）で判定し、Cache に判定を持たない。Cache の行は「その Hand をその Observer が見たら何が見えるか」だけで、
//   Guest の Subject を前の Session で引かない扱い（D118）は読むときに今の Session と比べて当てる
// - Cache の読み書きに失敗しても、Memory は Event Log から計算を続け、結果を変えない（失敗は warn に残す）
// - Learning-only Reveal・他者の Hidden / Future Cards は、抽出（extractObservedHands の public の whitelist）どおり入らない。
//   このモジュールは learning/ を import しない（observation-isolation.test.ts が memory/ の全モジュールを検査する）
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { HandEvent } from "@proj-poker/engine";
import { inTransaction } from "../db/database.js";
import { EVENT_SCHEMA_VERSION } from "../sqlite-event-store.js";
import {
  extractObservedHands,
  extractObservedHandsFromStore,
  observationCandidates,
  participantKey,
  type ObservationContext,
  type ObservationQuery,
  type ObservationStore,
  type ObservedHand,
  type ParticipantRef,
} from "./observation.js";

/**
 * 抽出の規則の Version。observation.ts の extractObservedHands の規則（通す Event・席→参加者の引き方・行為者の決め方・行の形）を変えたら上げる。
 * Version の違う Cache の行は読まず、消して Event Log から作り直す。
 */
export const OBSERVATION_EXTRACTION_VERSION = "phase7_observation_v1";

/**
 * 表の extraction_version に書く値。Cache の events は読み出し時に upcast した後の Event の形なので、Event の版（EVENT_SCHEMA_VERSION）が
 * 上がったときも古い形の行を使わないよう、抽出の Version と Event の版の組にする。
 */
export const OBSERVATION_CACHE_VERSION = `${OBSERVATION_EXTRACTION_VERSION}+event_schema_v${EVENT_SCHEMA_VERSION}`;

/** Cache の 1 行（Observer × Hand）。observed・events は JSON の文字列。Observer が座っていない Hand は両方 null（読み直さないための行）。 */
export interface ObservationCacheRow {
  readonly handId: string;
  readonly ord: number;
  readonly observed: string | null;
  readonly events: string | null;
}

/** Cache の保存先。行は Observer（participantKey）・Hero の席・Version ごと。 */
export interface ObservationCacheStore {
  /** Observer の行のうち、今の Version・同じ Hero の席で作った行だけを返す（Version の違う行は読まない）。 */
  load(
    observerKey: string,
    heroPlayerId: string,
  ): readonly ObservationCacheRow[];
  /** 行を足す（同じ Observer・Hand の行は置き換える）。 */
  save(
    observerKey: string,
    heroPlayerId: string,
    rows: readonly ObservationCacheRow[],
  ): void;
}

/** Cache の失敗を残す先（Hand Orchestrator の logger の warn と同じ形）。 */
export interface ObservationCacheLogger {
  warn(obj: object, msg: string): void;
}

/** observed の列の中身（Observer ごとに違う部分）。events の列（public の Event の列）と添字でそろえる。 */
interface ObservedPart {
  readonly observerPlayerId: string;
  readonly context: ObservationContext;
  readonly seats: ObservedHand["seats"];
  /** events の列の Event ごとの行為者（卓全体の Event・誰か引けない席は null）。 */
  readonly subjects: readonly (ParticipantRef | null)[];
}

/** 抽出した観察を Cache の行にする（座っていない Hand は observed・events とも null）。 */
function rowOf(
  handId: string,
  ord: number,
  hand: ObservedHand | null,
): ObservationCacheRow {
  if (hand === null) return { handId, ord, observed: null, events: null };
  const part: ObservedPart = {
    observerPlayerId: hand.observerPlayerId,
    context: hand.context,
    seats: hand.seats,
    subjects: hand.events.map((e) => e.subject),
  };
  return {
    handId,
    ord,
    observed: JSON.stringify(part),
    events: JSON.stringify(hand.events.map((e) => e.event)),
  };
}

/** Guest の参照を外す（前の Session の Hand では Guest を引かない。D118）。 */
function withoutGuest(ref: ParticipantRef | null): ParticipantRef | null {
  return ref?.kind === "guest" ? null : ref;
}

/**
 * Cache の観察（その Hand の Session を「今」として作ったもの）を、今の Session から見た観察にする。前の Session の Hand では Guest の
 * Subject を誰か引けない席（null）にする（extractObservedHands が currentSessionId で行う扱いと同じ）。
 */
function viewFrom(hand: ObservedHand, currentSessionId: string): ObservedHand {
  if (hand.sessionId === currentSessionId) return hand;
  return {
    ...hand,
    seats: hand.seats.map((s) => ({
      playerId: s.playerId,
      participant: withoutGuest(s.participant),
    })),
    events: hand.events.map((e) => ({
      ...e,
      subject: withoutGuest(e.subject),
    })),
  };
}

/**
 * 1 回の Memory の計算（Hand の開始で CPU の数だけ抽出する）の間だけ使う、Cache を通した抽出。同じ Hand の public の Event の列は
 * Observer に依らず同じなので、JSON の復元を Observer 間で使い回す。
 */
export class ObservationCacheReader {
  /** handId → その Hand の public の Event の列（この計算の間だけ）。 */
  private readonly eventsOf = new Map<string, readonly HandEvent[]>();

  constructor(
    private readonly cache: ObservationCacheStore,
    private readonly logger: ObservationCacheLogger,
  ) {}

  /**
   * extractObservedHandsFromStore と同じ結果を返す。候補の Hand は Event Log 側で選び、Cache に行のある Hand は Cache から、
   * 無い Hand は Event Log から抽出して Cache に足す。Cache を読めないときは Event Log だけで計算する。
   */
  extract(store: ObservationStore, query: ObservationQuery): ObservedHand[] {
    const observerKey = participantKey(query.observer);
    let rows: readonly ObservationCacheRow[];
    try {
      rows = this.cache.load(observerKey, query.heroPlayerId);
    } catch (error) {
      this.logger.warn(
        { err: error, observer: observerKey },
        "CPU Memory の Cache を読めないため、Event Log から計算する",
      );
      return extractObservedHandsFromStore(store, query);
    }
    const byOrd = new Map(rows.map((r) => [r.ord, r] as const));

    const candidates = observationCandidates(store, query);
    const ords = new Set<number>();
    const hands: ObservedHand[] = [];
    const fresh: ObservationCacheRow[] = [];
    for (const c of candidates) {
      // extractObservedHands と同じ検査（論理順序の番号は Hand ごとに一意）。
      if (!Number.isSafeInteger(c.ord) || ords.has(c.ord)) {
        throw new RangeError(
          `Hand ${c.handId} の論理順序の番号 ${c.ord} が不正か重複している`,
        );
      }
      ords.add(c.ord);

      const row = byOrd.get(c.ord);
      let full =
        row !== undefined && row.handId === c.handId
          ? this.decode(row, c, query)
          : undefined;
      if (full === undefined) {
        // Cache に無い（または読めない）Hand。その Hand の Session を「今」として抽出し、Session 外の扱いは読むときに当てる。
        full =
          extractObservedHands(
            [{ ...c, events: store.read(c.handId).map((s) => s.event) }],
            {
              observer: query.observer,
              heroPlayerId: query.heroPlayerId,
              currentSessionId: c.sessionId,
              afterOrd: null,
            },
          )[0] ?? null;
        fresh.push(rowOf(c.handId, c.ord, full));
      }
      if (full !== null) hands.push(viewFrom(full, query.currentSessionId));
    }

    if (fresh.length > 0) {
      try {
        this.cache.save(observerKey, query.heroPlayerId, fresh);
      } catch (error) {
        // 書けなくても今回の結果は Event Log から作ったものなので変わらない。次の計算でまた足りない分として作る。
        this.logger.warn(
          { err: error, observer: observerKey, hands: fresh.length },
          "CPU Memory の Cache に書けなかった（Memory は Event Log から計算済み）",
        );
      }
    }
    return hands.sort((a, b) => a.ord - b.ord);
  }

  /**
   * Cache の行を観察に戻す（Observer が座っていない Hand は null）。形が合わない行は undefined（Cache に無いものとして作り直す）。
   * Hand の id・Session・ord は Event Log 側の候補の値を使う。
   */
  private decode(
    row: ObservationCacheRow,
    c: {
      readonly handId: string;
      readonly sessionId: string;
      readonly ord: number;
    },
    query: ObservationQuery,
  ): ObservedHand | null | undefined {
    if (row.observed === null || row.events === null) {
      return row.observed === row.events ? null : undefined;
    }
    try {
      const part = JSON.parse(row.observed) as ObservedPart;
      const memo = this.eventsOf.get(c.handId);
      const parsed: unknown = memo ?? JSON.parse(row.events);
      // 形の検査は unknown で行う（型の上の配列を Array.isArray で絞ると any になる）。
      const subjectsRaw: unknown = part.subjects;
      const seatsRaw: unknown = part.seats;
      if (
        !Array.isArray(parsed) ||
        !Array.isArray(subjectsRaw) ||
        !Array.isArray(seatsRaw) ||
        subjectsRaw.length !== parsed.length
      ) {
        return undefined;
      }
      // 形の合った行の Event の列だけを、同じ Hand の他の Observer の行のために残す。
      const events = parsed as HandEvent[];
      if (memo === undefined) this.eventsOf.set(c.handId, events);
      const subjects = part.subjects;
      return {
        observer: query.observer,
        observerPlayerId: part.observerPlayerId,
        handId: c.handId,
        sessionId: c.sessionId,
        ord: c.ord,
        context: part.context,
        seats: part.seats,
        events: events.map((event, i) => ({
          seq: event.seq,
          visibility: "public",
          subject: subjects[i] ?? null,
          event,
        })),
      };
    } catch {
      // JSON として読めない行。Cache に無いものとして Event Log から作り直す。
      return undefined;
    }
  }
}

/** SQLite の実装（v12 の observed_hand_cache。DB は Event Store と共有する）。 */
export class SqliteObservationCache implements ObservationCacheStore {
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;
  private readonly purge: StatementSync;
  private readonly version: string;
  private purged = false;

  constructor(
    private readonly db: DatabaseSync,
    options: { readonly version?: string } = {},
  ) {
    this.version = options.version ?? OBSERVATION_CACHE_VERSION;
    this.select = db.prepare(
      `SELECT hand_id, ord, observed, events FROM observed_hand_cache
       WHERE observer_key = ? AND extraction_version = ? AND hero_player_id = ?`,
    );
    this.upsert = db.prepare(
      `INSERT INTO observed_hand_cache
         (observer_key, hand_id, extraction_version, hero_player_id, ord, observed, events)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (observer_key, hand_id) DO UPDATE SET
         extraction_version = excluded.extraction_version,
         hero_player_id = excluded.hero_player_id,
         ord = excluded.ord,
         observed = excluded.observed,
         events = excluded.events`,
    );
    this.purge = db.prepare(
      "DELETE FROM observed_hand_cache WHERE extraction_version <> ?",
    );
  }

  load(
    observerKey: string,
    heroPlayerId: string,
  ): readonly ObservationCacheRow[] {
    // Version の違う行は読まずに消す（このプロセスで最初に読むときに 1 回。消した分は足りない分として作り直す）。
    if (!this.purged) {
      this.purge.run(this.version);
      this.purged = true;
    }
    return (
      this.select.all(observerKey, this.version, heroPlayerId) as {
        hand_id: string;
        ord: number;
        observed: string | null;
        events: string | null;
      }[]
    ).map((r) => ({
      handId: r.hand_id,
      ord: r.ord,
      observed: r.observed,
      events: r.events,
    }));
  }

  save(
    observerKey: string,
    heroPlayerId: string,
    rows: readonly ObservationCacheRow[],
  ): void {
    inTransaction(this.db, () => {
      for (const r of rows) {
        this.upsert.run(
          observerKey,
          r.handId,
          this.version,
          heroPlayerId,
          r.ord,
          r.observed,
          r.events,
        );
      }
    });
  }
}
