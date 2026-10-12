// 中身のあった Hero の操作の下書きを無効化で捨てたときの通知（#219・D146・UX04-3=A）。Hero の欄の操作の近くに、非モーダルで短く出す
// （進行を止めない・フォーカスを奪わない）。文言・表示時間は OI-012 の暫定値。空の下書きを捨てたときは出さない（lib/turn-draft.ts）。
import { useEffect } from "react";
import { DRAFT_DISCARD_NOTICE_MS } from "../lib/config.js";
import type { DiscardNotice, DiscardReason } from "../lib/turn-draft.js";

const REASON_TEXT: Record<DiscardReason, string> = {
  street: "Street が進んだため",
  hand: "Hand が変わったため",
  ruling: "Dealer の裁定が入ったため",
  hand_complete: "Hand が終わったため",
  left_hand: "Hero が Hand から外れたため",
};

/** 捨てた理由ごとの通知の文。送っていないことを必ず添える。 */
export function draftDiscardedMessage(reason: DiscardReason): string {
  return `${REASON_TEXT[reason]}、組んでいた操作（手元の Chip・出した Chip・宣言）を戻しました。この操作は送っていません。`;
}

export function DraftDiscardedNotice({
  notice,
  onDismiss,
}: {
  readonly notice: DiscardNotice;
  readonly onDismiss: (id: number) => void;
}) {
  // 出してから数える（この部品が出ている間だけ。画面を離れている間に捨てた通知は、戻ったときに改めて出す）。
  useEffect(() => {
    const timer = setTimeout(
      () => onDismiss(notice.id),
      DRAFT_DISCARD_NOTICE_MS,
    );
    return () => clearTimeout(timer);
  }, [notice.id, onDismiss]);
  return (
    <div className="notice notice--draft" role="status">
      <p>{draftDiscardedMessage(notice.reason)}</p>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => onDismiss(notice.id)}
      >
        閉じる
      </button>
    </div>
  );
}
