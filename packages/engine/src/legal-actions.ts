// Legal Action の計算と、Player の Action の検証。合法性は Engine だけが決める（D40・docs/02 §1）。
// 判定に使うのは公開情報（Stack・Commit・最高額・Raise 幅）だけなので、Projection の State からも同じ結果が出る。
import type { ActionType, Street } from "./hand-events.js";
import { playerAt, type HandState, type PlayerState } from "./hand-state.js";

/** 行動中の Player に提示する選択肢。bet / raise の min・max は「この Street の累計（to 額）」。 */
export type LegalAction =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  /** amount は追加で出す額。Stack が足りなければ Stack 全額（All-in の Call）。 */
  | { readonly type: "call"; readonly amount: number }
  | { readonly type: "bet"; readonly min: number; readonly max: number }
  | { readonly type: "raise"; readonly min: number; readonly max: number }
  /** amount は All-in 後のこの Street の累計（to 額）。 */
  | { readonly type: "all_in"; readonly amount: number };

export interface LegalActionSet {
  readonly playerId: string;
  /** Call に必要な額（0 なら Check できる）。 */
  readonly toCall: number;
  readonly actions: readonly LegalAction[];
}

/** Player が選ぶ Canonical Action（docs/02 §4）。bet / raise の amount は to 額。 */
export type PlayerAction =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call" }
  | { readonly type: "bet"; readonly amount: number }
  | { readonly type: "raise"; readonly amount: number }
  | { readonly type: "all_in" };

/** 検証済みの Action（ACTION_TAKEN の中身になる）。 */
export interface ResolvedAction {
  readonly playerId: string;
  readonly street: Street;
  readonly action: ActionType;
  readonly amount: number;
  readonly toAmount: number;
  readonly allIn: boolean;
}

/** 現在の Actor の Legal Action。Actor がいなければ null。 */
export function getLegalActions(state: HandState): LegalActionSet | null {
  if (state.status !== "in_progress" || state.actorIndex === null) {
    return null;
  }
  const p = playerAt(state, state.actorIndex);
  const toCall = Math.max(0, state.currentBet - p.streetCommitted);
  const maxTo = p.streetCommitted + p.stack;
  const raiseOpen = canRaise(state, p);
  const actions: LegalAction[] = [{ type: "fold" }];

  if (toCall === 0) {
    actions.push({ type: "check" });
  } else {
    actions.push({ type: "call", amount: Math.min(toCall, p.stack) });
  }
  if (raiseOpen && state.currentBet === 0 && maxTo >= state.bigBlind) {
    // 最小 Bet は 1BB。1BB 未満の Stack は all_in でしか出せない。
    actions.push({ type: "bet", min: state.bigBlind, max: maxTo });
  }
  const minRaiseTo = state.currentBet + state.lastRaiseSize;
  if (raiseOpen && state.currentBet > 0 && maxTo >= minRaiseTo) {
    actions.push({ type: "raise", min: minRaiseTo, max: maxTo });
  }
  // All-in は「Call に届かない／ちょうど Call」か「Raise してよい」場合だけ合法（Raise 不可の局面で上乗せさせない）。
  if (p.stack > 0 && (maxTo <= state.currentBet || raiseOpen)) {
    actions.push({ type: "all_in", amount: maxTo });
  }
  return { playerId: p.playerId, toCall, actions };
}

/**
 * Raise（Bet を含む）してよいか。
 * - この Street で未行動、または自分の行動の後に Full Raise があった（Short All-in だけでは再開しない）
 * - 自分以外に、まだ Chip を出せる相手が残っている
 * 累積 Short All-in による再開は Phase 2（D70）。
 */
function canRaise(state: HandState, p: PlayerState): boolean {
  const reopened =
    p.actedAtRaiseCount === null || p.actedAtRaiseCount < state.fullRaiseCount;
  const opponentCanAct = state.players.some(
    (q) => q.playerId !== p.playerId && !q.folded && !q.allIn,
  );
  return reopened && opponentCanAct;
}

export type ActionRejection =
  | { readonly kind: "hand_complete"; readonly message: string }
  | { readonly kind: "not_actor"; readonly message: string }
  | { readonly kind: "illegal_action"; readonly message: string };

/** Action を検証して ACTION_TAKEN の中身にする。合法でなければ理由を返す（State は変えない）。 */
export function resolveAction(
  state: HandState,
  playerId: string,
  action: PlayerAction,
): { ok: true; value: ResolvedAction } | { ok: false; error: ActionRejection } {
  const legal = getLegalActions(state);
  if (state.status !== "in_progress" || legal === null) {
    return reject("hand_complete", "この Hand は行動を受け付けていない");
  }
  if (legal.playerId !== playerId) {
    return reject(
      "not_actor",
      `手番ではない: ${playerId}（手番は ${legal.playerId}）`,
    );
  }
  const p = playerAt(state, state.actorIndex as number);
  const option = legal.actions.find((a) => a.type === action.type);
  if (option === undefined) {
    return reject("illegal_action", `今は ${action.type} できない`);
  }

  const resolved = (toAmount: number): ResolvedAction => {
    const amount = toAmount - p.streetCommitted;
    return {
      playerId,
      street: state.street,
      action: action.type,
      amount,
      toAmount,
      allIn: amount === p.stack && amount > 0,
    };
  };

  switch (option.type) {
    case "fold":
    case "check":
      return { ok: true, value: resolved(p.streetCommitted) };
    case "call":
      return { ok: true, value: resolved(p.streetCommitted + option.amount) };
    case "all_in":
      return { ok: true, value: resolved(option.amount) };
    case "bet":
    case "raise": {
      const amount = "amount" in action ? action.amount : Number.NaN;
      if (
        !Number.isSafeInteger(amount) ||
        amount < option.min ||
        amount > option.max
      ) {
        return reject(
          "illegal_action",
          `${option.type} の額は ${option.min}〜${option.max} の整数: ${amount}`,
        );
      }
      return { ok: true, value: resolved(amount) };
    }
  }
}

function reject(
  kind: ActionRejection["kind"],
  message: string,
): { ok: false; error: ActionRejection } {
  return { ok: false, error: { kind, message } };
}
