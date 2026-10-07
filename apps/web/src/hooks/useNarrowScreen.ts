// 狭い画面（スマホ幅）かどうか。styles.css の `@media (max-width: 719px)` と同じ境界で、
// 卓の席と重なる欄（Hand の結果・CPU 障害のダイアログ）を、卓の中央ではなく Hero の欄へ置くかを決める。
// 同じ内容を 2 か所に同時に描かない（読み上げが二重になる）ので、CSS で出し分けず、ここで 1 か所に決める。
import { useSyncExternalStore } from "react";

/** styles.css の狭い画面の境界と合わせる（片方だけ変えない）。 */
export const NARROW_SCREEN_QUERY = "(max-width: 719px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || window.matchMedia === undefined) {
    return () => {};
  }
  const mql = window.matchMedia(NARROW_SCREEN_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || window.matchMedia === undefined) {
    return false;
  }
  return window.matchMedia(NARROW_SCREEN_QUERY).matches;
}

/** 画面幅が 719px 以下か。matchMedia が無い環境（サーバー描画・テスト）では広い画面として扱う。 */
export function useNarrowScreen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
