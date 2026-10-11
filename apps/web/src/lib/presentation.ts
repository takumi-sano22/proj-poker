// Presentation Controller（#222・D140・D143）。Live の卓の表示を、server から届いた最新の HeroView（authoritative）と、
// Hero に今見せている卓（displayed）に分ける純関数の集まり。React の状態・時刻・タイマーは hooks/usePresentation.ts が持つ。
// - 入力は Hero に見える View の log（HeroView.log）だけ。各時点の卓は projectHeroView(prefix) で作り、Engine を進め直さない（D38）。
//   Hidden Cards・Future Cards・system Event は log に無いので、演出に入りようがない（D28）。
// - 表示済みの位置は seq で持つ。REST / SSE の重複・順不同は seq の比較で吸収し、seq の飛び番（Hero に見えない Event の分）は
//   欠落として扱わない・画面に出さない（D143 UX06-1）。
// - step の区切りは Replay と共有する（Engine の heroViewStepEnds。裁定と Action に決まった直後の ACTION_TAKEN は 1 step）。
// - 途中の時点の卓は legalActions を持たない（操作の可否は表示が最新に追いついたときだけ。D143）。
import {
  heroViewStepEnds,
  projectHeroView,
  type HandEvent,
  type HeroView,
} from "@proj-poker/engine";
import {
  PRESENTATION_HERO_TURN_SCALE,
  PRESENTATION_MAX_PENDING_STEPS,
  PRESENTATION_SPEED_SCALE,
  PRESENTATION_STEP_MS,
} from "./config.js";
import { lastSeqOf } from "./view-model.js";

/** 表示演出の速度（標準 / 高速 / 超高速 / 演出なし。D140 Q19）。表示の設定で、ゲームの進行・Fast Forward（server）とは別。 */
export type PresentationSpeed = keyof typeof PRESENTATION_SPEED_SCALE;

export const PRESENTATION_SPEEDS: readonly PresentationSpeed[] = [
  "standard",
  "fast",
  "turbo",
  "none",
];

export const PRESENTATION_SPEED_LABELS: Record<PresentationSpeed, string> = {
  standard: "標準",
  fast: "高速",
  turbo: "超高速",
  none: "演出なし",
};

export type StepKind = keyof typeof PRESENTATION_STEP_MS;

/** 表示の 1 step（Replay の 1 step と同じ区切り）。events は Hero に見える Event だけ。 */
export interface PresentationStep {
  readonly events: readonly HandEvent[];
  /** この step の最後の Event の seq（表示済みの位置として持つ値）。 */
  readonly endSeq: number;
  readonly kind: StepKind;
}

/**
 * 表示の状態。handId の Hand の、seq が shownSeq 以下の Event まで表示した（displayed）。busyUntil は今の step の演出が終わる時刻
 * （この時刻までは次の step を出さない。ミリ秒の時刻）。
 */
export interface PresentationState {
  readonly handId: string | null;
  readonly shownSeq: number;
  readonly busyUntil: number;
}

export const INITIAL_PRESENTATION: PresentationState = {
  handId: null,
  shownSeq: -1,
  busyUntil: 0,
};

/**
 * 演出の進め方の入力。
 * - speed: 実際に使う速度（prefers-reduced-motion では呼び出し側が演出なしにする）
 * - flush: 演出より優先する表示（CPU の障害のダイアログ）があるので、残りの演出を省いて最新に追いつく
 * - holdThroughSeq: この seq を含む step より先を出さない（null は制限なし）。ETIQUETTE の確認（Ack。#226・D145）を待つ裁定の seq で、
 *   裁定の step を出したところで表示を止めておく。受け取り（最初の Hand・有界のキューの切り詰め）・Skip・同期・障害の優先のどれも越えない
 */
export interface PresentationOptions {
  readonly speed: PresentationSpeed;
  readonly flush: boolean;
  readonly holdThroughSeq: number | null;
}

/** Hand の始まり（Blind・Ante・Hero の札の配布）。新しい Hand はここまでを一度に出してから、続きを演出する。 */
const SETUP_EVENT_TYPES: ReadonlySet<HandEvent["type"]> = new Set([
  "HAND_STARTED",
  "BLIND_POSTED",
  "ANTE_POSTED",
  "HOLE_CARD_DEALT",
]);

/** step の種類（所要時間を決める）。最後の Event で決める。 */
export function stepKindOf(events: readonly HandEvent[]): StepKind {
  const last = events.at(-1);
  switch (last?.type) {
    case "ACTION_TAKEN":
      return "action";
    case "BOARD_DEALT":
      return last.street === "flop" ? "flop" : "board";
    case "CARDS_TABLED":
      return "showdown";
    case "UNCALLED_BET_RETURNED":
    case "POT_AWARDED":
      return "pot";
    case "HAND_FINISHED":
    case "HAND_ABORTED":
      return "finish";
    default:
      return "other";
  }
}

