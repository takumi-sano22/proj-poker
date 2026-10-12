// Hero の未送信の操作の下書き（TurnDraft）の寿命の規則（UX-04 #219・D146・D139・D143）。React に依らない純関数で、
// useHandSession が Session（通常の卓 / Drill）ごとに 1 つ持つ。下書きは client のメモリにだけ置き、Event Log・API・DB・
// ブラウザのストレージに入れない（D90・D62）。合法性・裁定は判定しない（Ruling Engine。D47・D91）。
// - 錨（anchor）: 下書きを組み始めた時点に Hero が見ていた displayed View の operationKey と、その時点の状況（anchorContext）
// - operationKey が変わる（Street・Hand・Hero への新しい裁定）・Hand の完了・Hero が Hand から外れる（Fold / All-in）と無効。
//   中身のあった下書きだけ、捨てたことを通知する（空なら通知しない）
// - operationKey は同じでも状況（currentBet・Hero の streetCommitted）が変わっていたら、送る前に変化を示して再確認させる
//   （下書きは捨てず、Chip・宣言を補正せず、暗黙に送らない）
// - 送信は「始めた」だけでは確定ではない。server が Hero への裁定を足した（応答または最新の View で分かる）ときだけ下書きを捨てる。
//   応答が届かなかった操作は、同じ lastSeq・同じ操作の再送だけを許し、結果が分かるまで新しい操作と混ぜない
import type { Declaration, HeroView, PhysicalAction } from "@proj-poker/engine";
import { EMPTY_DRAFT, declare, type TurnDraft } from "./chip-ops.js";
import { operationKey } from "./view-model.js";

/** 下書きを組み始めた時点の Hero の状況（公開の情報だけ）。送る前にこれと今を比べ、変わっていれば再確認させる（UX04-1=A）。 */
export interface AnchorContext {
  /** その Street の最大の拠出額（Call の基準）。 */
  readonly currentBet: number;
  /** Hero がその Street に出し済みの額。 */
  readonly heroCommitted: number;
}

/** 状況の変化を Hero に示し、もう一度の確定を待っている操作。 */
export interface ContextChange {
  readonly from: AnchorContext;
  readonly to: AnchorContext;
  /** 確定したら送る操作（宣言だけで決まる Fold / Check / Call / All-in の宣言を含みうる。下書きには足していない）。 */
  readonly actions: readonly PhysicalAction[];
}

/**
 * 送った操作。sending は応答を待っている。unknown は応答が届かず、server が受けたかどうかが分からない（同じ lastSeq・同じ操作の
 * 再送だけを許し、結果が分かるまで下書きを変えさせない）。
 */
export interface InFlight {
  readonly lastSeq: number;
  readonly actions: readonly PhysicalAction[];
  readonly phase: "sending" | "unknown";
  /** 前の送信の結果が分からないまま送り直したか（そのときの拒否は、前の送信が受理されていないことを意味しない）。 */
  readonly uncertain: boolean;
}

export interface DraftSlot {
  readonly anchorKey: string;
  readonly anchorContext: AnchorContext;
  readonly draft: TurnDraft;
  readonly change: ContextChange | null;
  readonly inFlight: InFlight | null;
}

/** 下書きを捨てた理由（通知の文に使う）。 */
export type DiscardReason =
  "street" | "hand" | "ruling" | "hand_complete" | "left_hand";

export interface DiscardNotice {
  /** 同じ理由が続いても別の通知として出し直すための番号。 */
  readonly id: number;
  readonly reason: DiscardReason;
}

export interface DraftState {
  readonly slot: DraftSlot | null;
  readonly discarded: DiscardNotice | null;
  readonly nextNoticeId: number;
}

export const INITIAL_DRAFT_STATE: DraftState = {
  slot: null,
  discarded: null,
  nextNoticeId: 1,
};

/** View から Hero の状況を作る。Hero の席が無ければ null。 */
export function anchorContextOf(view: HeroView): AnchorContext | null {
  const hero = view.seats.find((s) => s.playerId === view.viewerId);
  if (hero === undefined) return null;
  return { currentBet: view.currentBet, heroCommitted: hero.streetCommitted };
}

export function sameContext(a: AnchorContext, b: AnchorContext): boolean {
  return a.currentBet === b.currentBet && a.heroCommitted === b.heroCommitted;
}

