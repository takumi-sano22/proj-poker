// 表示演出の速度の選択と Skip（#222・D140 Q19 / Q21）。Live の卓と Replay で同じ部品を使い、値はそれぞれが別に持つ
// （Replay の速度を変えても Live の演出は変わらない）。速度はゲームの進行・Fast Forward（server の CPU の待ち）を変えない。
import {
  PRESENTATION_SPEEDS,
  PRESENTATION_SPEED_LABELS,
  type PresentationSpeed,
} from "../lib/presentation.js";

interface PresentationControlsProps {
  /** select のラベル（Live は「演出の速度」、Replay は「再生の速度」）。 */
  readonly label: string;
  readonly speed: PresentationSpeed;
  readonly onSpeedChange: (next: PresentationSpeed) => void;
  /** 残りの演出を省いて最新の表示に合わせる。null なら Skip を出さない（演出の待ちが無い・Replay）。 */
  readonly onSkip?: (() => void) | null;
  /** OS の「視差効果を減らす」で動きを止めている（選んだ速度に関わらず演出なしで進む）ことを添えるか。 */
  readonly reducedMotion?: boolean;
}

export function PresentationControls({
  label,
  speed,
  onSpeedChange,
  onSkip = null,
  reducedMotion = false,
}: PresentationControlsProps) {
  return (
    <div className="presentation-controls">
      <label className="presentation-controls__speed">
        <span className="presentation-controls__label">{label}</span>
        <select
          className="presentation-controls__select"
          value={speed}
          onChange={(e) => {
            const next = PRESENTATION_SPEEDS.find((s) => s === e.target.value);
            if (next !== undefined) onSpeedChange(next);
          }}
        >
          {PRESENTATION_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {PRESENTATION_SPEED_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      {onSkip !== null && (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={onSkip}
        >
          Skip
        </button>
      )}
      {reducedMotion && (
        <p className="presentation-controls__note">
          OS の設定で動きを減らしているため、演出なしで表示します。
        </p>
      )}
    </div>
  );
}
