// Chip の額面（Denomination）と、額から Chip の構成（枚数）を組む決定論の関数。
// 構成は「額の見せ方」であり、Pot・Stack・Bet の正本は整数の額（D74）。構成を保存したり、額の計算に使ったりしない。

/**
 * Chip の色の名前。実際の色（CSS の値）は表示側のテーマが持つ（D60。Theme 変更可能）。
 * 額面と色の対応は Preset（Config）で決め、表示コンポーネントには直書きしない。
 */
export type ChipColor = "white" | "red" | "green" | "black" | "purple";

/** Chip 1 種の額面。value は最小単位の整数（D74）。 */
export interface ChipDenomination {
  readonly value: number;
  readonly color: ChipColor;
}

/** 額面ごとの枚数。 */
export interface ChipCount {
  readonly denomination: ChipDenomination;
  readonly count: number;
}

/**
 * 暫定の額面 Preset: 1（白）・5（赤）・25（緑）・100（黒）・500（紫）（D92）。
 * 値と色は OI-004（Chip Preset）の暫定値で、永久仕様ではない。
 */
export const DEFAULT_CHIP_DENOMINATIONS: readonly ChipDenomination[] = [
  { value: 1, color: "white" },
  { value: 5, color: "red" },
  { value: 25, color: "green" },
  { value: 100, color: "black" },
  { value: 500, color: "purple" },
];

/**
 * 額から Chip の構成を組む。大きい額面から貪欲に取り、枚数が 0 の額面は含めない（大きい額面が先）。
 * 額面に 1 が無いと端数を組めないので、組めない額や不正な額面は例外にする（黙って額を変えない。Chip は増減させない）。
 * 整理・両替は Dealer の補助（D14）で、これは Chip を数える表示用の関数。ルール判定には使わない。
 */
export function composeChips(
  amount: number,
  denominations: readonly ChipDenomination[] = DEFAULT_CHIP_DENOMINATIONS,
): ChipCount[] {
  // table-config.ts の isChipAmount と同じ条件（table-config が chips を import するので循環を避けて持つ）
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`Chip の額が不正です: ${amount}`);
  }
  const sorted = [...denominations].sort((a, b) => b.value - a.value);
  for (const [i, d] of sorted.entries()) {
    if (!Number.isSafeInteger(d.value) || d.value <= 0) {
      throw new RangeError(`Chip の額面が不正です: ${d.value}`);
    }
    if (i > 0 && sorted[i - 1]?.value === d.value) {
      throw new RangeError(`Chip の額面が重複しています: ${d.value}`);
    }
  }

  const result: ChipCount[] = [];
  let rest = amount;
  for (const d of sorted) {
    const count = Math.floor(rest / d.value);
    if (count > 0) {
      result.push({ denomination: d, count });
      rest -= count * d.value;
    }
  }
  if (rest !== 0) {
    throw new RangeError(
      `この額面では ${amount} を組めません（最小の額面が 1 ではありません）`,
    );
  }
  return result;
}