/** 下書きに中身（手に取った Chip・出した Chip・宣言）があるか。 */
export function hasContent(draft: TurnDraft): boolean {
  return draft.hand.length > 0 || draft.ops.length > 0;
}

/** 画面に出す下書き。送っている間は送った操作の列（宣言だけで決まる宣言を含む）を出す。 */
export function shownDraft(slot: DraftSlot | null): TurnDraft {
  if (slot === null) return EMPTY_DRAFT;
  return slot.inFlight === null
    ? slot.draft
    : { hand: slot.draft.hand, ops: slot.inFlight.actions };
}

/** 結果が分かるまで下書きを変えられない（送信中・応答が届かなかった操作がある）か。 */
export function isLocked(state: DraftState): boolean {
  return state.slot?.inFlight != null;
}

/**
 * lastSeq の時点で送った操作が受理されたか。受理されると server はその時点の直後に、送った操作の Event（宣言は PLAYER_DECLARED・
 * Chip は PHYSICAL_CHIP_ACTION）と Hero への DEALER_RULING を足す（受理された物理的な操作は必ず裁定を 1 つ足す。#242 の T5）。
 * lastSeq より後の Event がまだ無ければ pending、後に別の Event が先に足されていれば、その操作は lastSeq の完全一致
 * （stale_view）で受理されていない（rejected）。Hero の物理的な操作の Event を足すのは Hero の送信だけで、送信は 1 つずつなので
 * 取り違えない（保留した Out-of-Turn の解決は DEALER_RULING だけで、操作の Event を足さない）。
 */
export function operationOutcome(
  view: HeroView,
  lastSeq: number,
): "accepted" | "rejected" | "pending" {
  const next = view.log.find((e) => e.seq > lastSeq);
  if (next === undefined) return "pending";
  return (next.type === "PLAYER_DECLARED" ||
    next.type === "PHYSICAL_CHIP_ACTION") &&
    next.playerId === view.viewerId
    ? "accepted"
    : "rejected";
}

/** displayed の View で下書きがまだ有効か。無効なら理由を返す。 */
function invalidReason(slot: DraftSlot, view: HeroView): DiscardReason | null {
  const key = operationKey(view);
  if (key !== slot.anchorKey) {
    // operationKey は `handId:street:裁定の数`。handId に ":" が入っても分けられるよう、後ろから分ける
    const handAndStreet = (k: string) => k.slice(0, k.lastIndexOf(":"));
    if (!slot.anchorKey.startsWith(`${view.handId}:`)) return "hand";
    if (handAndStreet(slot.anchorKey) !== handAndStreet(key)) return "street";
    return "ruling";
  }
  if (view.status === "complete") return "hand_complete";
  const hero = view.seats.find((s) => s.playerId === view.viewerId);
  if (hero === undefined || hero.folded || hero.allIn) return "left_hand";
  return null;
}

function discard(state: DraftState, reason: DiscardReason): DraftState {
  const slot = state.slot;
  if (slot === null) return state;
  // 中身のあった下書きだけ通知する（UX04-3=A。空の下書きは黙って捨てる）。
  if (!hasContent(slot.draft)) return { ...state, slot: null };
  return {
    slot: null,
    discarded: { id: state.nextNoticeId, reason },
    nextNoticeId: state.nextNoticeId + 1,
  };
}

/**
 * 表示・受信の変化に合わせて下書きを照合する。
 * - 送った操作の結果は authoritative（最新の View）で判定する: 受理されていれば下書きを黙って捨てる（送った下書きの消費）。
 *   受理されていないと分かったら、送った操作の記録を外して下書き（宣言だけで決まる宣言は足していない元の下書き）を戻す
 * - 有効性は displayed（Hero が見ている卓）で判定する（錨は displayed の operationKey。D146）
 */
