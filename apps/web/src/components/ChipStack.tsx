// Chip の構成（額面ごとの積み）の構造描画（D60: CSS で描く）。額から枚数を組む関数は Engine の composeChips。
// 積みは見せ方であり、金額の正本は隣に常時表示する実額（D49）。Chip の操作（Click / Drag）は ChipControls（#65）。
import {
  composeChips,
  type ChipCount,
  type ChipDenomination,
} from "@proj-poker/engine";
import type { CSSProperties } from "react";
import { countChips } from "../lib/chip-ops.js";
import { CHIP_DENOMINATIONS } from "../lib/config.js";
import { formatChips } from "../lib/format.js";

/** 1 本の積みに重ねて描く Chip の上限。これを超える枚数は重ねず、枚数の表記（×N）で示す。 */
const MAX_VISIBLE_CHIPS = 5;

interface ChipStackProps {
  readonly amount: number;
  readonly denominations?: readonly ChipDenomination[];
}

/** 額から組んだ構成（大きい額面から貪欲）で描く。席の Stack と Bet に使う。 */
export function ChipStack({
  amount,
  denominations = CHIP_DENOMINATIONS,
}: ChipStackProps) {
  return <ChipColumns columns={composeChips(amount, denominations)} />;
}

interface ChipPileProps {
  /** 実際に手に取った・出した Chip の額面の列（額から組み直さず、この枚数のまま描く）。 */
  readonly chips: readonly number[];
  readonly denominations?: readonly ChipDenomination[];
}

/** Hero が手に取った・出した Chip を、その枚数のまま描く（Oversized Chip などの出し方が見えるように）。 */
export function ChipPile({
  chips,
  denominations = CHIP_DENOMINATIONS,
}: ChipPileProps) {
  return <ChipColumns columns={countChips(chips, denominations)} />;
}

function ChipColumns({ columns }: { readonly columns: readonly ChipCount[] }) {
  if (columns.length === 0) return null;
  return (
    <span className="chip-stack" aria-hidden="true">
      {columns.map(({ denomination, count }) => {
        const visible = Math.min(count, MAX_VISIBLE_CHIPS);
        return (
          <span
            key={denomination.value}
            className="chip-column"
            data-denomination={denomination.value}
            data-count={count}
            title={`${formatChips(denomination.value)} × ${formatChips(count)}`}
            style={{ "--n": visible } as CSSProperties}
          >
            {/* 枚数は積みの上に置き、隣の積みと底をそろえる */}
            {count > MAX_VISIBLE_CHIPS && (
              <span className="chip-column__count">×{formatChips(count)}</span>
            )}
            <span className="chip-column__pile">
              {Array.from({ length: visible }, (_, i) => (
                <span
                  key={i}
                  className={`chip chip--${denomination.color}`}
                  style={{ "--i": i } as CSSProperties}
                />
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
