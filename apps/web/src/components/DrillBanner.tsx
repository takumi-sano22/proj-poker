// Targeted Drill の説明（#117・docs/07 §7・docs/06 §14）。Drill の卓の上に置き、元の判断から何を一つだけ変えたかを示す。
// 出すのは元の Hand の公開の事実（Stack・Bet の額・Bet した席）と Drill の設定（相手の傾向）だけで、他者の札・元の CPU の Hidden Persona は出さない。
// 額は実額を正本にし、BB は補助（D49）。
import type { TablePlayer } from "../lib/api.js";
import type { DrillView } from "../lib/drill-api.js";
import { DRILL_VARIANT_LABELS, percentText } from "../lib/drill.js";
import { Amount } from "./Amount.js";

export function DrillBanner({
  drill,
  bigBlind,
  players,
}: {
  readonly drill: DrillView;
  readonly bigBlind: number;
  readonly players: readonly TablePlayer[];
}) {
  const nameOf = (playerId: string) =>
    players.find((p) => p.playerId === playerId)?.displayName ?? playerId;
  const change = drill.change;
  return (
    <section className="drill-banner" aria-labelledby="drill-banner-title">
      <h2 className="drill-banner__title" id="drill-banner-title">
        Targeted Drill（練習）
      </h2>
      <p className="drill-banner__change">
        <span className="badge">
          {DRILL_VARIANT_LABELS[drill.variant.kind]}
        </span>{" "}
        {change === null ? (
          "を変えた類題です。"
        ) : change.kind === "effective_stack" ? (
          <>
            開始時の全員の Stack を {change.factor} 倍にしました（Hero{" "}
            <Amount value={change.heroStackFrom} bigBlind={bigBlind} inline /> →{" "}
            <Amount value={change.heroStackTo} bigBlind={bigBlind} inline />
            ）。
          </>
        ) : change.kind === "bet_size" ? (
          <>
            {nameOf(change.bettorId)} の Bet を{" "}
            <Amount value={change.betFrom} bigBlind={bigBlind} inline /> →{" "}
            <Amount value={change.betTo} bigBlind={bigBlind} inline />
            （Bet の前の Pot の {percentText(change.potFraction)}）にしました。
          </>
        ) : (
          <>
            判断の後の相手は「{change.presetLabel}」の傾向で動きます（Drill
            の設定）。
          </>
        )}
      </p>
      {/* しくみの説明は畳んでおく（狭い画面で卓を押し下げない） */}
      <details className="drill-banner__details">
        <summary>この Drill のしくみ</summary>
        <p className="drill-banner__note">
          Hero の札と、判断した時点の Board・それまでの Action は元の Hand
          のままです。相手の札とこの後の Board は配り直し、判断の後の相手は
          RuleBot が決定論で動かします（相手の傾向は Drill の設定で、元の Hand
          の相手の性格ではありません）。結果は通常の Score と別に数えます。
        </p>
      </details>
    </section>
  );
}
