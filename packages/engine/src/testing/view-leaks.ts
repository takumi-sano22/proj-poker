// Projection の情報漏れ検査（INV-TEST-007 の Engine 側。docs/02 §2 INV-INFO-001）。
// View を丸ごと走査して Card を全部拾い、「viewer が知ってよい Card」以外が 1 枚でもあれば違反とする。
// フィールド名に頼らず値を走査するので、View に項目が増えても漏れを見逃さない。
import { cardToString, type Card } from "../card.js";
import { isVisibleTo, type HandEvent } from "../hand-events.js";
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

/** Deck・seed・engine Visibility の Event を指す語が JSON に含まれていないか（Card 以外の経路の漏れ）。 */
export function hiddenMarkers(view: unknown): string[] {
  const json = JSON.stringify(view);
  return ['"deck"', '"seed"', "DECK_SHUFFLED", '"engine"'].filter((k) =>
    json.includes(k),
  );
}

/**
 * viewer に見えない Event（engine の Deck・他者宛ての Hole Cards）の中身だけを別の値に差し替える。
 * 見えない Event の中身が出力に届く経路が無ければ、差し替える前と同じ結果になる。
 */
export function tamperHiddenEvents(
  events: readonly HandEvent[],
  viewerId: string,
): HandEvent[] {
  return events.map((e) => {
    if (isVisibleTo(e, viewerId)) return e;
    switch (e.type) {
      case "DECK_SHUFFLED":
        return { ...e, seed: -1, deck: [...e.deck].reverse() };
      case "HOLE_CARD_DEALT":
        return { ...e, cards: [...e.cards].reverse() };
      default:
        return e;
    }
  });
}
