// Live の表示演出の速度の設定（D140 Q19。#222）と、OS の「視差効果を減らす」（prefers-reduced-motion）の状態。
// reduced-motion では動きを止める（docs/06 §16.4）ので、選んだ速度に関わらず演出なしとして進める（表示の内容は省かない）。
import { useCallback, useState, useSyncExternalStore } from "react";
import {
  loadPresentationSpeed,
  savePresentationSpeed,
} from "../lib/display-settings.js";
import type { PresentationSpeed } from "../lib/presentation.js";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || window.matchMedia === undefined) {
    return () => {};
  }
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || window.matchMedia === undefined) {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** OS が動きを減らす設定か。matchMedia が無い環境（テスト）では false。 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** 設定の状態と切り替え。初回は保存した値（無ければ標準）を読み、切り替えるたびに保存する。 */
export function usePresentationSpeed(): readonly [
  PresentationSpeed,
  (next: PresentationSpeed) => void,
] {
  const [speed, setSpeed] = useState(() => loadPresentationSpeed());
  const update = useCallback((next: PresentationSpeed) => {
    setSpeed(next);
    savePresentationSpeed(next);
  }, []);
  return [speed, update];
}
