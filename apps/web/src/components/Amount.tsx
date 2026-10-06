// 金額の表示。実額を正本として大きく出し、BB 換算は補助として小さく添える（D49・docs/06 §2）。BB は設定で消せるが実額は消せない。
import { formatBB, formatChips } from "../lib/format.js";
import { useShowBB } from "./BbDisplay.js";

interface AmountProps {
  readonly value: number;
  readonly bigBlind: number;
  /** 横並び（1 行）にするか。既定は実額の下に BB を置く 2 段。 */
  readonly inline?: boolean;
}

export function Amount({ value, bigBlind, inline = false }: AmountProps) {
  const showBB = useShowBB();
  return (
    <span className={`amount${inline ? " amount--inline" : ""}`}>
      <span className="amount__real">{formatChips(value)}</span>
      {/* BB 補助表示は設定で OFF にできる。実額（上の行）は常に出す（D49） */}
      {showBB && (
        <span className="amount__bb">{formatBB(value, bigBlind)}</span>
      )}
    </span>
  );
}
