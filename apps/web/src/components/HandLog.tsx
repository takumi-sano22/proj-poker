// Hand の進行ログ。Hero に見える Event（サーバーの HeroView.log）だけを文章にする。
// Hero への裁定（DEALER_RULING）は Dealer Feedback として、RULING / ETIQUETTE / COACHING を分類ごとに別の行にする（docs/02 §8）。
import type { HeroView } from "@proj-poker/engine";
import {
  dealerFeedbackAt,
  type FeedbackCategory,
} from "../lib/dealer-feedback.js";
import { describeEvent } from "../lib/view-model.js";
import { FeedbackTag } from "./DealerFeedback.js";

interface HandLogProps {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
}

interface LogLine {
  readonly key: string;
  readonly text: string;
  readonly category: FeedbackCategory | null;
}

export function HandLog({ view, nameOf }: HandLogProps) {
  const lines = view.log.flatMap((e, index): LogLine[] => {
    if (e.type === "DEALER_RULING") {
      return dealerFeedbackAt(view.log, index, view.viewerId).map((f, i) => ({
        key: `${e.seq}-${i}`,
        text: f.text,
        category: f.category,
      }));
    }
    const text = describeEvent(e, nameOf);
    return text === null ? [] : [{ key: `${e.seq}`, text, category: null }];
  });
  return (
    <section className="hand-log" aria-label="Hand の進行">
      <h2 className="hand-log__title">進行（Action Log）</h2>
      {/* 新しい行を上に置き、スクロールしなくても直近の Action が見えるようにする */}
      <ol className="hand-log__list" reversed>
        {[...lines].reverse().map((l) =>
          l.category === null ? (
            <li key={l.key}>{l.text}</li>
          ) : (
            <li
              key={l.key}
              className={`hand-log__feedback hand-log__feedback--${l.category}`}
              data-category={l.category}
            >
              <FeedbackTag category={l.category} /> {l.text}
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
