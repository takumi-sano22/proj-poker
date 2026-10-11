// RULING → ETIQUETTE の Overlay の順序（#226・D142・D145）。Hero の欄に出す裁定の欄を、Hero に見せている卓
// （displayed）と ETIQUETTE の確認（Ack）の状態から決定論で決める純関数。時刻（RULING を閉じるタイマー）は hooks/useDealerOverlay.ts が持つ。
// - RULING: 理由（notes）のある Hero への裁定を、表示に出た時点で先に出す（数秒で自動で閉じる。D142）
// - ETIQUETTE: server が確認を待っている裁定（pendingRulingSeq）だけ。RULING を閉じた後に出し、Hero が確認するまで閉じない（D145）
// - COACHING は出さない（今どおり Hero の欄の分類の button で Hero が開いたときだけ。docs/06 §6）
// - CPU の障害（Outage）のダイアログが出ている間は何も出さない（障害を先に。解決の後に残っていれば出す。D145）
// 文言は dealer-feedback.ts（RULING / ETIQUETTE を別の項目として作る）をそのまま使い、分類を混ぜない。
import type { HeroView } from "@proj-poker/engine";
import {
  dealerFeedbackAt,
  type DealerFeedbackItem,
} from "./dealer-feedback.js";

export interface DealerOverlay {
  readonly kind: "ruling" | "etiquette";
  /** 対象の裁定（DEALER_RULING）の seq。 */
  readonly rulingSeq: number;
  /** 出す項目（kind と同じ分類だけ）。 */
  readonly items: readonly DealerFeedbackItem[];
}

export interface DealerOverlayInput {
  /** Hero に見せている卓（displayed。演出の途中なら表示済みの Event まで）。 */
  readonly displayed: HeroView;
  /** server が確認を待っている裁定の seq（待っていない・まだ届いていなければ null）。 */
  readonly pendingRulingSeq: number | null;
  /** RULING を閉じた（数秒が過ぎた）最後の裁定の seq（まだ無ければ -1）。 */
  readonly rulingClosedThrough: number;
  /**
   * この画面の Session で Hand を最初に受け取ったときに、すでに表示済みだった最後の seq（再読み込み・Resume の後で、前に見た裁定の
   * RULING を出し直さない）。確認を待っている裁定は、これより前でも出し直す（RULING → ETIQUETTE の順で復元する）。
   */
  readonly baselineSeq: number;
  /** CPU の障害のダイアログが出ているか。 */
  readonly outageActive: boolean;
}

/** 確認を待つ裁定が Log に見つからないとき（形の合わない応答・古い View）に出す ETIQUETTE（安全側: 確認は求め続ける）。 */
const FALLBACK_ETIQUETTE: DealerFeedbackItem = {
  category: "etiquette",
  text: "Dealer からの作法の注意があります。確認すると進行が再開します。",
  terms: [],
};

/** 今出す裁定の欄（無ければ null）。 */
export function dealerOverlayOf(
  input: DealerOverlayInput,
): DealerOverlay | null {
  if (input.outageActive) return null;
  const { displayed, pendingRulingSeq } = input;
  const log = displayed.log;
  // RULING: 理由のある Hero への裁定のうち、まだ閉じていない最新のもの。
  const rulingIndex = log.findLastIndex(
    (e) =>
      e.type === "DEALER_RULING" &&
      e.playerId === displayed.viewerId &&
      e.notes.length > 0 &&
      e.seq > input.rulingClosedThrough &&
      (e.seq > input.baselineSeq || e.seq === pendingRulingSeq),
  );
  const ruling = log[rulingIndex];
  if (ruling !== undefined) {
    return {
      kind: "ruling",
      rulingSeq: ruling.seq,
      items: dealerFeedbackAt(log, rulingIndex, displayed.viewerId).filter(
        (i) => i.category === "ruling",
      ),
    };
  }
  if (pendingRulingSeq === null) return null;
  // 確認を待つ裁定が、まだ表示に出ていない（演出の途中）なら待つ。
  if ((log.at(-1)?.seq ?? -1) < pendingRulingSeq) return null;
  const index = log.findIndex((e) => e.seq === pendingRulingSeq);
  const items =
    index < 0
      ? []
      : dealerFeedbackAt(log, index, displayed.viewerId).filter(
          (i) => i.category === "etiquette",
        );
  return {
    kind: "etiquette",
    rulingSeq: pendingRulingSeq,
    items: items.length > 0 ? items : [FALLBACK_ETIQUETTE],
  };
}