/** View の log を表示の step に区切る（Replay と同じ区切り）。 */
export function stepsOf(view: HeroView): PresentationStep[] {
  const log = view.log;
  let start = 0;
  return heroViewStepEnds(log).map((end) => {
    const events = log.slice(start, end + 1);
    start = end + 1;
    return {
      events,
      endSeq: (log[end] as HandEvent).seq,
      kind: stepKindOf(events),
    };
  });
}

/** まだ表示していない step（seq の順）。別の Hand の状態なら、その Hand の全部。 */
export function pendingSteps(
  state: PresentationState,
  authoritative: HeroView,
): PresentationStep[] {
  const shown = state.handId === authoritative.handId ? state.shownSeq : -1;
  return stepsOf(authoritative).filter((s) => s.endSeq > shown);
}

/** 表示が最新の View に追いついているか（displayed の lastSeq = authoritative の lastSeq）。 */
export function isSynced(
  state: PresentationState,
  authoritative: HeroView,
): boolean {
  return (
    state.handId === authoritative.handId &&
    state.shownSeq >= lastSeqOf(authoritative)
  );
}

/**
 * 今 Hero に見せる卓（displayed）。追いついていれば authoritative そのもの（操作の legalActions を持つ）。途中なら表示済みの Event の
 * prefix から作り、legalActions を持たせない（Replay の step と同じ作り方）。
 */
export function displayedView(
  state: PresentationState,
  authoritative: HeroView,
): HeroView {
  if (state.handId !== authoritative.handId || isSynced(state, authoritative)) {
    return authoritative;
  }
  const prefix = authoritative.log.filter((e) => e.seq <= state.shownSeq);
  if (prefix.length === 0) return authoritative;
  return {
    ...projectHeroView(prefix, authoritative.viewerId),
    legalActions: null,
  };
}

/** step の演出の所要時間（ミリ秒）。Hero の手番が来ていれば、Showdown の公開と Pot の配分以外を速める（Q20）。 */
export function stepDurationMs(
  step: PresentationStep,
  speed: PresentationSpeed,
  heroTurn: boolean,
): number {
  const base =
    PRESENTATION_STEP_MS[step.kind] * PRESENTATION_SPEED_SCALE[speed];
  const keepsPace = step.kind === "showdown" || step.kind === "pot";
  return Math.round(
    heroTurn && !keepsPace ? base * PRESENTATION_HERO_TURN_SCALE : base,
  );
}

/** holdThroughSeq より先の step か（先頭の Event がその seq より後なら出さない）。 */
function heldBack(step: PresentationStep, hold: number | null): boolean {
  const first = step.events[0];
  return hold !== null && first !== undefined && first.seq > hold;
}

/**
 * 新しく届いた authoritative を受け取る。
 * - 同じ Hand: 表示済みの位置はそのまま（重複・古い View は位置を動かさない）。待ちが上限を超えたら、古い分を動きなしで表示済みにする
 * - 別の Hand: このセッションで最初の Hand（読み込み直後・Resume）は最新に合わせ、続く Hand（次の Hand・次の Drill）は
 *   Hand の始まり（Blind・Ante・Hero の札）までを出してから続きを演出する
 * - holdThroughSeq（ETIQUETTE の確認待ち。#226）があれば、どの場合もその seq を含む step より先へは進めない（最初の Hand の
 *   「最新に合わせる」・上限を超えた分の切り詰めも越えない。確認を待つ裁定の RULING を出す前に、続きの卓を見せない）
 */
export function receive(
  state: PresentationState,
  authoritative: HeroView,
  holdThroughSeq: number | null,
): PresentationState {
  if (state.handId !== authoritative.handId) {
    const fresh: PresentationState = {
      handId: authoritative.handId,
      shownSeq: heldSeq(
        stepsOf(authoritative),
        lastSeqOf(authoritative),
        holdThroughSeq,
      ),
      busyUntil: 0,
    };
    if (state.handId === null) return fresh;
    const steps = stepsOf(authoritative);
    let shownSeq = steps[0]?.endSeq ?? fresh.shownSeq;
    for (const step of steps) {
      if (!step.events.every((e) => SETUP_EVENT_TYPES.has(e.type))) break;
      shownSeq = step.endSeq;
    }
    return bound({ ...fresh, shownSeq }, authoritative, holdThroughSeq);
  }
  return bound(state, authoritative, holdThroughSeq);
}

