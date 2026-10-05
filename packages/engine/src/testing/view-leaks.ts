// Projection の情報漏れ検査（INV-TEST-007 の Engine 側。docs/02 §2 INV-INFO-001）。
// View を丸ごと走査して Card を全部拾い、「viewer が知ってよい Card」以外が 1 枚でもあれば違反とする。
// フィールド名に頼らず値を走査するので、View に項目が増えても漏れを見逃さない。
import { cardToString, type Card } from "../card.js";
import type { HandState } from "../hand-state.js";

/** viewer が知ってよい Card: 自分の札・公開済み Board・Showdown で公開された札。 */
export function allowedCards(state: HandState, viewerId: string): Set<string> {
  const allowed = new Set(state.board.map(cardToString));
  for (const p of state.players) {
    if ((p.playerId === viewerId || p.shown) && p.holeCards !== null) {
      p.holeCards.forEach((c) => allowed.add(cardToString(c)));
    }
  }
  return allowed;
}

/** 値の中の Card（rank と suit を持つ object）を全部拾う。 */
export function collectCards(value: unknown, found: Card[] = []): Card[] {
  if (Array.isArray(value)) {
    value.forEach((v) => collectCards(v, found));
  } else if (typeof value === "object" && value !== null) {
    if ("rank" in value && "suit" in value) {
      found.push(value as Card);
    } else {
      Object.values(value).forEach((v) => collectCards(v, found));
    }
  }
  return found;
}

/** 漏れていた Card の表記を返す（空なら漏れなし）。 */
export function leakedCards(
  view: unknown,
  state: HandState,
  viewerId: string,
): string[] {
  const allowed = allowedCards(state, viewerId);
  return collectCards(view)
    .map(cardToString)
    .filter((c) => !allowed.has(c));
}
