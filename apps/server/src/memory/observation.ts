// CPU の Observation（Raw Evidence）を正本の Event Log から決定論で抽出する（D106・D118・#137。docs/04 §6・docs/02 INV-INFO-003）。
// Observation は別の表や Event に書かず、都度ここで作る（D111 と同じく保存しない。Event Log が append-only なので Observation も append-only）。
// 入れてよいのは、その Observer が卓で実際に見聞きした public の Event（Showdown で表にされた札 CARDS_TABLED を含む）だけ。
// - Observer 自身の private（自分の Hole Cards）・他者の Hidden Cards（他者宛ての private）・Future Cards（Deck の engine）・
//   CPU の判断の経緯や運用の記録（system）は入れない（whitelist: public だけを通す）
// - Learning-only Reveal（packages/engine の learning-reveal.ts）はゲーム世界の Observation ではないので参照しない（INV-INFO-002）
// - Hero の弱点（apps/server/src/learning/ の Score・Hypothesis・Profile）は参照しない（不変条件 2。import の検査は observation-isolation.test.ts）
// 順序は保存の論理順序（ordinals.ord）と Hand 内の events.seq で決め、壁時計（recorded_at 等）を使わない（D117）。
import { visibilityOf, type HandEvent } from "@proj-poker/engine";
import type { EventStore } from "../event-store.js";
import type { CpuProfileSubject } from "../notes/subject.js";
import type { SessionParticipant } from "../opponents/cpu-pool.js";

/** その Session 限りの Guest（D118）。id は Session の id から作るので、別の Session と重ならない。 */
export interface GuestRef {
  readonly kind: "guest";
  readonly guestId: string;
}

/** Hero（ローカル単一ユーザー。Session を跨いで同じ）。 */
export interface HeroRef {
  readonly kind: "hero";
}

/**
 * 席・player id（cpu1 等）に依存しない参加者の参照。Fixed CPU は Note / Tag の Subject と同じ cpu_profile の形
 * （notes/subject.ts。Phase 6 の Subject と接続する）。
 */
export type ParticipantRef = HeroRef | CpuProfileSubject | GuestRef;

/** Observer（観察する CPU）。Fixed CPU は永続の cpuProfileId、Guest は Session 限りの id（D106）。 */
export type ObserverRef = CpuProfileSubject | GuestRef;

/** Observation の context。Raw Observation は共通に使い、Hypothesis が context ごとに分ける（D106）。tournament は Phase 8 で使う枠。 */
export type ObservationContext = "cash" | "tournament";

/** 抽出が読む Event Store の部分（保存済みの Hand・Session の参加者・論理順序）。 */
export type ObservationStore = Pick<
  EventStore,
  | "finishedHandIds"
  | "sessionIdOfHand"
  | "sessionParticipants"
  | "savedOrder"
  | "read"
>;

/** 抽出の入力の 1 Hand（保存済みの Hand）。Event Store から loadObservationSources で作る。 */
export interface ObservationSourceHand {
  readonly handId: string;
  readonly sessionId: string;
  /** Hand の保存の論理順序（ordinals.ord。D117）。 */
  readonly ord: number;
  /** その Session の CPU の席の参加者（session_participants。v10）。v10 より前の Session・Drill の専用の Session は空。 */
  readonly participants: readonly SessionParticipant[];
  /** その Hand の全 Event（正本。ここで public だけに絞る）。 */
  readonly events: readonly HandEvent[];
}

/** 抽出の条件。 */
export interface ObservationQuery {
  readonly observer: ObserverRef;
  /** Hero の席の playerId（Hero は session_participants に行を持たないので、呼び出し側が渡す）。 */
  readonly heroPlayerId: string;
  /**
   * Memory を使う今の Session。Guest は Observer・Subject のどちらでも、この Session のものだけを読む
   * （Guest の Identity は Session 限り。次の Session では読まない＝破棄。D118）。
   */
  readonly currentSessionId: string;
  /**
   * Observer に効く Opponent Memory Reset の区切り（D120・memory-reset.ts の boundaryFor の ord）。この番号より大きい ord で保存された
   * Hand だけを観察する（区切り以前の Hand は Observer の Memory から外す。Event Log は消さない）。省略・null は区切り無し（全期間）。
   */
  readonly afterOrd?: number | null;
}

/** Observer が見た 1 Event。 */
export interface ObservedEvent {
  /** events.seq（Hand 内の通し番号）。 */
  readonly seq: number;
  /** 通すのは public だけ（Showdown の札も CARDS_TABLED の public）。 */
  readonly visibility: "public";
  /**
   * その Event の行為者（Blind・Action・Showdown の公開・返却・Hero の宣言 / Chip の操作 / 裁定）。卓全体の Event
   * （開始・Board・Pot の配分・終わり）と、誰か引けない席（読まない Guest・参加者の無い席）の Event は null。
   */
  readonly subject: ParticipantRef | null;
  readonly event: HandEvent;
}

