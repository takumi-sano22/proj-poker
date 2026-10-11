// Hand の開始の要求の流れ（#218 の 2 段階の開始・#226 の ETIQUETTE の確認待ち）。React の状態を持たない async 関数で、
// useHandSession が結果を画面の状態へ写す（単体テストで 409 からの復帰を確かめられるよう、ここに分ける）。
import {
  ApiError,
  type SessionRequest,
  type StartHandResponse,
} from "./api.js";
import { isUnseenEndedHand, parseEtiquetteStatus } from "./view-model.js";

export type StartRequest = (
  afterHandId: string | null,
  session?: SessionRequest,
) => Promise<StartHandResponse>;

export type StartOutcome =
  | {
      readonly kind: "started";
      readonly res: StartHandResponse;
      /**
       * 開いたのが、ETIQUETTE の確認を待つ「終わった Session の最後の Hand」か（新しい Session を求めたが、確認まで server は新しい
       * Hand を作らないので、その Hand を開いて確認を求める。D145）。
       */
      readonly awaitingEtiquette: boolean;
    }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      /** 最後に送った afterHandId（再送で同じ値を送る）。 */
      readonly sentAfter: string | null;
      /**
       * 2 回目の開始が etiquette_ack_required で拒否されたときの、1 回目の応答（終わった Session の最後の Hand と確認の状態）。
       * 呼び出し側はこの Hand を開いて確認を求める（自動で確認・再送しない・終わった Hand を捨てない）。それ以外は null。
       */
      readonly awaitingHand: StartHandResponse | null;
    };

/**
 * 開始の要求を送る。新しい Session を求めたのに、結果を見ていない終わった Session の最後の Hand が返った（再読み込みの直後の Home
 * など。#218）ら、その Hand を見たものとしてもう 1 回だけ送る。ただしその Hand が ETIQUETTE の確認を待っていれば 2 回目を送らない
 * （送っても etiquette_ack_required になる。D145）。
 */
export async function runStart(
  request: StartRequest,
  afterHandId: string | null,
  session?: SessionRequest,
): Promise<StartOutcome> {
  let first: StartHandResponse;
  try {
    first = await request(afterHandId, session);
  } catch (error: unknown) {
    return {
      kind: "failed",
      error,
      sentAfter: afterHandId,
      awaitingHand: null,
    };
  }
  if (!isUnseenEndedHand(afterHandId, session, first)) {
    return { kind: "started", res: first, awaitingEtiquette: false };
  }
  if (parseEtiquetteStatus(first.etiquette)?.pendingRulingSeq != null) {
    return { kind: "started", res: first, awaitingEtiquette: true };
  }
  try {
    const res = await request(first.handId, session);
    return { kind: "started", res, awaitingEtiquette: false };
  } catch (error: unknown) {
    const awaiting =
      error instanceof ApiError && error.kind === "etiquette_ack_required";
    return {
      kind: "failed",
      error,
      sentAfter: first.handId,
      awaitingHand: awaiting ? first : null,
    };
  }
}
