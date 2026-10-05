// 金額の表示。実額を正本として大きく出し、BB 換算は補助として小さく添える（D49・docs/06 §2）。
import { formatBB, formatChips } from "../lib/format.js";

interface AmountProps {
  readonly value: number;
  readonly bigBlind: number;
  /** 横並び（1 行）にするか。既定は実額の下に BB を置く 2 段。 */
  readonly inline?: boolean;
}

export function Amount({ value, bigBlind, inline = false }: AmountProps) {
  return (
    <span className={`amount${inline ? " amount--inline" : ""}`}>
      <span className="amount__real">{formatChips(value)}</span>
      <span className="amount__bb">{formatBB(value, bigBlind)}</span>
    </span>
  );
}

/** Chip の構造描画（D60: CSS で描く）。Chip Drag は Phase 4 で扱う。 */
export function ChipIcon() {
  return <span className="chip" aria-hidden="true" />;
}
