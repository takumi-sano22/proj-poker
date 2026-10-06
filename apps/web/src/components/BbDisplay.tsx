// BB 補助表示の設定（docs/06 §2）。実額は常に出し、BB 換算（補助）だけを viewer が ON / OFF できる。
// 設定は Context で金額の表示（Amount・宣言ボタン・用語の例）へ渡す。Context が無い描画（部品単体）は既定の「出す」。
import { createContext, useCallback, useContext, useState } from "react";
import {
  DEFAULT_SHOW_BB,
  loadShowBB,
  saveShowBB,
} from "../lib/display-settings.js";

const BbDisplayCtx = createContext<boolean>(DEFAULT_SHOW_BB);

export const BbDisplayProvider = BbDisplayCtx.Provider;

/** BB 補助表示を出すか。 */
export function useShowBB(): boolean {
  return useContext(BbDisplayCtx);
}

/** 設定の状態と切り替え。初回は保存した値（無ければ既定）を読み、切り替えるたびに保存する。 */
export function useBbSetting(): readonly [boolean, (next: boolean) => void] {
  const [showBB, setShowBB] = useState(() => loadShowBB());
  const update = useCallback((next: boolean) => {
    setShowBB(next);
    saveShowBB(next);
  }, []);
  return [showBB, update];
}

interface ToggleProps {
  readonly showBB: boolean;
  readonly onChange: (next: boolean) => void;
}

/** BB 補助表示の切り替えボタン（押された状態が ON）。ラベルは常に同じで、状態は aria-pressed で伝える。 */
export function BbDisplayToggle({ showBB, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={showBB}
      onClick={() => onChange(!showBB)}
    >
      <span className="toggle__label">BB 補助表示</span>
      <span className="toggle__state">{showBB ? "ON" : "OFF"}</span>
    </button>
  );
}
