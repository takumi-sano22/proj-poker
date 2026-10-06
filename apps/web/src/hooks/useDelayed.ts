// 「同じ待ちが一定時間続いたか」を返す。待ちの識別子（key）が変われば数え直す。
import { useEffect, useState } from "react";

/**
 * key が同じまま ms 以上たったら true。key が null（待っていない）なら false。
 * 時刻は描画に使わず、タイマーの発火だけで切り替える（key が変われば前のタイマーは捨てる）。
 */
export function useDelayed(key: string | null, ms: number): boolean {
  const [delayedKey, setDelayedKey] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => setDelayedKey(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return key !== null && delayedKey === key;
}
