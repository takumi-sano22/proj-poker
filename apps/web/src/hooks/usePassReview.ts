// 1 つの判断の 1 つの Pass（Pass A: 判断時点の Review / Pass B: Hand 後の答え合わせ）の画面状態（#84）。
// 状態（最新の Version・Version の数・生成の状態）を読み、生成の待ちの間は読み直す。Version を選んだら、その Version を読む
// （選ばない間・最新を選んだときは最新を出す。新しく作ったら最新に戻す）。過去の Version は上書きされない（D39）。
import { useCallback, useState } from "react";
import {
  passPath,
  passVersionPath,
  requestPass,
  type PassStatus,
  type ReviewDepth,
  type ReviewPass,
} from "../lib/review-api.js";
import { usePolled } from "./usePolled.js";

export interface PassReview<R> {
  readonly status: PassStatus<R> | null;
  /** 状態を読めなかった（読み直しは refresh）。 */
  readonly failed: boolean;
  readonly refresh: () => void;
  /** 今見せている Version（無ければ null）。 */
  readonly record: R | null;
  /** 選んだ Version の読み込みに失敗した。 */
  readonly recordFailed: boolean;
  /** 選んでいる Version（null は最新）。 */
  readonly selectedVersion: number | null;
  readonly selectVersion: (version: number | null) => void;
  /** 新しい Version の生成を始める。送れなかったら false。 */
  readonly request: (depth: ReviewDepth) => Promise<boolean>;
  /** 生成の要求を送っている途中か（二重に押させない）。 */
  readonly requesting: boolean;
  /** 直前の生成の要求を送れなかった（もう一度押してもらう）。 */
  readonly requestFailed: boolean;
}

export function usePassReview<R extends { readonly version: number }>(
  handId: string,
  decisionIndex: number,
  pass: ReviewPass,
): PassReview<R> {
  const path = passPath(handId, decisionIndex, pass);
  const status = usePolled<PassStatus<R>>(path);
  // 選んだ Version は判断・Pass ごとに持つ（別の判断へ移ったら最新に戻す）。
  const [selection, setSelection] = useState<{
    readonly path: string;
    readonly version: number | null;
  }>({ path, version: null });
  const [requesting, setRequesting] = useState(false);
  // 送れなかった要求の印も判断・Pass ごとに持つ。
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const selectedVersion = selection.path === path ? selection.version : null;

  const latest = status.data?.latest ?? null;
  // 最新以外を選んだときだけ、その Version を読む。
  const olderVersion =
    selectedVersion !== null &&
    latest !== null &&
    selectedVersion !== latest.version
      ? selectedVersion
      : null;
  const older = usePolled<R>(
    olderVersion === null
      ? null
      : passVersionPath(handId, decisionIndex, pass, olderVersion),
  );

  const selectVersion = useCallback(
    (version: number | null) => setSelection({ path, version }),
    [path],
  );

  const { mutate } = status;
  const request = useCallback(
    async (depth: ReviewDepth) => {
      setRequesting(true);
      setFailedPath(null);
      try {
        await mutate(requestPass<PassStatus<R>>(path, depth));
        // 作り始めたら最新（これから作る Version）を見せる。
        setSelection({ path, version: null });
        return true;
      } catch {
        setFailedPath(path);
        return false;
      } finally {
        setRequesting(false);
      }
    },
    [mutate, path],
  );

  return {
    status: status.data,
    failed: status.failed,
    refresh: status.refresh,
    record: olderVersion === null ? latest : older.data,
    recordFailed: olderVersion !== null && older.failed,
    selectedVersion,
    selectVersion,
    request,
    requesting,
    requestFailed: failedPath === path,
  };
}
