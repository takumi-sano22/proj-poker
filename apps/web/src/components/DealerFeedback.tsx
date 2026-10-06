// Dealer Feedback の表示（docs/06 §6）。RULING / ETIQUETTE / COACHING を別の項目として、分類の名前と色で分けて出す
// （同じ Warning として混ぜない）。色だけに頼らず、分類の名前を必ず添える。
// Hero 欄は卓の下側の席を覆わないよう低く保つ必要があるので、Game State に影響する RULING だけを常に出し、
// ETIQUETTE と COACHING は分類の名前の button で開く（進行ログには 3 分類とも全文を残す）。
import type { HeroView } from "@proj-poker/engine";
import { useId, useState, type ReactNode } from "react";
import {
  FEEDBACK_CATEGORY_LABELS,
  dealerFeedbackAt,
  type DealerFeedbackItem,
  type FeedbackCategory,
} from "../lib/dealer-feedback.js";
import { STREET_TERMS, termLabel } from "../lib/format.js";
import { latestHeroRulingIndex } from "../lib/view-model.js";
import { Term } from "./Vocabulary.js";

interface DealerFeedbackProps {
  readonly items: readonly DealerFeedbackItem[];
  /** RULING の前に添える見出し（前の Street の裁定であることを示すときなど）。 */
  readonly heading?: string;
}

export function DealerFeedback({ items, heading }: DealerFeedbackProps) {
  const [opened, setOpened] = useState<FeedbackCategory | null>(null);
  const panelId = useId();
  if (items.length === 0) return null;
  const rulings = items.filter((i) => i.category === "ruling");
  const others = items.filter((i) => i.category !== "ruling");
  const categories = [...new Set(others.map((i) => i.category))];
  const shown = others.filter((i) => i.category === opened);

  return (
    <section
      className="feedback"
      aria-label="Dealer の裁定と補足"
      role="status"
    >
      <ul className="feedback__list">
        {rulings.map((item, i) => (
          <FeedbackItem
            key={i}
            item={item}
            heading={i === 0 ? heading : undefined}
            extra={
              i === 0 &&
              categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`feedback-tag feedback-tag--${c} feedback__toggle`}
                  aria-expanded={opened === c}
                  aria-controls={panelId}
                  onClick={() => setOpened(opened === c ? null : c)}
                >
                  {FEEDBACK_CATEGORY_LABELS[c]}
                </button>
              ))
            }
          />
        ))}
      </ul>
      {shown.length > 0 && (
        <ul className="feedback__list" id={panelId}>
          {shown.map((item, i) => (
            <FeedbackItem key={i} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedbackItem({
  item,
  heading,
  extra,
}: {
  readonly item: DealerFeedbackItem;
  readonly heading?: string | undefined;
  readonly extra?: ReactNode;
}) {
  return (
    <li
      className={`feedback__item feedback__item--${item.category}`}
      data-category={item.category}
    >
      <FeedbackTag category={item.category} />
      <span className="feedback__text">
        {heading !== undefined && (
          <span className="feedback__heading">{heading}: </span>
        )}
        {item.text}
      </span>
      <span className="feedback__terms">
        {item.terms.map((t) => (
          <Term key={t} id={t} className="term--chip" />
        ))}
        {extra}
      </span>
    </li>
  );
}

/** 分類の名前の札（進行ログでも同じ見た目を使う）。 */
export function FeedbackTag({
  category,
}: {
  readonly category: FeedbackCategory;
}) {
  return (
    <span className={`feedback-tag feedback-tag--${category}`}>
      {FEEDBACK_CATEGORY_LABELS[category]}
    </span>
  );
}

/**
 * 直近の Hero への裁定の Dealer Feedback（RULING / ETIQUETTE / COACHING。docs/06 §6）。卓の Hero 欄と Replay で使う。
 * 前の Street の裁定（Hero の Call で Street が閉じた直後など）には、どの Street の裁定かを添える。
 */
export function HeroFeedback({ view }: { readonly view: HeroView }) {
  const index = latestHeroRulingIndex(view);
  if (index === null) return null;
  const ruling = view.log[index];
  if (ruling?.type !== "DEALER_RULING") return null;
  const heading =
    ruling.street === view.street
      ? undefined
      : `${termLabel(STREET_TERMS[ruling.street])}の裁定`;
  return (
    <DealerFeedback
      // 裁定が変わったら、開いていた補足（作法・学習）を閉じる
      key={ruling.seq}
      items={dealerFeedbackAt(view.log, index, view.viewerId)}
      heading={heading}
    />
  );
}
