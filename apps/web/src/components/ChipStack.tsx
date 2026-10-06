// Chip の構成（額面ごとの積み）の構造描画（D60: CSS で描く）。額から枚数を組む関数は Engine の composeChips。
// 積みは見せ方であり、金額の正本は隣に常時表示する実額（D49）。Chip の操作（Click / Drag）は #65 で扱う。
import { composeChips, type ChipDenomination } from "@proj-poker/engine";
import type { CSSProperties } from "react";
import { CHIP_DENOMINATIONS } from "../lib/config.js";
import { formatChips } from "../lib/format.js";

/** 1 本の積みに重ねて描く Chip の上限。これを超える枚数は重ねず、枚数の表記（×N）で示す。 */
const MAX_VISIBLE_CHIPS = 5;

interface ChipStackProps {
  readonly amount: number;
  readonly denominations?: readonly ChipDenomination[];
}

export function ChipStack({
  amount,
  denominations = CHIP_DENOMINATIONS,
}: ChipStackProps) {
  const columns = composeChips(amount, denominations);
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
