// CPU の障害のダイアログ（D86・docs/06 §12）。卓の中央に出し（狭い画面では席と重ならないよう Hero の欄に出し）、
// Hero が選ぶまで Hand は止まったまま（Pause）。
// 出すのは「どの CPU の手番か・障害の種類」だけで、内部のエラー本文・使っている API の名前は出さない（docs/06 §11）。
import type { OutageChoice, OutageKind } from "../lib/api.js";
import { outageReasonText } from "../lib/view-model.js";

interface OutageDialogProps {
  /** 障害で止まった CPU の表示名。 */
  readonly actorName: string;
  readonly kind: OutageKind;
  /** 送信中は選べない。 */
  readonly disabled: boolean;
  /** 狭い画面で Hero の欄に出すとき（卓に重ねず、流れの中に置く）。 */
  readonly docked?: boolean;
  readonly onChoose: (choice: OutageChoice) => void;
}

export function OutageDialog({
  actorName,
  kind,
  disabled,
  docked = false,
  onChoose,
}: OutageDialogProps) {
  return (
    <section
      className={docked ? "outage outage--docked" : "outage"}
      role="alertdialog"
      aria-labelledby="outage-title"
      aria-describedby="outage-desc"
    >
      <h2 id="outage-title" className="outage__title">
        {actorName} の判断を受け取れませんでした
      </h2>
      <div id="outage-desc" className="outage__desc">
        <p>{outageReasonText(kind)}</p>
        <p>続け方を選ぶまで、Hand は一時停止しています。</p>
      </div>
      <ul className="outage__choices">
        <li>
          <button
            type="button"
            className="btn btn--primary btn--md"
            disabled={disabled}
            // 卓の中央に出たダイアログへ、キーボードの操作もすぐ移す。
            autoFocus
            onClick={() => onChoose("retry")}
          >
            もう一度試す（Retry）
          </button>
          <span className="outage__hint">同じ手番をもう一度待ちます</span>
        </li>
        <li>
          <button
            type="button"
            className="btn btn--secondary btn--md"
            disabled={disabled}
            onClick={() => onChoose("emergency_bot")}
          >
            Emergency Bot で続行
          </button>
          <span className="outage__hint">
            {actorName} をこの Session の終わりまで簡易 Bot
            で動かします（記録に残ります）
          </span>
        </li>
        <li>
          <button
            type="button"
            className="btn btn--ghost btn--md"
            disabled={disabled}
            onClick={() => onChoose("end_session")}
          >
            Session を終了
          </button>
          <span className="outage__hint">
            この Hand を打ち切り、Session を終えます
          </span>
        </li>
      </ul>
    </section>
  );
}
