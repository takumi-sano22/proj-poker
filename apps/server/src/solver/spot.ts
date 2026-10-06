// AnalysisSpot の検証と、Solver に渡す Range の作り方（#81）。
// Solver は不正な入力を自分で弾かない・不正な値のまま完走することがある（#76: Board の重複を検出しない等）ので、
// Adapter の側で検証してから渡す。不正な入力は Unsupported ではなく invalid_input（docs/09 §7）。
import {
  RANKS,
  SUITS,
  cardToString,
  comboKey,
  parseRange,
  type Card,
  type Combo,
  type Street,
  type VillainRange,
} from "@proj-poker/engine";
import type { AnalysisSpot, SpotRange } from "./types.js";

/** Street ごとの Board の枚数。 */
export const BOARD_SIZE: Readonly<Record<Street, number>> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

/** #79 の Range Model の結果を Solver の入力にする。Assumption はそのまま Evidence に残る。 */
export function rangeFromModel(range: VillainRange): SpotRange {
  return {
    combos: range.combos,
    assumption: { source: "range_model", model: range.assumption },
  };
}

/**
 * Range の表記（"TT+,AKs" 等。#79 の parseRange）から Solver の入力を作る。Board と衝突する Combo は除く。
 * 不正な表記は parseRange が例外にする（黙って読み替えない）。
 */
export function rangeFromNotation(
  notation: string,
  board: readonly Card[],
  note: string,
): SpotRange {
  const dead = new Set(board.map(cardToString));
  return {
    combos: parseRange(notation).filter(
      ([a, b]) => !dead.has(cardToString(a)) && !dead.has(cardToString(b)),
    ),
    assumption: { source: "notation", notation, note },
  };
}

/**
 * Spot の値が正しいかを確かめ、誤りの一覧を返す（空なら正しい）。Capability（人数・Street 等）の判定はしない（supports の役割）。
 * 見るもの: カードの表記・Board の重複と枚数・Pot / Stack が正の整数・Rake の割合・Range（空・不正なカード・同じ札 2 枚・
 * 重複・Board との衝突）・Bet Tree の数値。
 */
export function validateSpot(spot: AnalysisSpot): string[] {
  const errors: string[] = [];

  if (!(spot.street in BOARD_SIZE)) {
    errors.push(`Street が不正: ${String(spot.street)}`);
  }
  if (!Number.isSafeInteger(spot.playerCount) || spot.playerCount < 2) {
    errors.push(`人数は 2 以上の整数: ${spot.playerCount}`);
  }
  if (typeof spot.sidePot !== "boolean") {
    errors.push(`sidePot は真偽値: ${String(spot.sidePot)}`);
  }
  if (spot.mode !== "cash" && spot.mode !== "tournament") {
    errors.push(`mode が不正: ${String(spot.mode)}`);
  }

  const boardKeys = new Set<string>();
  for (const card of spot.board) {
    if (!isCard(card)) {
      errors.push(`Board のカードが不正: ${JSON.stringify(card)}`);
      continue;
    }
    const key = cardToString(card);
    if (boardKeys.has(key)) errors.push(`Board のカードが重複: ${key}`);
    boardKeys.add(key);
  }
  const expected = BOARD_SIZE[spot.street];
  if (expected !== undefined && spot.board.length !== expected) {
    errors.push(
      `${spot.street} の Board は ${expected} 枚: ${spot.board.length} 枚`,
    );
  }

  if (!Number.isSafeInteger(spot.pot) || spot.pot <= 0) {
    errors.push(`Pot は正の整数: ${spot.pot}`);
  }
  if (!Number.isSafeInteger(spot.effectiveStack) || spot.effectiveStack <= 0) {
    // 0 は全員 All-in 済みで、解く判断が無い。
    errors.push(`Effective Stack は正の整数: ${spot.effectiveStack}`);
  }
  if (
    !Number.isFinite(spot.rakeRate) ||
    spot.rakeRate < 0 ||
    spot.rakeRate >= 1
  ) {
    errors.push(`Rake の割合は 0 以上 1 未満: ${spot.rakeRate}`);
  }

  for (const side of ["oop", "ip"] as const) {
    errors.push(...validateRange(side, spot.ranges[side].combos, boardKeys));
  }

  const tree = spot.betTree;
  if (
    tree.betPotFractions.some((x) => !Number.isFinite(x) || x <= 0) ||
    tree.raiseMultipliers.some((x) => !Number.isFinite(x) || x <= 1)
  ) {
    errors.push("Bet Tree の Bet は正の割合・Raise は 1 より大きい倍数で書く");
  }
  if (!Number.isSafeInteger(tree.raiseCap) || tree.raiseCap < 1) {
    errors.push(`Bet Tree の攻撃回数の上限は 1 以上の整数: ${tree.raiseCap}`);
  }

  return errors;
}

function validateRange(
  side: "oop" | "ip",
  combos: readonly Combo[],
  boardKeys: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  if (combos.length === 0) {
    errors.push(`${side} の Range が空`);
    return errors;
  }
  const seen = new Set<string>();
  for (const combo of combos) {
    const [a, b] = combo;
    if (!isCard(a) || !isCard(b)) {
      errors.push(`${side} の Range のカードが不正: ${JSON.stringify(combo)}`);
      continue;
    }
    const ka = cardToString(a);
    const kb = cardToString(b);
    if (ka === kb) {
      errors.push(`${side} の Range に同じ札 2 枚の組: ${ka}${kb}`);
      continue;
    }
    const key = comboKey(combo);
    if (seen.has(key)) errors.push(`${side} の Range の Combo が重複: ${key}`);
    seen.add(key);
    if (boardKeys.has(ka) || boardKeys.has(kb)) {
      // Board と衝突する手は Solver が不正な値を出す原因になる（#76）。Range を作る側で除く。
      errors.push(`${side} の Range が Board と衝突: ${ka}${kb}`);
    }
  }
  return errors;
}

function isCard(value: unknown): value is Card {
  if (typeof value !== "object" || value === null) return false;
  const { rank, suit } = value as { rank?: unknown; suit?: unknown };
  return (
    RANKS.includes(rank as Card["rank"]) && SUITS.includes(suit as Card["suit"])
  );
}