export function reconcile(
  state: DraftState,
  displayed: HeroView | null,
  authoritative: HeroView | null,
): DraftState {
  let slot = state.slot;
  if (slot === null || displayed === null) return state;
  if (slot.inFlight !== null && authoritative !== null) {
    const outcome = operationOutcome(authoritative, slot.inFlight.lastSeq);
    if (outcome === "accepted") return { ...state, slot: null };
    if (outcome === "rejected" && slot.inFlight.phase === "unknown") {
      slot = { ...slot, inFlight: null };
      state = { ...state, slot };
    }
  }
  // 送った操作の結果を待つ間は捨てない（受理されれば裁定で key が変わる。そのときは消費であって無効化ではない）。
  if (slot.inFlight !== null) return state;
  const reason = invalidReason(slot, displayed);
  return reason === null ? state : discard(state, reason);
}

/**
 * 下書きを変える（Chip を手に取る・出す・戻す・Bet / Raise の宣言）。送った操作の結果を待つ間は変えない。
 * 下書きが無ければ、今の displayed を錨にして組み始める。編集したら、出していた再確認は取り下げる（次の送信で状況を比べ直す）。
 */
export function edit(
  state: DraftState,
  displayed: HeroView,
  authoritative: HeroView | null,
  change: (draft: TurnDraft) => TurnDraft,
): DraftState {
  const current = reconcile(state, displayed, authoritative);
  if (isLocked(current)) return current;
  const slot = current.slot;
  const base = slot?.draft ?? EMPTY_DRAFT;
  const next = change(base);
  if (next === base) return current;
  // 空に戻した下書き（手に取った Chip を全部戻した）は持たない。次に組み始めた時点を錨にする。
  if (!hasContent(next)) return { ...current, slot: null };
  if (slot !== null) {
    return { ...current, slot: { ...slot, draft: next, change: null } };
  }
  const context = anchorContextOf(displayed);
  if (context === null || invalidReasonForNew(displayed)) return current;
  return {
    ...current,
    slot: {
      anchorKey: operationKey(displayed),
      anchorContext: context,
      draft: next,
      change: null,
      inFlight: null,
    },
  };
}

/** 新しく組み始めてよい卓か（Hand が進行中で、Hero が Hand に残っている）。 */
function invalidReasonForNew(view: HeroView): boolean {
  if (view.status === "complete") return true;
  const hero = view.seats.find((s) => s.playerId === view.viewerId);
  return hero === undefined || hero.folded || hero.allIn;
}

/** 送る操作の列。completing は宣言だけで決まる宣言（Fold / Check / Call / All-in）で、下書きには足さずに列の最後に付ける。 */
export function actionsToSend(
  slot: DraftSlot | null,
  completing: Declaration | null,
): readonly PhysicalAction[] {
  const base = slot?.draft ?? EMPTY_DRAFT;
  return completing === null ? base.ops : declare(base, completing).ops;
}

/** 送る前の照合の結果。 */
export type SendCheck =
  | { readonly kind: "send"; readonly state: DraftState }
  | { readonly kind: "changed"; readonly state: DraftState }
  | { readonly kind: "discarded"; readonly state: DraftState }
  | { readonly kind: "ignored"; readonly state: DraftState };

/**
 * 送る直前の照合（view は最新の View に追いついた displayed、または同期で合わせる先の最新の View）。
 * - 錨の operationKey と違えば捨てる（中身があれば通知）
 * - 状況（anchorContext）が変わっていれば送らず、変化を示して再確認を待つ（UX04-1=A）
 * - どちらも同じなら送ってよい。下書きが無いとき（宣言だけで決まる宣言を空の下書きで押した）は、今の卓をそのまま見て決めたので送ってよい
 */
export function checkSend(
  state: DraftState,
  view: HeroView,
  actions: readonly PhysicalAction[],
): SendCheck {
  if (actions.length === 0 || isLocked(state))
    return { kind: "ignored", state };
  const slot = state.slot;
  if (slot === null) return { kind: "send", state };
  const reason = invalidReason(slot, view);
  if (reason !== null)
    return { kind: "discarded", state: discard(state, reason) };
  const now = anchorContextOf(view);
  if (now !== null && !sameContext(slot.anchorContext, now)) {
    return {
      kind: "changed",
      state: {
        ...state,
        slot: {
          ...slot,
          change: { from: slot.anchorContext, to: now, actions },
        },
      },
    };
  }
  return { kind: "send", state };
}

/**
 * 示した状況の変化を Hero が確認して確定した。今の状況が示した変化の後（to）と同じときだけ錨の状況を更新して送ってよい。
 * その間にさらに変わっていたら、古い確認を使わず、新しい変化を示し直す。錨の operationKey と違えば捨てる。
 */
