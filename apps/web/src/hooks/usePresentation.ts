// Presentation Controller の React 側（#222・D140・D143）。authoritative（server から届いた最新の HeroView）を受け、Hero に見せる卓
// （displayed）を時刻に合わせて 1 step ずつ進める。進め方の規則は lib/presentation.ts の純関数で、ここは時刻・タイマー・
// タブの表示の切り替え（visibilitychange）だけを持つ。ゲームの進行（server の CPU・Event Log・Fast Forward）には触れない。
import type { HeroView } from "@proj-poker/engine";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  INITIAL_PRESENTATION,
  displayedView,
  isSynced,
  nextDueAt,
  settle,
  settleWithoutClock,
  syncNow,
  type PresentationOptions,
  type PresentationState,
} from "../lib/presentation.js";

export interface Presentation {
  /** Hero に見せる卓（authoritative が無ければ null）。 */
  readonly displayed: HeroView | null;
  /** 表示が最新の View に追いついているか（操作を送れるのはこのときだけ。D143）。 */
  readonly synced: boolean;
  /** 残りの演出を省いて最新の公開状態に合わせる（Skip・再接続・画面への復帰・送信前の同期）。 */
  readonly sync: () => void;
}

export function usePresentation(
  authoritative: HeroView | null,
  options: PresentationOptions,
): Presentation {
  const [state, setState] = useState<PresentationState>(INITIAL_PRESENTATION);
  // タイマー・イベントの中で最新の値を読むため ref にも置く（描画の後に更新する。下の effect より先に定義する）。
  const latest = useRef({ authoritative, options });
  useEffect(() => {
    latest.current = { authoritative, options };
  });

  // 描画の時点で、時刻に依らずに決まる分（届いた View の受け取り・演出なし・障害の優先）を反映する。古い表示を 1 回描いてから
  // 直すと、障害のダイアログや演出なしの卓が遅れて出るので、描画の中で状態を直す（React の「前の描画から状態を直す」形）。
  // 時刻で次の step を出すのは下のタイマーだけ（描画の中で時刻を読まない）。
  const current =
    authoritative === null
      ? state
      : settleWithoutClock(state, authoritative, options);
  if (current !== state && !sameState(current, state)) setState(current);

  // 次の step を出す時刻にタイマーを置く。step を出すたびに置き直す。
  // タイマーは時刻の丸めで予定より少し早く発火することがあり、そのときは step が進まず状態も変わらない。発火のたびに tick を進めて
  // 必ず置き直す（置き直さないと、待ちの step が残ったまま表示が止まる）。
  const [tick, setTick] = useState(0);
  const dueAt =
    authoritative === null ? null : nextDueAt(current, authoritative, options);
  useEffect(() => {
    if (dueAt === null) return;
    const timer = setTimeout(
      () => {
        const { authoritative: view, options: opts } = latest.current;
        if (view !== null) setState((s) => settle(s, view, Date.now(), opts));
        setTick((n) => n + 1);
      },
      Math.max(0, dueAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [dueAt, current.shownSeq, tick]);

  const sync = useCallback(() => {
    const { authoritative: view, options: opts } = latest.current;
    if (view === null) return;
    setState((s) => syncNow(s, view, opts.holdThroughSeq));
  }, []);

  // タブを隠している間はタイマーが間引かれる。戻ってきたら古い演出を続けず、最新の公開状態に合わせる（D140 Q26）。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [sync]);

  return {
    displayed:
      authoritative === null ? null : displayedView(current, authoritative),
    synced: authoritative !== null && isSynced(current, authoritative),
    sync,
  };
}

function sameState(a: PresentationState, b: PresentationState): boolean {
  return (
    a.handId === b.handId &&
    a.shownSeq === b.shownSeq &&
    a.busyUntil === b.busyUntil
  );
}
