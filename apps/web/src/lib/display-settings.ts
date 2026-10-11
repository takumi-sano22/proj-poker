// 表示の設定の保存（viewer ごと = このブラウザの localStorage）。使えない環境（プライベートウィンドウ・保存の拒否・SSR 等）では
// 例外を握りつぶして既定の表示で動かす（保存は便利機能で、無くても画面は成り立つ）。
// 設定は表示の補助だけを決める。実額は常に表示する（D49）ので、ここに「実額を隠す」設定は置かない。

import { PRESENTATION_SPEEDS, type PresentationSpeed } from "./presentation.js";

/** BB 補助表示（実額の下の「18.5 BB」など）を出すか。既定は出す（OFF は viewer の選択）。 */
export const BB_DISPLAY_KEY = "proj-poker.display.showBB";
export const DEFAULT_SHOW_BB = true;

/** 読み書きだけを使う Storage の形（テストで差し替えられる）。 */
export type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): SettingsStorage | null {
  try {
    // アクセサ自体が投げることがある（ストレージ拒否の設定）ので、取得も try の中で行う。
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 保存した BB 補助表示の設定を読む。無い・読めない・知らない値なら既定（出す）。 */
export function loadShowBB(
  storage: SettingsStorage | null = defaultStorage(),
): boolean {
  try {
    const raw = storage?.getItem(BB_DISPLAY_KEY);
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch {
    // 読めなければ既定で動く
  }
  return DEFAULT_SHOW_BB;
}

/** BB 補助表示の設定を保存する。保存できなくても例外にしない（その場の表示には反映される）。 */
export function saveShowBB(
  value: boolean,
  storage: SettingsStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(BB_DISPLAY_KEY, value ? "on" : "off");
  } catch {
    // 保存できない環境でも、今の画面の切り替えは効く
  }
}

/**
 * Live の表示演出の速度（D140 Q19。#222）。表示の設定で、Event Log・server には入れない（docs/06 §16.6）。既定は標準。
 * Replay の再生の速度は別に持ち、ここには保存しない（Live と独立。Q21）。
 */
export const PRESENTATION_SPEED_KEY = "proj-poker.display.presentationSpeed";
export const DEFAULT_PRESENTATION_SPEED: PresentationSpeed = "standard";

/** 保存した表示演出の速度を読む。無い・読めない・知らない値なら既定（標準）。 */
export function loadPresentationSpeed(
  storage: SettingsStorage | null = defaultStorage(),
): PresentationSpeed {
  try {
    const raw = storage?.getItem(PRESENTATION_SPEED_KEY);
    const known = PRESENTATION_SPEEDS.find((s) => s === raw);
    if (known !== undefined) return known;
  } catch {
    // 読めなければ既定で動く
  }
  return DEFAULT_PRESENTATION_SPEED;
}

/** 表示演出の速度を保存する。保存できなくても例外にしない（その場の表示には反映される）。 */
export function savePresentationSpeed(
  value: PresentationSpeed,
  storage: SettingsStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(PRESENTATION_SPEED_KEY, value);
  } catch {
    // 保存できない環境でも、今の画面の切り替えは効く
  }
}