export function confirmChange(
  state: DraftState,
  view: HeroView,
): SendCheck & { readonly actions: readonly PhysicalAction[] } {
  const slot = state.slot;
  const change = slot?.change ?? null;
  if (slot === null || change === null || isLocked(state)) {
    return { kind: "ignored", state, actions: [] };
  }
  const reason = invalidReason(slot, view);
  if (reason !== null) {
    return {
      kind: "discarded",
      state: discard(state, reason),
      actions: [],
    };
  }
  const now = anchorContextOf(view);
  if (now === null) return { kind: "ignored", state, actions: [] };
  if (!sameContext(now, change.to)) {
    return {
      kind: "changed",
      state: {
        ...state,
        slot: { ...slot, change: { ...change, to: now } },
      },
      actions: [],
    };
  }
  return {
    kind: "send",
    state: { ...state, slot: { ...slot, anchorContext: now, change: null } },
    actions: change.actions,
  };
}

/**
 * 操作を送り始めた。下書きが無い（空の下書きで宣言だけを押した）ときも、結果が分かるまでの記録のために作る。
 * 再送（retry）は同じ lastSeq・同じ操作で、前の結果が分からないことを引き継ぐ。
 */
export function markSending(
  state: DraftState,
  displayed: HeroView,
  lastSeq: number,
  actions: readonly PhysicalAction[],
): DraftState {
  const previous = state.slot;
  const uncertain = previous?.inFlight?.phase === "unknown";
  const inFlight: InFlight = { lastSeq, actions, phase: "sending", uncertain };
  if (previous !== null) {
    return { ...state, slot: { ...previous, change: null, inFlight } };
  }
  const context = anchorContextOf(displayed);
  if (context === null) return state;
  return {
    ...state,
    slot: {
      anchorKey: operationKey(displayed),
      anchorContext: context,
      draft: EMPTY_DRAFT,
      change: null,
      inFlight,
    },
  };
}

/** 送信の応答が届いた。accepted は 200（受理。裁定は応答の View にある）。 */
export type SendResult =
  | { readonly kind: "accepted" }
  /** server が拒否した（stale_view・etiquette_ack_required 等。この送信は適用されていない）。 */
  | { readonly kind: "rejected" }
  /** 応答が届かなかった（通信の失敗・応答の消失）。受理されたかどうか分からない。 */
  | { readonly kind: "unknown" };

/**
 * 応答に合わせて送った操作の記録を更新する。
 * - accepted: 下書きを黙って捨てる（送った下書きの消費。応答の View の裁定で operationKey も変わる）
 * - rejected: その送信は適用されていない。前の送信の結果が分からないまま送り直したのでなければ、記録を外して元の下書きに戻す
 *   （宣言だけで決まる宣言は元の下書きに無いので、次の操作に紛れ込まない）。前の結果が分からないなら、最新の View で分かるまで待つ
 * - unknown: 同じ lastSeq・同じ操作の再送だけを許す
 * 送った操作の記録が無い・別の送信のもの（lastSeq が違う）なら何もしない。
 */
export function settleSend(
  state: DraftState,
  lastSeq: number,
  result: SendResult,
): DraftState {
  const slot = state.slot;
  const inFlight = slot?.inFlight ?? null;
  if (slot === null || inFlight === null || inFlight.lastSeq !== lastSeq) {
    return state;
  }
  switch (result.kind) {
    case "accepted":
      return { ...state, slot: null };
    case "rejected":
      if (inFlight.uncertain) {
        return {
          ...state,
          slot: { ...slot, inFlight: { ...inFlight, phase: "unknown" } },
        };
      }
      return hasContent(slot.draft)
        ? { ...state, slot: { ...slot, inFlight: null } }
        : { ...state, slot: null };
    case "unknown":
      return {
        ...state,
        slot: { ...slot, inFlight: { ...inFlight, phase: "unknown" } },
      };
  }
}

/** 通知を閉じた（表示の時間が過ぎた）。別の通知に変わっていれば何もしない。 */
export function dismissDiscarded(state: DraftState, id: number): DraftState {
  return state.discarded?.id === id ? { ...state, discarded: null } : state;
}