/**
 * 待ちの step を上限までに切り詰める（有界のキュー）。holdThroughSeq より先の step は切り詰めでも表示済みにしない
 * （確認待ちの間は、その先の待ちが上限を超えても残す。確認の後に、改めて切り詰める）。
 */
function bound(
  state: PresentationState,
  authoritative: HeroView,
  holdThroughSeq: number | null,
): PresentationState {
  const pending = pendingSteps(state, authoritative);
  const over = pending.length - PRESENTATION_MAX_PENDING_STEPS;
  if (over <= 0) return state;
  const shownSeq = heldSeq(
    pending,
    (pending[over - 1] as PresentationStep).endSeq,
    holdThroughSeq,
  );
  return shownSeq <= state.shownSeq ? state : { ...state, shownSeq };
}

/**
 * target まで表示済みにしたいときの、holdThroughSeq を越えない位置。hold を含む step（裁定の step）までは表示済みにしてよく、
 * それより先の step（先頭の Event が hold より後）は表示済みにしない。hold が無ければ target のまま。
 */
function heldSeq(
  steps: readonly PresentationStep[],
  target: number,
  holdThroughSeq: number | null,
): number {
  if (holdThroughSeq === null) return target;
  const firstHeld = steps.find((step) => heldBack(step, holdThroughSeq));
  if (firstHeld === undefined) return target;
  // 止める step の直前の Event までを表示済みにできる（seq は単調なので、止める step の先頭より前）。
  const limit = (firstHeld.events[0] as HandEvent).seq - 1;
  return Math.min(target, limit);
}

/**
 * 残りの演出を省いて最新の公開状態に合わせる（Skip・再接続・画面への復帰・タブの再表示・送信前の同期）。
 * holdThroughSeq があれば、その step までにとどめる。
 */
export function syncNow(
  state: PresentationState,
  authoritative: HeroView,
  holdThroughSeq: number | null,
): PresentationState {
  const received = receive(state, authoritative, holdThroughSeq);
  let shownSeq = received.shownSeq;
  for (const step of pendingSteps(received, authoritative)) {
    if (heldBack(step, holdThroughSeq)) break;
    shownSeq = step.endSeq;
  }
  return shownSeq === received.shownSeq && received.busyUntil === 0
    ? received
    : { handId: received.handId, shownSeq, busyUntil: 0 };
}

/**
 * 時刻 now までに出せる step を出す（決定論: 同じ入力なら同じ結果）。今の step の演出が終わっていなければ何もしない。
 * 所要時間が 0 の step（演出なし）は続けて出す。flush（障害のダイアログ）なら最新まで一度に出す。
 */
export function settle(
  state: PresentationState,
  authoritative: HeroView,
  now: number,
  options: PresentationOptions,
): PresentationState {
  if (options.flush) {
    return syncNow(state, authoritative, options.holdThroughSeq);
  }
  let current = receive(state, authoritative, options.holdThroughSeq);
  const heroTurn = authoritative.legalActions !== null;
  for (const step of pendingSteps(current, authoritative)) {
    if (heldBack(step, options.holdThroughSeq) || now < current.busyUntil) {
      break;
    }
    current = {
      handId: current.handId,
      shownSeq: step.endSeq,
      busyUntil: now + stepDurationMs(step, options.speed, heroTurn),
    };
  }
  return current;
}

/**
 * 時刻に依らずに決まる分だけを反映する（届いた View の受け取り・演出なし・障害の優先）。描画の中で使い、時刻で進める分は settle。
 */
export function settleWithoutClock(
  state: PresentationState,
  authoritative: HeroView,
  options: PresentationOptions,
): PresentationState {
  return options.flush || options.speed === "none"
    ? syncNow(state, authoritative, options.holdThroughSeq)
    : receive(state, authoritative, options.holdThroughSeq);
}

/** 次の step を出せる時刻（待ちが無い・止めている間は null）。タイマーの設定に使う。 */
export function nextDueAt(
  state: PresentationState,
  authoritative: HeroView,
  options: PresentationOptions,
): number | null {
  const next = pendingSteps(state, authoritative)[0];
  if (next === undefined || heldBack(next, options.holdThroughSeq)) return null;
  return state.busyUntil;
}

/**
 * Hero の操作を送ってよいか（D143・D146）。Hero が見ていた卓（displayed）が最新の View と同じ Hand・同じ lastSeq のときだけ送る。
 * 違えば古い操作を送らず、呼び出し側が表示を最新に合わせて、Hero にもう一度確定させる（暗黙に送らない・stale_view を自動で送り直さない）。
 */
export function canSendFrom(
  shown: HeroView,
  authoritative: HeroView | null,
): boolean {
  return (
    authoritative !== null &&
    shown.handId === authoritative.handId &&
    lastSeqOf(shown) === lastSeqOf(authoritative)
  );
}
