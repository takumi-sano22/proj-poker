// Hand State の Invariant（docs/09 §3 の INV-TEST-001〜005。006 は Command の拒否で別に確かめる）。
// Scenario と Property の両方から呼ぶ。違反を文字列で返し、テスト側で `toEqual([])` と比べる。
import { cardToString } from "../card.js";
import type { HandState } from "../hand-state.js";

export function checkInvariants(
  state: HandState,
  initialTotal: number,
): string[] {
  const errors: string[] = [];
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

  // INV-TEST-001: 同じ Card が二か所に無い。Deck を知っている State では、配られた札が Deck の中にある。
  const known = [
    ...state.players.flatMap((p) => p.holeCards ?? []),
    ...state.board,
  ].map(cardToString);
  if (new Set(known).size !== known.length) {
    errors.push(`INV-TEST-001: 重複した Card がある: ${known.join(" ")}`);
  }
  if (state.deck.length > 0) {
    const deck = state.deck.map(cardToString);
    if (new Set(deck).size !== 52)
      errors.push("INV-TEST-001: Deck が 52 枚の一意な Card ではない");
    const missing = known.filter((c) => !deck.includes(c));
    if (missing.length > 0)
      errors.push(`INV-TEST-001: Deck に無い Card: ${missing.join(" ")}`);
  }

  // INV-TEST-002: Chip 総量が保存される（Rake・Rebuy は Phase 1 に無い）。完全一致で比べる。
  const stacks = sum(state.players.map((p) => p.stack));
  if (stacks + state.pot !== initialTotal) {
    errors.push(
      `INV-TEST-002: Σ Stack ${stacks} + Pot ${state.pot} ≠ ${initialTotal}`,
    );
  }
  const committed = sum(state.players.map((p) => p.totalCommitted));
  const awarded = sum(state.awards.map((a) => a.amount));
  if (state.pot !== committed - awarded) {
    errors.push(
      `INV-TEST-002: Pot ${state.pot} ≠ Σ Commit ${committed} − Σ 配分 ${awarded}`,
    );
  }

  // INV-TEST-003: Fold / All-in した Player が手番にならない。
  if (state.actorIndex !== null) {
    const actor = state.players[state.actorIndex];
    if (actor === undefined || actor.folded || actor.allIn) {
      errors.push(
        `INV-TEST-003: 行動できない Player が手番: ${actor?.playerId}`,
      );
    }
  }

  // INV-TEST-004: Stack を超えて Commit していない（Stack が負にならない）。
  for (const p of state.players) {
    if (!Number.isSafeInteger(p.stack) || p.stack < 0) {
      errors.push(`INV-TEST-004: ${p.playerId} の Stack が不正: ${p.stack}`);
    }
    if (p.streetCommitted < 0 || p.streetCommitted > p.totalCommitted) {
      errors.push(`INV-TEST-004: ${p.playerId} の Commit が不正`);
    }
  }

  // INV-TEST-005: 配分した総額 = Pot（Rake なし）。配分後に Pot は空。
  if (state.awards.length > 0 && (awarded !== committed || state.pot !== 0)) {
    errors.push(`INV-TEST-005: 配分 ${awarded} ≠ Pot ${committed}`);
  }
  if (state.status === "complete" && state.pot !== 0) {
    errors.push(`INV-TEST-005: Hand 終了後に Pot が残っている: ${state.pot}`);
  }
  return errors;
}

/** Hand 開始時の Chip 総量。 */
export function initialChipTotal(stacks: readonly { stack: number }[]): number {
  return stacks.reduce((a, s) => a + s.stack, 0);
}
