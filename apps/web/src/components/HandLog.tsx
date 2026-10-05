// Hand の進行ログ。Hero に見える Event（サーバーの HeroView.log）だけを文章にする。
import type { HeroView } from "@proj-poker/engine";
import { describeEvent } from "../lib/view-model.js";

interface HandLogProps {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
}

export function HandLog({ view, nameOf }: HandLogProps) {
  const lines = view.log.flatMap((e) => {
    const text = describeEvent(e, nameOf);
    return text === null ? [] : [{ seq: e.seq, text }];
  });
  return (
    <section className="hand-log" aria-label="Hand の進行">
      <h2 className="hand-log__title">進行（Action Log）</h2>
      {/* 新しい行を上に置き、スクロールしなくても直近の Action が見えるようにする */}
      <ol className="hand-log__list" reversed>
        {[...lines].reverse().map((l) => (
          <li key={l.seq}>{l.text}</li>
        ))}
      </ol>
    </section>
  );
}
