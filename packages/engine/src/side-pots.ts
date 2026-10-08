// Main Pot / Side Pot の組み立て（docs/02 §5 Multi Side Pot）。純粋関数で、Chip は整数（D74）。

/** Pot を組み立てる入力。Hand で Commit した累計と Fold の有無だけを見る。 */
export interface PotContributor {
  readonly playerId: string;
  /** この Hand で出した額の累計（返却された Uncalled Bet は引いた後）。 */
  readonly totalCommitted: number;
  readonly folded: boolean;
}

/** 1 つの Pot。index 0 が Main Pot、1 以降が Side Pot。 */
export interface Pot {
  readonly amount: number;
  /** この Pot を争える（Fold していない）Player。入力の並び順を保つ。 */
  readonly eligible: readonly string[];
}

/**
 * Commit の累計から Main / Side Pot を組み立てる。
 * Fold していない Player の Commit 額を小さい順に段（level）として切り、各段に全員が「その段までに出した分」を入れる。
 * 段を作るのは Fold していない Player の額だけなので、隣り合う Pot は必ず争える顔ぶれが違う（同じ顔ぶれの Pot を分けない）。
 * Fold した Player の Chip は入った段の Pot に死に金として残る。最後の段より上に Fold した Player の Chip があれば
 * （Uncalled Bet を返した後は起きない想定）最後の Pot に入れ、Σ amount が Σ Commit と必ず一致するようにする（INV-TEST-005）。
 * contributors は Button の左から時計回りの順で渡す（eligible もその順になり、端数を配る順にそのまま使える）。
 * mainPotDeadMoney は誰の Commit にも数えない Main Pot の Dead Money（big_blind_ante の Ante。D128）で、Main Pot にだけ足す
 * （Side Pot の段は変えない。Σ amount = Σ Commit + mainPotDeadMoney）。
 */
export function buildPots(
  contributors: readonly PotContributor[],
  mainPotDeadMoney = 0,
): Pot[] {
  if (!Number.isSafeInteger(mainPotDeadMoney) || mainPotDeadMoney < 0) {
    throw new RangeError(
      `Main Pot の Dead Money は 0 以上の整数: ${mainPotDeadMoney}`,
    );
  }
  for (const c of contributors) {
    if (!Number.isSafeInteger(c.totalCommitted) || c.totalCommitted < 0) {
      throw new RangeError(
        `Commit は 0 以上の整数: ${c.playerId} ${c.totalCommitted}`,
      );
    }
  }
  const levels = [
    ...new Set(
      contributors.filter((c) => !c.folded).map((c) => c.totalCommitted),
    ),
  ]
    .filter((level) => level > 0)
    .sort((a, b) => a - b);
  if (levels.length === 0) {
    throw new RangeError("Pot を争える Player がいない");
  }

  const pots: Pot[] = [];
  let previous = 0;
  levels.forEach((level, i) => {
    // 最後の段は上限を設けない（段より上にある Chip の取りこぼしを作らない）。
    const cap = i === levels.length - 1 ? Number.POSITIVE_INFINITY : level;
    const amount = contributors.reduce(
      (sum, c) => sum + Math.max(0, Math.min(c.totalCommitted, cap) - previous),
      0,
    );
    const eligible = contributors
      .filter((c) => !c.folded && c.totalCommitted >= level)
      .map((c) => c.playerId);
    pots.push({
      amount: i === 0 ? amount + mainPotDeadMoney : amount,
      eligible,
    });
    previous = level;
  });
  return pots;
}
