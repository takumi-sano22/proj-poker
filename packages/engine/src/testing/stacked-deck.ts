// Scenario Test 用の「積んだ Deck」。指定した Hole Cards と Board が配布順の位置に来るように 52 枚を並べる。
// 配布順は Engine と同じ（Button の左から 1 枚ずつ 2 周 → Board。Burn なし）。
import { cardToString, createDeck, parseCards, type Card } from "../card.js";
import type { SeatInit } from "../hand-events.js";

export function stackedDeck(
  seats: readonly SeatInit[],
  buttonPlayerId: string,
  holes: Readonly<Record<string, string>>,
  board: string,
): Card[] {
  const n = seats.length;
  const button = seats.findIndex((s) => s.playerId === buttonPlayerId);
  // 疎な配列は map で穴が飛ばされるので、undefined で埋めた配列を作る。
  const slots: (Card | undefined)[] = Array.from(
    { length: 52 },
    () => undefined,
  );
  for (let k = 0; k < n; k++) {
    const seat = seats[(button + 1 + k) % n] as SeatInit;
    const hole = holes[seat.playerId];
    if (hole === undefined) continue;
    const [first, second] = parseCards(hole);
    slots[k] = first;
    slots[n + k] = second;
  }
  parseCards(board).forEach((card, i) => {
    slots[2 * n + i] = card;
  });
  // 指定していない位置は、使っていない Card を新品の Deck 順に詰める。
  const used = new Set(
    slots.filter((c): c is Card => c !== undefined).map(cardToString),
  );
  const rest = createDeck().filter((c) => !used.has(cardToString(c)));
  return slots.map((c) => c ?? (rest.shift() as Card));
}
