// Hand State の Invariant（docs/09 §3 の INV-TEST-001〜005。006 は Command の拒否で別に確かめる）。
// Scenario と Property の両方から呼ぶ。違反を文字列で返し、テスト側で `toEqual([])` と比べる。
import { cardToString } from "../card.js";
import type { HandEvent } from "../hand-events.js";
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

/**
 * Pot ごとの配分（POT_AWARDED）の Invariant（INV-TEST-005 の Pot 単位版。D78）。
 * - potIndex は 0（Main Pot）からの連番
 * - 各 Pot の Σ awards = potTotal で、受け取るのは争える Player だけ
 * - 争える Player は Fold していない。Side Pot ほど顔ぶれが狭まる（後の Pot の eligible は前の Pot の eligible に含まれる）
 * - 誰も、各 Player から「自分の Commit 額まで」しか受け取れない（Σ_q min(自分の Commit, q の Commit) 以下）。
 *   Pot の組み立てとは独立に、Short Stack が Side Pot を取っていないことを確かめる
 */
export function checkPotAwards(events: readonly HandEvent[]): string[] {
  const errors: string[] = [];
  const folded = new Set(
    events.flatMap((e) =>
      e.type === "ACTION_TAKEN" && e.action === "fold" ? [e.playerId] : [],
    ),
  );
  const pots = events.flatMap((e) => (e.type === "POT_AWARDED" ? [e] : []));
  pots.forEach((pot, i) => {
    const where = `POT_AWARDED #${i}`;
    if (pot.potIndex !== i) {
      errors.push(`${where}: potIndex が ${pot.potIndex}`);
    }
    const awarded = pot.awards.reduce((sum, a) => sum + a.amount, 0);
    if (awarded !== pot.potTotal) {
      errors.push(`${where}: Σ 配分 ${awarded} ≠ potTotal ${pot.potTotal}`);
    }
    if (pot.eligible.length === 0) {
      errors.push(`${where}: 争える Player がいない`);
    }
    for (const a of pot.awards) {
      if (!pot.eligible.includes(a.playerId)) {
        errors.push(`${where}: 争えない ${a.playerId} が受け取った`);
      }
    }
    for (const id of pot.eligible) {
      if (folded.has(id)) errors.push(`${where}: Fold した ${id} が争える`);
    }
    const previous = pots[i - 1];
    if (
      previous !== undefined &&
      !pot.eligible.every((id) => previous.eligible.includes(id))
    ) {
      errors.push(`${where}: eligible が前の Pot の eligible に含まれない`);
    }
  });

  // Commit の累計を Event から数え直す（Blind・Action で出した額 − 返却された Uncalled Bet）。
  const commits = new Map<string, number>();
  const add = (id: string, amount: number) =>
    commits.set(id, (commits.get(id) ?? 0) + amount);
  for (const e of events) {
    if (e.type === "BLIND_POSTED" || e.type === "ACTION_TAKEN") {
      add(e.playerId, e.amount);
    } else if (e.type === "UNCALLED_BET_RETURNED") {
      add(e.playerId, -e.amount);
    }
  }
  const won = new Map<string, number>();
  for (const pot of pots) {
    for (const a of pot.awards) {
      won.set(a.playerId, (won.get(a.playerId) ?? 0) + a.amount);
    }
  }
  for (const [id, amount] of won) {
    const own = commits.get(id) ?? 0;
    let cap = 0;
    for (const other of commits.values()) cap += Math.min(own, other);
    if (amount > cap) {
      errors.push(
        `${id} が Commit ${own} で取れる上限 ${cap} を超えて ${amount} を受け取った`,
      );
    }
  }
  return errors;
}

/**
 * 終わった Hand の Event Log だけで Chip の動きを数え直す（INV-TEST-002 / 005 の Hand 終了版。D37）。
 * - 最後の Event が HAND_FINISHED で、HAND_STARTED の席の全員の Stack を同じ順で持つ
 * - Σ HAND_FINISHED の Stack = 開始時の Chip 総量（Rake・Rebuy は無い）
 * - Σ POT_AWARDED の potTotal = Σ Commit（Blind + Action − 返却された Uncalled Bet）
 * - 各 Player の終了時 Stack = 開始時 Stack − Commit + 受け取った額
 * State を見ずに Event だけで確かめるので、Event Log から Stack を持ち越す Session の前提も確かめられる。
 */
export function checkHandFinished(
  events: readonly HandEvent[],
  initialTotal: number,
): string[] {
  const errors: string[] = [];
  const started = events[0];
  const finished = events.at(-1);
  if (started?.type !== "HAND_STARTED" || finished?.type !== "HAND_FINISHED") {
    return [
      "Event Log が HAND_STARTED で始まり HAND_FINISHED で終わっていない",
    ];
  }
  const ids = started.seats.map((s) => s.playerId);
  const finishedIds = finished.stacks.map((s) => s.playerId);
  if (finishedIds.join(",") !== ids.join(",")) {
    errors.push(
      `HAND_FINISHED の Player ${finishedIds.join(",")} ≠ 席 ${ids.join(",")}`,
    );
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const finalTotal = sum(finished.stacks.map((s) => s.amount));
  if (finalTotal !== initialTotal) {
    errors.push(`Σ 終了時 Stack ${finalTotal} ≠ 開始時の総量 ${initialTotal}`);
  }

  const commits = new Map<string, number>();
  const won = new Map<string, number>();
  const add = (m: Map<string, number>, id: string, amount: number) =>
    m.set(id, (m.get(id) ?? 0) + amount);
  let potTotal = 0;
  for (const e of events) {
    if (e.type === "BLIND_POSTED" || e.type === "ACTION_TAKEN") {
      add(commits, e.playerId, e.amount);
    } else if (e.type === "UNCALLED_BET_RETURNED") {
      add(commits, e.playerId, -e.amount);
    } else if (e.type === "POT_AWARDED") {
      potTotal += e.potTotal;
      for (const a of e.awards) add(won, a.playerId, a.amount);
    }
  }
  const committed = sum([...commits.values()]);
  if (potTotal !== committed) {
    errors.push(`Σ potTotal ${potTotal} ≠ Σ Commit ${committed}`);
  }
  for (const seat of started.seats) {
    const id = seat.playerId;
    const expected = seat.stack - (commits.get(id) ?? 0) + (won.get(id) ?? 0);
    const actual = finished.stacks.find((s) => s.playerId === id)?.amount;
    if (actual !== expected) {
      errors.push(
        `${id} の終了時 Stack ${actual} ≠ 開始 ${seat.stack} − Commit + 配分 = ${expected}`,
      );
    }
  }
  return errors;
}
