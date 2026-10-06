// Fast Forward の操作（docs/06 §8・D12・D15・D93）。Hero が Fold した後の観戦で、CPU の思考の待ち（演出）を縮める。
// 縮まるのは待ちの演出だけ。AI の応答時間そのものは縮まないので、説明をいつも添える（速くなると誤解させない）。
import { FAST_FORWARD_NOTE } from "../lib/view-model.js";

interface FastForwardProps {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: boolean) => void;
}

export function FastForward({ active, disabled, onChange }: FastForwardProps) {
  return (
    <div className="fast-forward">
      <button
        type="button"
        className="toggle"
        aria-pressed={active}
        disabled={disabled}
        onClick={() => onChange(!active)}
      >
        <span className="toggle__label">Fast Forward</span>
        <span className="toggle__state">{active ? "ON" : "OFF"}</span>
      </button>
      <p className="fast-forward__note">{FAST_FORWARD_NOTE}</p>
    </div>
  );
}