/** Observer が座っていた 1 Hand の観察。 */
export interface ObservedHand {
  readonly observer: ObserverRef;
  /** その Hand での Observer の席。 */
  readonly observerPlayerId: string;
  readonly handId: string;
  readonly sessionId: string;
  readonly ord: number;
  readonly context: ObservationContext;
  /** 席順の席 → 参加者（HAND_STARTED の seats の順）。誰か引けない席は null。 */
  readonly seats: readonly {
    readonly playerId: string;
    readonly participant: ParticipantRef | null;
  }[];
  /** Observer が見た Event（seq 順。Pot・Board 等の文脈を含む）。 */
  readonly events: readonly ObservedEvent[];
}

/** Subject についての Observation 1 件（provenance 付き。INV-INFO-003）。 */
export interface Observation {
  readonly observer: ObserverRef;
  readonly subject: ParticipantRef;
  readonly handId: string;
  readonly seq: number;
  readonly ord: number;
  readonly visibility: "public";
  readonly context: ObservationContext;
  readonly event: HandEvent;
}

/** 参加者の参照を 1 つの文字列にした比較の鍵（kind を先頭に置き、種類を足しても衝突しない）。 */
export function participantKey(ref: ParticipantRef): string {
  switch (ref.kind) {
    case "hero":
      return JSON.stringify([ref.kind]);
    case "cpu_profile":
      return JSON.stringify([ref.kind, ref.cpuProfileId]);
    case "guest":
      return JSON.stringify([ref.kind, ref.guestId]);
  }
}

/** Session の参加者の行を参照にする。 */
export function participantRefOf(
  p: SessionParticipant,
): CpuProfileSubject | GuestRef {
  return p.kind === "fixed"
    ? { kind: "cpu_profile", cpuProfileId: p.cpuProfileId }
    : { kind: "guest", guestId: p.guestId };
}

/** その Session で Observer が座った席（参加者に Observer がいなければ null）。 */
function observerSeatOf(
  observer: ObserverRef,
  participants: readonly SessionParticipant[],
): string | null {
  const key = participantKey(observer);
  return (
    participants.find((p) => participantKey(participantRefOf(p)) === key)
      ?.playerId ?? null
  );
}

/** その Event の行為者の席（卓全体の Event は null）。 */
function actorOf(event: HandEvent): string | null {
  switch (event.type) {
    case "BLIND_POSTED":
    case "ACTION_TAKEN":
    case "CARDS_TABLED":
    case "UNCALLED_BET_RETURNED":
    case "PLAYER_DECLARED":
    case "PHYSICAL_CHIP_ACTION":
    case "DEALER_RULING":
      return event.playerId;
    default:
      return null;
  }
}

/**
 * Observer が卓で見聞きした Event か。保存された Event の visibility と、Engine が種類から決める Visibility の両方が public のときだけ通す
 * （保存された値だけを信じない。Hole Cards・Deck・system の Event は種類で落ちる）。Table Tendency（#141）も同じ whitelist を使う。
 */
export function isObservable(event: HandEvent): boolean {
  return (
    event.visibility.type === "public" && visibilityOf(event).type === "public"
  );
}

/** Hand が Observer の Opponent Memory Reset の区切りより後に保存されたか（区切りが無ければ常に真。番号の比較なので壁時計に依らない）。 */
function afterReset(ord: number, query: ObservationQuery): boolean {
  return (
    query.afterOrd === undefined ||
    query.afterOrd === null ||
    ord > query.afterOrd
  );
}

/**
 * Observer が座っていた保存済みの Hand ごとに、見た Event を論理順序で返す（純粋関数。同じ入力なら同じ結果）。
 * - Observer が参加者にいない Session（v10 より前の Session・Drill の専用の Session を含む）と、Observer が座っていない Hand
 *   （Bust した後の Hand）は観察しない
 * - Guest の Observer は今の Session の Hand だけを観察する。Guest の Subject は今の Session の Hand でだけ引き、
 *   前の Session の Hand では誰か引けない席（null）にする（推測で Identity を作らない）
 * - Observer に Opponent Memory Reset の区切り（afterOrd）があれば、それより ord が大きい Hand だけを観察する（D120）
 * - 並びは ord の小さい順、Hand の中は seq の小さい順（入力の並び・壁時計に依らない）
 */
