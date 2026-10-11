// RULING → ETIQUETTE の欄（#226・D142・D145・docs/06 §6）。広い画面は卓の中央（Board・Pot の下に流れで置き、Pot の実額を覆わない）、
// 狭い画面は Hero の欄の中に出す（席・Hero の札・Stack に重ねない。CPU の障害のダイアログと同じ置き場所の規則）。
// - RULING: 裁定の事実。数秒で自動で閉じる（閉じる時刻は hooks/useDealerOverlay.ts）。操作を求めないので status で読み上げる
// - ETIQUETTE: 作法の注意。Hero が「確認しました」を押すまで閉じない（進行は server が止めている）。マウス・タッチ・キーボード
//   （Tab で移って Enter / Space）のどれでも押せる。出たときにボタンへフォーカスを移す
// 分類（RULING / ETIQUETTE）は別の欄で、同じ Warning として混ぜない。COACHING はここに出さない（Hero の欄の分類の button で開く）。
import { useId } from "react";
import type { DealerOverlay as DealerOverlayState } from "../lib/dealer-overlay.js";
import { FeedbackTag } from "./DealerFeedback.js";
import { Term } from "./Vocabulary.js";

interface DealerOverlayProps {
  readonly overlay: DealerOverlayState;
  /** 送信中（確認を送っている・別の操作の応答待ち）は押せない（二重送信を止める）。 */
  readonly disabled: boolean;
  /** 狭い画面で Hero の欄に出すとき。 */
  readonly docked?: boolean;
  readonly onAcknowledge: () => void;
}

export function DealerOverlay({
  overlay,
  disabled,
  docked = false,
  onAcknowledge,
}: DealerOverlayProps) {
  const titleId = useId();
  const descId = useId();
  const className = `dealer-overlay dealer-overlay--${overlay.kind}${docked ? " dealer-overlay--docked" : ""}`;
  const items = (
    <ul className="dealer-overlay__items" id={descId}>
      {overlay.items.map((item, i) => (
        <li key={i} className="dealer-overlay__item">
          <FeedbackTag category={item.category} />
          <span className="dealer-overlay__text">{item.text}</span>
          {item.terms.length > 0 && (
            <span className="dealer-overlay__terms">
              {item.terms.map((t) => (
                <Term key={t} id={t} className="term--chip" />
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
  if (overlay.kind === "ruling") {
    return (
      <section
        className={className}
        role="status"
        aria-labelledby={titleId}
        data-ruling-seq={overlay.rulingSeq}
      >
        <h2 id={titleId} className="dealer-overlay__title">
          Dealer の裁定
        </h2>
        {items}
      </section>
    );
  }
  return (
    <section
      className={className}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-ruling-seq={overlay.rulingSeq}
    >
      <h2 id={titleId} className="dealer-overlay__title">
        Dealer からの作法の注意
      </h2>
      {items}
      <p className="dealer-overlay__hint">
        確認するまで進行は止まっています（Home / Learn
        に移っても待ちは続きます）。
      </p>
      <button
        type="button"
        className="btn btn--primary btn--md dealer-overlay__ack"
        disabled={disabled}
        // 出た欄へキーボードの操作もすぐ移す（障害のダイアログと同じ）。
        autoFocus
        onClick={onAcknowledge}
      >
        確認しました
      </button>
    </section>
  );
}
