// CPU の Tilt（D107・D119・#140。docs/05 §4・docs/04 §12）。Version 付きの決定論 State Machine で、保存しない transient な状態。
// - Session の中の席（その Session の参加者）ごとの状態で、Fixed CPU の Long-term Memory（memory/ の Hypothesis）や Persona とは別の層
// - 今の Session の保存済み（終わった）Hand を論理順序（ordinals.ord）で頭から畳み込んで作る純粋関数。Session が変われば 0 から始まる
//   （＝ Session 終了で Reset。SESSION_ENDED の無い放置された Session でも次の Session には持ち越さない）。Resume では同じ Session の
//   Hand から同じ値になる。壁時計を使わない（D117）
// - 入力はその CPU が卓で見えた Event（public と自分宛ての private）と自分の結果だけ。他者の Hidden Cards・Deck・system の記録・
//   Learning-only Reveal・Hero の弱点（apps/server/src/learning/）は読まない
// - 反映は Persona の Looseness / Aggression を段階ごとに上限付きで少しずらすだけで、Illegal / Random な Action を作らない（D40）
// - Hero の Evidence・Review・UI・Event に出さない。他の CPU の KnowledgeState・Prompt に出さない
import {
  evaluateHand,
  HandCategory,
  isVisibleTo,
  visibilityOf,
  type Card,
  type HandEvent,
} from "@proj-poker/engine";
import type { EventStore } from "../event-store.js";
import type { PersonaTraits } from "./persona.js";
import {
  DEFAULT_TILT_POLICY,
  TILT_POLICIES,
  type TiltPolicy,
} from "./tilt-policy.js";

/** 畳み込みの入力の 1 Hand（今の Session の保存済みの Hand）。 */
export interface TiltSourceHand {
  readonly handId: string;
  /** Hand の保存の論理順序（ordinals.ord。D117）。 */
  readonly ord: number;
  /** その Hand の全 Event（正本。ここで CPU に見えたものだけに絞る）。 */
  readonly events: readonly HandEvent[];
}

/**
 * 1 Hand の CPU 自身の結果（CPU が見えた Event だけから決める）。Trigger の定義（phase7_tilt_v1。OI-011 の暫定値）:
 * - lostShowdown: Fold せずに Showdown まで残り（札を比べた Pot を争えた）、Pot を 1 枚も受け取らなかった
 * - bigPotLost: lostShowdown で、争えた Pot の総額が bigPotBigBlinds × その Hand の Big Blind 以上
 * - bluffCaught: lostShowdown で、その Hand の最後に額を引き上げた（Bet / Raise / 額を上げる All-in）のが自分で、
 *   Board 5 枚に対して自分の 2 枚で役が上がっておらず（自分の 7 枚の役の種類が Board 5 枚だけの役の種類と同じ）、その役が One Pair 以下
 * - bigWin: 収支（受け取った額 − 出した額）がプラスで、受け取った Pot の総額が bigPotBigBlinds × Big Blind 以上（Overconfidence）
 * - wonPot: Pot を 1 枚でも受け取った（連敗を切る）
 */
export interface TiltHandOutcome {
  readonly lostShowdown: boolean;
  readonly wonPot: boolean;
  readonly bigPotLost: boolean;
  readonly bluffCaught: boolean;
  readonly bigWin: boolean;
}

/** 畳み込みの途中の状態。level だけが外へ出る値で、残りは State Machine の内部の数え（保存しない）。 */
export interface TiltState {
  /** 0〜maxLevel の整数。 */
  readonly level: number;
  /** 最後に段が変わってから続いた、Trigger の無い Hand の数（level が 0 の間は 0）。 */
  readonly calmHands: number;
  /** Showdown の負けの連続（Pot を受け取った Hand で 0 に戻る。Fold した Hand・座らなかった Hand では変えない）。 */
  readonly lossStreak: number;
}

export const INITIAL_TILT_STATE: TiltState = {
  level: 0,
  calmHands: 0,
  lossStreak: 0,
};

/** CPU の KnowledgeState に足す、その CPU 自身の Tilt（1 以上のときだけ持つ。0 のときは項目ごと持たず、Prompt を変えない）。 */
export interface CpuTilt {
  /** 1〜maxLevel の整数。 */
  readonly level: number;
  readonly maxLevel: number;
  readonly policyVersion: string;
}

/** Tilt を作る CPU の席（Persona の無い CPU は Tilt を持たない）。 */
export interface TiltSeat {
  readonly playerId: string;
  readonly traits: Pick<PersonaTraits, "tiltSusceptibility" | "recoverySpeed">;
}