export function extractObservedHands(
  sources: readonly ObservationSourceHand[],
  query: ObservationQuery,
): ObservedHand[] {
  const ords = new Set<number>();
  for (const s of sources) {
    if (!Number.isSafeInteger(s.ord) || ords.has(s.ord)) {
      throw new RangeError(
        `Hand ${s.handId} の論理順序の番号 ${s.ord} が不正か重複している`,
      );
    }
    ords.add(s.ord);
  }
  const observerIsGuest = query.observer.kind === "guest";
  return [...sources]
    .sort((a, b) => a.ord - b.ord)
    .flatMap((source): ObservedHand[] => {
      const current = source.sessionId === query.currentSessionId;
      if (observerIsGuest && !current) return [];
      if (!afterReset(source.ord, query)) return [];
      const observerPlayerId = observerSeatOf(
        query.observer,
        source.participants,
      );
      if (observerPlayerId === null) return [];
      const events = [...source.events].sort((a, b) => a.seq - b.seq);
      const started = events.find((e) => e.type === "HAND_STARTED");
      if (started?.type !== "HAND_STARTED") {
        throw new RangeError(`Hand ${source.handId} に HAND_STARTED が無い`);
      }
      if (!started.seats.some((s) => s.playerId === observerPlayerId)) {
        return [];
      }

      // 席 → 参加者。Hero は呼び出し側の席、CPU は session_participants から引く。前の Session の Guest は引かない。
      const refOfSeat = new Map<string, ParticipantRef | null>();
      for (const seat of started.seats) {
        let ref: ParticipantRef | null = null;
        if (seat.playerId === query.heroPlayerId) {
          ref = { kind: "hero" };
        } else {
          const p = source.participants.find(
            (q) => q.playerId === seat.playerId,
          );
          if (p !== undefined && (p.kind === "fixed" || current)) {
            ref = participantRefOf(p);
          }
        }
        refOfSeat.set(seat.playerId, ref);
      }

      return [
        {
          observer: query.observer,
          observerPlayerId,
          handId: source.handId,
          sessionId: source.sessionId,
          ord: source.ord,
          // Tournament（Phase 8）はまだ無いので、保存済みの Hand はすべて cash。
          context: "cash",
          seats: started.seats.map((s) => ({
            playerId: s.playerId,
            participant: refOfSeat.get(s.playerId) ?? null,
          })),
          events: events.filter(isObservable).map((event) => {
            const actor = actorOf(event);
            return {
              seq: event.seq,
              visibility: "public",
              subject: actor === null ? null : (refOfSeat.get(actor) ?? null),
              event,
            };
          }),
        },
      ];
    });
}

/**
 * 観察した Hand を、Subject についての Observation（provenance 付き）に平らにする。行為者のいない Event・誰か引けない席・
 * Observer 自身の Event は含めない（Observer 自身の札は public で表にした札でも Subject の Observation にしない）。
 */
export function observationsOf(hands: readonly ObservedHand[]): Observation[] {
  return hands.flatMap((hand) => {
    const self = participantKey(hand.observer);
    return hand.events.flatMap((e): Observation[] =>
      e.subject === null || participantKey(e.subject) === self
        ? []
        : [
            {
              observer: hand.observer,
              subject: e.subject,
              handId: hand.handId,
              seq: e.seq,
              ord: hand.ord,
              visibility: e.visibility,
              context: hand.context,
              event: e.event,
            },
          ],
    );
  });
}

/**
 * Event Store から抽出の入力を読む（保存済みの Hand だけ。進行中の Hand は ord が無く、Hand の途中の情報は KnowledgeState が持つ）。
 * Observer が参加者にいない Session の Hand は Event を読まない。Guest の Observer は今の Session だけを読む。
 * Opponent Memory Reset の区切り（afterOrd）以前の Hand も読まない。
 */
export function loadObservationSources(
  store: ObservationStore,
  query: ObservationQuery,
): ObservationSourceHand[] {
  const participantsOf = new Map<string, readonly SessionParticipant[]>();
  const sources: ObservationSourceHand[] = [];
  for (const handId of store.finishedHandIds()) {
    const sessionId = store.sessionIdOfHand(handId);
    if (sessionId === null) continue;
    if (
      query.observer.kind === "guest" &&
      sessionId !== query.currentSessionId
    ) {
      continue;
    }
    let participants = participantsOf.get(sessionId);
    if (participants === undefined) {
      participants = store.sessionParticipants(sessionId);
      participantsOf.set(sessionId, participants);
    }
    if (observerSeatOf(query.observer, participants) === null) continue;
    const ord = store.savedOrder(handId);
    if (ord === null) {
      throw new RangeError(`保存済みの Hand ${handId} に論理順序の番号が無い`);
    }
    // Opponent Memory Reset の区切り以前の Hand は Event を読まない（extractObservedHands でも外す）。
    if (!afterReset(ord, query)) continue;
    sources.push({
      handId,
      sessionId,
      ord,
      participants,
      events: store.read(handId).map((s) => s.event),
    });
  }
  return sources;
}

/** Event Store から、Observer が見た Hand を抽出する（都度計算。保存しない）。 */
export function extractObservedHandsFromStore(
  store: ObservationStore,
  query: ObservationQuery,
): ObservedHand[] {
  return extractObservedHands(loadObservationSources(store, query), query);
}
