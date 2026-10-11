// RULING → ETIQUETTE の Overlay の React 側（#226・D142・D145）。順序の規則は lib/dealer-overlay.ts の純関数で、ここは RULING を
// 数秒で閉じるタイマーと、Hand を最初に受け取った時点（baseline）だけを持つ。useHandSession の中で使い、画面の切り替え（Home / Learn）
// より上の層で状態を持つ（Play に戻ったら、確認を待つ裁定の ETIQUETTE を出し直す。D142）。
import type { HeroView } from "@proj-poker/engine";
import { useEffect, useState } from "react";
import { RULING_OVERLAY_MS } from "../lib/config.js";
import { dealerOverlayOf, type DealerOverlay } from "../lib/dealer-overlay.js";
import { lastSeqOf } from "../lib/view-model.js";

interface OverlayMemory {
  /** どの Hand の記憶か（Hand が変われば作り直す）。 */
  readonly handId: string | null;
  readonly baselineSeq: number;
  readonly rulingClosedThrough: number;
}

const EMPTY: OverlayMemory = {
  handId: null,
  baselineSeq: -1,
  rulingClosedThrough: -1,
};

export function useDealerOverlay(
  displayed: HeroView | null,
  pendingRulingSeq: number | null,
  outageActive: boolean,
): DealerOverlay | null {
  const [memory, setMemory] = useState<OverlayMemory>(EMPTY);
  // Hand が変わったら記憶を作り直す（描画の中で状態を直す形）。この hook で最初に受け取った Hand は、その時点で表示済みの裁定を
  // 出し直さない（再読み込み・Resume）。続く Hand は Hand の始まりから見るので、始まりの時点を baseline にしても裁定を落とさない。
  let current = memory;
  if (displayed !== null && memory.handId !== displayed.handId) {
    current = {
      handId: displayed.handId,
      baselineSeq: memory.handId === null ? lastSeqOf(displayed) : -1,
      rulingClosedThrough: -1,
    };
    setMemory(current);
  }
  const overlay =
    displayed === null || current.handId !== displayed.handId
      ? null
      : dealerOverlayOf({
          displayed,
          pendingRulingSeq,
          rulingClosedThrough: current.rulingClosedThrough,
          baselineSeq: current.baselineSeq,
          outageActive,
        });

  // RULING は数秒で自動で閉じる（D142）。閉じた位置を進めると、確認が要れば続けて ETIQUETTE が出る。
  const rulingSeq = overlay?.kind === "ruling" ? overlay.rulingSeq : null;
  const handId = current.handId;
  useEffect(() => {
    if (rulingSeq === null) return;
    const timer = setTimeout(() => {
      setMemory((m) =>
        m.handId === handId && m.rulingClosedThrough < rulingSeq
          ? { ...m, rulingClosedThrough: rulingSeq }
          : m,
      );
    }, RULING_OVERLAY_MS);
    return () => clearTimeout(timer);
  }, [handId, rulingSeq]);

  return overlay;
}