/**
 * その CPU が卓で見えた Event か。保存された Visibility と Engine が種類から決める Visibility の両方が、public か自分宛ての private の
 * ときだけ通す（保存された値だけを信じない。Deck の engine・system の記録・他者宛ての private は落ちる）。
 */
function seenBy(event: HandEvent, playerId: string): boolean {
  return (
    isVisibleTo(event, playerId) &&
    isVisibleTo({ ...event, visibility: visibilityOf(event) }, playerId)
  );
}

/**
 * 1 Hand の CPU 自身の結果。CPU が座っていない Hand・HAND_FINISHED の無い Hand（打ち切った Hand）は null（Tilt を動かさない）。
 * 入力は seq の順でなくてもよい（ここで並べる）。
 */
export function tiltHandOutcome(
  events: readonly HandEvent[],
  playerId: string,
  policy: TiltPolicy = DEFAULT_TILT_POLICY,
): TiltHandOutcome | null {
  const seen = [...events]
    .filter((e) => seenBy(e, playerId))
    .sort((a, b) => a.seq - b.seq);
  const started = seen.find((e) => e.type === "HAND_STARTED");
  if (started?.type !== "HAND_STARTED") return null;
  if (!started.seats.some((s) => s.playerId === playerId)) return null;
  if (!seen.some((e) => e.type === "HAND_FINISHED")) return null;

  let committed = 0;
  let received = 0;
  let contestedShowdown = false;
  let eligiblePots = 0;
  let wonPots = 0;
  // その Hand の最後に額を引き上げた者（Street ごとの最大の to 額を超えた Bet / Raise / All-in）。
  let lastAggressor: string | null = null;
  let street: string | null = null;
  let level = 0;
  const board: Card[] = [];
  let tabled: readonly Card[] | null = null;
  for (const e of seen) {
    switch (e.type) {
      case "BLIND_POSTED":
        if (e.playerId === playerId) committed += e.amount;
        level = Math.max(level, e.amount);
        break;
      case "ACTION_TAKEN":
        if (e.playerId === playerId) committed += e.amount;
        if (e.street !== street) {
          // Preflop は Blind の額から、Postflop は 0 から数える。
          if (street !== null) level = 0;
          street = e.street;
        }
        if (
          (e.action === "bet" ||
            e.action === "raise" ||
            e.action === "all_in") &&
          e.toAmount > level
        ) {
          lastAggressor = e.playerId;
        }
        level = Math.max(level, e.toAmount);
        break;
      case "UNCALLED_BET_RETURNED":
        if (e.playerId === playerId) committed -= e.amount;
        break;
      case "BOARD_DEALT":
        board.push(...e.cards);
        break;
      case "CARDS_TABLED":
        if (e.playerId === playerId) tabled = e.cards;
        break;
      case "POT_AWARDED": {
        const share = e.awards
          .filter((a) => a.playerId === playerId)
          .reduce((sum, a) => sum + a.amount, 0);
        received += share;
        if (e.eligible.includes(playerId)) {
          eligiblePots += e.potTotal;
          if (e.showdown) contestedShowdown = true;
        }
        if (share > 0) wonPots += e.potTotal;
        break;
      }
      default:
        break;
    }
  }

  const bigPot = policy.bigPotBigBlinds * started.bigBlind;
  const wonPot = received > 0;
  const lostShowdown = contestedShowdown && !wonPot;
  return {
    lostShowdown,
    wonPot,
    bigPotLost: lostShowdown && eligiblePots >= bigPot,
    bluffCaught:
      lostShowdown &&
      lastAggressor === playerId &&
      tabled !== null &&
      madeNothing(tabled, board),
    bigWin: received - committed > 0 && wonPots >= bigPot,
  };
}

/** 自分の 2 枚で役が上がっていない（7 枚の役の種類が Board 5 枚だけと同じ）で、その役が One Pair 以下か。 */
function madeNothing(hole: readonly Card[], board: readonly Card[]): boolean {
  if (board.length !== 5 || hole.length !== 2) return false;
  const own = evaluateHand([...hole, ...board]).category;
  return own === evaluateHand(board).category && own <= HandCategory.Pair;
}

/**
 * 1 Hand 分の遷移（純粋関数）。outcome が null（座っていない・打ち切った Hand）なら変えない。
 * - Trigger（大きい Pot の負け・連敗・Bluff が見つかる・大勝ち）の数と tiltSusceptibility から上がる段を決め、上がったら calmHands を 0 に戻す
 * - 上がらなかった Hand は calmHands を 1 つ進め、recoverySpeed で決まる数に達したら 1 段下げる（0 の間は数えない）
 */
