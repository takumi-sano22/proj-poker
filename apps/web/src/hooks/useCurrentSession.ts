// Home の Session の状態の照会（GET /api/session/current。D136・D144・#218）。Home を表示するたびに 1 回だけ読む。
// 読むだけで Hand・Session を作らない・進めない（POST /api/hands は「続きから遊ぶ」・「新しい Session を始める」を Hero が押したときだけ）。
// 読み直し（もう一度読み込む）の後に前の応答が遅れて届いても、最後に出した照会の応答だけを採る。
import { useCallback, useEffect, useState } from "react";
import { fetchCurrentSession, type CurrentSessionLookup } from "../lib/api.js";

export type CurrentSessionLoad =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly lookup: CurrentSessionLookup };

export function useCurrentSession(): {
  readonly load: CurrentSessionLoad;
  readonly reload: () => void;
} {
  const [load, setLoad] = useState<CurrentSessionLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 読み直した・画面を離れたら、前の照会の応答は捨てる。
    let current = true;
    fetchCurrentSession().then(
      (lookup) => {
        if (current) setLoad({ state: "ready", lookup });
      },
      () => {
        if (current) setLoad({ state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { load, reload };
}
