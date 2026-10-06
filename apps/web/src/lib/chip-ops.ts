// Hero の 1 回の手番の物理的な操作（PhysicalAction。docs/02 §4）を組み立てる純粋関数（docs/06 §4・§5。D44・D46・D47）。
// ここでは合法性も裁定も判定しない（D40・D91）。誤操作になる組み合わせ（Out-of-Turn・Oversized Chip・String Bet・
// Bet の局面での Raise の宣言など）もそのまま組み、裁定はサーバーの Ruling Engine に任せる。
// 例外は「持っていない Chip は出せない」だけで、これは誤操作ではなく物理的にできない操作なので、手元に取れる額を Stack で抑える。
import type {
  ChipCount,
  ChipDenomination,
  Declaration,
  PhysicalAction,
} from "@proj-poker/engine";

/**
 * 送る前の手番の操作。
 * - hand: 手に取った Chip（まだ Betting Area に出していない。出す前なら戻せる）
 * - ops: Betting Area に出した Chip と宣言（した順）。卓に出した操作は取り消せない（実卓と同じ）
 */
export interface TurnDraft {
  readonly hand: readonly number[];
  readonly ops: readonly PhysicalAction[];
}

export const EMPTY_DRAFT: TurnDraft = { hand: [], ops: [] };

function sum(chips: readonly number[]): number {
  return chips.reduce((total, c) => total + c, 0);
}

/**
 * 額面の列を額面ごとの枚数にまとめる（大きい額面が先。composeChips と同じ並び）。額から組み直さないので、
 * 出した Chip の枚数がそのまま残る。denominations に無い額面は数えない（呼び出し側は Config の額面だけを出す）。
 */
export function countChips(
  chips: readonly number[],
  denominations: readonly ChipDenomination[],
): ChipCount[] {
  return [...denominations]
    .sort((a, b) => b.value - a.value)
    .map((denomination) => ({
      denomination,
      count: chips.filter((c) => c === denomination.value).length,
    }))
    .filter((c) => c.count > 0);
}

/** 手に取っている Chip の額。 */
export function handTotal(draft: TurnDraft): number {
  return sum(draft.hand);
}

/** この手番で Betting Area に出した Chip の額（動作ごとの合計の和）。 */
export function pushedTotal(draft: TurnDraft): number {
  return draft.ops.reduce(
    (total, op) => (op.type === "declare" ? total : total + sum(op.chips)),
    0,
  );
}

/** Betting Area に出した Chip の動作の列（1 回の動作ごと）。 */
export function pushedMotions(draft: TurnDraft): (readonly number[])[] {
  return draft.ops.flatMap((op) => (op.type === "declare" ? [] : [op.chips]));
}

/** まだ手に取れる額（Stack から、手に取った分と出した分を引いた額）。 */
export function remainingStack(stack: number, draft: TurnDraft): number {
  return stack - handTotal(draft) - pushedTotal(draft);
}

/** その額面の Chip を 1 枚手に取る。持っている額を超えるなら変えない（物理的に出せない）。 */
export function pickChip(
  draft: TurnDraft,
  stack: number,
  value: number,
): TurnDraft {
  if (value > remainingStack(stack, draft)) return draft;
  return { ...draft, hand: [...draft.hand, value] };
}

/** 手に取った Chip を全部 Stack に戻す（Betting Area に出す前なので戻せる）。 */
export function returnHand(draft: TurnDraft): TurnDraft {
  return { ...draft, hand: [] };
}

/**
 * Chip を 1 回の動作で Betting Area に出す。この手番の最初の Chip の動作は chip_push、2 回目以降は chip_add
 * （String Bet の判定に使う区別。Ruling Engine の入力の規則）。
 */
function pushChips(draft: TurnDraft, chips: readonly number[]): TurnDraft {
  if (chips.length === 0) return draft;
  const type = pushedMotions(draft).length === 0 ? "chip_push" : "chip_add";
  return { ...draft, ops: [...draft.ops, { type, chips: [...chips] }] };
}

/** 手に取った Chip をまとめて 1 回の動作で出す。 */
export function pushHand(draft: TurnDraft): TurnDraft {
  return returnHand(pushChips(draft, draft.hand));
}

/** Stack の Chip を 1 枚、直接（手に取らずに）出す。持っている額を超えるなら変えない。 */
export function pushChip(
  draft: TurnDraft,
  stack: number,
  value: number,
): TurnDraft {
  if (value > remainingStack(stack, draft)) return draft;
  return pushChips(draft, [value]);
}

/** 宣言 Button の種類（docs/06 §5）。 */
export type DeclarationKind = Declaration["kind"];

/** その宣言だけで Action が決まり、宣言した時点で Dealer に渡す種類か（Bet / Raise は続けて Chip を出す）。 */
export function completesTurn(kind: DeclarationKind): boolean {
  return kind !== "bet" && kind !== "raise";
}

/**
 * 宣言を組む。Bet / Raise は、手に Chip を持っていればその額を「この Street の累計（to 額）」として宣言し、
 * 持っていなければ額なしで宣言する（額は続けて出した Chip で決まる）。committed はこの Street に出し済みの額。
 */
export function declarationOf(
  kind: DeclarationKind,
  committed: number,
  draft: TurnDraft,
): Declaration {
  if (kind !== "bet" && kind !== "raise") return { kind };
  const held = handTotal(draft);
  return held > 0 ? { kind, amount: committed + held } : { kind };
}

/** 宣言を操作の列に足す（Chip の後の宣言・2 つ目の宣言も、そのまま足して裁定に任せる）。 */
export function declare(draft: TurnDraft, declaration: Declaration): TurnDraft {
  return {
    ...draft,
    ops: [...draft.ops, { type: "declare", declaration }],
  };
}