export function stepTilt(
  state: TiltState,
  outcome: TiltHandOutcome | null,
  traits: TiltSeat["traits"],
  policy: TiltPolicy = DEFAULT_TILT_POLICY,
): TiltState {
  if (outcome === null) return state;
  let lossStreak = outcome.wonPot
    ? 0
    : outcome.lostShowdown
      ? state.lossStreak + 1
      : state.lossStreak;
  const streakHit = lossStreak >= policy.lossStreak;
  // 連敗は Trigger になったら数え直す（次の 3 連敗でまた上がる）。
  if (streakHit) lossStreak = 0;
  const triggers = [
    outcome.bigPotLost,
    streakHit,
    outcome.bluffCaught,
    outcome.bigWin,
  ].filter(Boolean).length;
  const rise = policy.rise(triggers, traits.tiltSusceptibility);
  if (rise > 0) {
    return {
      level: Math.min(policy.maxLevel, state.level + rise),
      calmHands: 0,
      lossStreak,
    };
  }
  if (state.level === 0) return { level: 0, calmHands: 0, lossStreak };
  const calmHands = state.calmHands + 1;
  return calmHands >= policy.calmHandsPerStep(traits.recoverySpeed)
    ? { level: state.level - 1, calmHands: 0, lossStreak }
    : { level: state.level, calmHands, lossStreak };
}

/**
 * 今の Session の保存済みの Hand を論理順序（ord の小さい順）で頭から畳み込んだ Tilt（純粋関数。同じ入力なら同じ結果）。
 * 入力の並び・壁時計に依らない。ord の重複・不正は拒否する。
 */
export function foldTilt(
  hands: readonly TiltSourceHand[],
  seat: TiltSeat,
  policy: TiltPolicy = DEFAULT_TILT_POLICY,
): TiltState {
  const ords = new Set<number>();
  for (const h of hands) {
    if (!Number.isSafeInteger(h.ord) || ords.has(h.ord)) {
      throw new RangeError(
        `Hand ${h.handId} の論理順序の番号 ${h.ord} が不正か重複している`,
      );
    }
    ords.add(h.ord);
  }
  return [...hands]
    .sort((a, b) => a.ord - b.ord)
    .reduce(
      (state, h) =>
        stepTilt(
          state,
          tiltHandOutcome(h.events, seat.playerId, policy),
          seat.traits,
          policy,
        ),
      INITIAL_TILT_STATE,
    );
}

/** 畳み込みが読む Event Store の部分（保存済みの Hand・その Session・論理順序）。 */
export type TiltStore = Pick<
  EventStore,
  "finishedHandIds" | "sessionIdOfHand" | "savedOrder" | "read"
>;

/** Event Store から、その Session の保存済み（終わった）Hand を読む。進行中の Hand は ord が無いので入らない。 */
export function loadTiltSources(
  store: TiltStore,
  sessionId: string,
): TiltSourceHand[] {
  const sources: TiltSourceHand[] = [];
  for (const handId of store.finishedHandIds()) {
    if (store.sessionIdOfHand(handId) !== sessionId) continue;
    const ord = store.savedOrder(handId);
    if (ord === null) {
      throw new RangeError(`保存済みの Hand ${handId} に論理順序の番号が無い`);
    }
    sources.push({
      handId,
      ord,
      events: store.read(handId).map((s) => s.event),
    });
  }
  return sources;
}

/**
 * Hand の開始時に、今の Session の席ごとの Tilt を作る（Hand Orchestrator が、その Hand を Event Store へ書く前に呼ぶ）。
 * 1 以上の席だけを返す（0 の席は KnowledgeState に項目ごと持たせない）。Session の Hand は 1 回だけ読み、席ごとに畳み込む。
 */
export function buildTiltsFromStore(
  store: TiltStore,
  query: { readonly sessionId: string; readonly seats: readonly TiltSeat[] },
  policy: TiltPolicy = DEFAULT_TILT_POLICY,
): ReadonlyMap<string, CpuTilt> {
  const tilts = new Map<string, CpuTilt>();
  if (query.seats.length === 0) return tilts;
  const hands = loadTiltSources(store, query.sessionId);
  for (const seat of query.seats) {
    const { level } = foldTilt(hands, seat, policy);
    if (level > 0) {
      tilts.set(seat.playerId, {
        level,
        maxLevel: policy.maxLevel,
        policyVersion: policy.version,
      });
    }
  }
  return tilts;
}

/** CpuTilt の Version の Policy。知らない Version は作った側の誤りなので拒否する（黙って別の Policy で反映しない）。 */
export function tiltPolicyOf(tilt: CpuTilt): TiltPolicy {
  const policy = TILT_POLICIES[tilt.policyVersion];
  if (policy === undefined) {
    throw new RangeError(`Tilt の Policy ${tilt.policyVersion} を知らない`);
  }
  return policy;
}
