// Review の API の状態を読む（#84）。path（GET の URL）ごとに 1 回読み、生成の待ち（generation.state: pending）の間は
// 一定の間隔で読み直す。POST の応答（待ちの状態）も mutate で同じ状態に入れる。
// 古い応答で画面を戻さないよう、要求のたびに番号を振り、最後に出した要求の応答だけを採る（LC-041）。
// path が変わったら、前の path の値は見せない（state に path を持たせ、今の path と違えば空として扱う）。
import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../lib/api.js";
import { REVIEW_POLL_MS } from "../lib/config.js";
import type { ReviewGeneration } from "../lib/review-api.js";

export interface Polled<T> {
  /** 読めた値（まだ無い・path が変わった直後は null）。 */
  readonly data: T | null;
  /** 最後の読み込みに失敗したか（失敗した間は読み直さない。refresh で読み直す）。 */
  readonly failed: boolean;
  readonly refresh: () => void;
  /** POST 等の応答を状態として採る。失敗は呼び出し側へそのまま返す。 */
  readonly mutate: (request: Promise<T>) => Promise<void>;
}

interface Snapshot<T> {
  readonly path: string | null;
  readonly data: T | null;
  readonly failed: boolean;
}

export function usePolled<T extends object>(path: string | null): Polled<T> {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({
    path: null,
    data: null,
    failed: false,
  });
  const seq = useRef(0);
  const current: Snapshot<T> =
    snapshot.path === path ? snapshot : { path, data: null, failed: false };

  const refresh = useCallback(() => {
    if (path === null) return;
    const id = ++seq.current;
    getJson<T>(path).then(
      (data) => {
        if (id === seq.current) setSnapshot({ path, data, failed: false });
      },
      () => {
        if (id !== seq.current) return;
        setSnapshot((s) => ({
          path,
          data: s.path === path ? s.data : null,
          failed: true,
        }));
      },
    );
  }, [path]);

  const mutate = useCallback(
    (request: Promise<T>) => {
      const id = ++seq.current;
      return request.then(
        (data) => {
          if (id === seq.current) setSnapshot({ path, data, failed: false });
        },
        (err: unknown) => {
          // 送れなかった間に届いた読み直しの応答は捨てているので、読み直して今の状態へ戻す。
          if (id === seq.current) refresh();
          throw err;
        },
      );
    },
    [path, refresh],
  );

  // 最初と path が変わったときに読む。
  useEffect(() => {
    refresh();
  }, [refresh]);

  // 生成の待ちの間だけ、間隔をあけて読み直す（応答のたびに次を仕掛ける）。
  const data = current.data;
  const pending = isPending(data) && !current.failed;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(refresh, REVIEW_POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, data, refresh]);

  return { data, failed: current.failed, refresh, mutate };
}

/** 生成の待ち（generation.state: pending）の値か。generation を持たない値（Review の Version 等）は待たない。 */
function isPending(data: object | null): boolean {
  if (data === null || !("generation" in data)) return false;
  return (data.generation as ReviewGeneration).state === "pending";
}
