// Replay の表示の材料（#68・D38・D93）。サーバーが返した Hero の視点の step だけを使い、状態をクライアントで進めない
// （Engine を動かし直さない・AI で作り直さない）。ここは step の移動と、step・一覧の 1 行の文言だけを持つ。
import type { HandEvent, HeroView } from "@proj-poker/engine";
import type { ReplayHandSummary } from "./api.js";
import {
  ACTION_TERMS,
  cardShortLabel,
  formatChips,
  formatChipsWithBB,
  termLabel,
} from "./format.js";
import { describeEvent } from "./view-model.js";

/** 次の step（最後なら最後のまま）。 */
export function nextStepIndex(index: number, length: number): number {
  return Math.min(index + 1, Math.max(0, length - 1));
}

/** 前の step（最初なら最初のまま）。 */
export function previousStepIndex(index: number): number {
  return Math.max(0, index - 1);
}

/** Play を押したときに始める step。最後の step で押したら最初から再生し直す。 */
export function playStartIndex(index: number, length: number): number {
  return index >= length - 1 ? 0 : index;
}

/**
 * その step で起きたこと（step の最後の Event）の 1 行。Action に決まった裁定と Action を 1 step にまとめた step は Action の行で、
 * 裁定の文言は Dealer Feedback の欄に出す（文言を二重に作らない）。
 */
export function stepCaption(
  view: HeroView,
  nameOf: (playerId: string) => string,
): string {
  const event = view.log.at(-1);
  if (event === undefined) return "";
  return describeEvent(event, nameOf) ?? describeLiveEvent(event, nameOf);
}

/** 進行ログでは行にしない Hero の操作と裁定（#64）を、Replay の step の 1 行にする。 */
function describeLiveEvent(
  event: HandEvent,
  nameOf: (playerId: string) => string,
): string {
  switch (event.type) {
    case "PLAYER_DECLARED": {
      const d = event.declaration;
      const amount =
        "amount" in d && d.amount !== undefined
          ? ` ${formatChips(d.amount)}`
          : "";
      return `${nameOf(event.playerId)}: 宣言（Declaration）「${termLabel(ACTION_TERMS[d.kind])}${amount}」`;
    }
    case "PHYSICAL_CHIP_ACTION": {
      const total = event.chips.reduce((sum, c) => sum + c, 0);
      const verb = event.motion === "chip_push" ? "出した" : "足した";
      return `${nameOf(event.playerId)}: Chip を${verb}（${event.chips.length} 枚・合計 ${formatChips(total)}）`;
    }
    case "DEALER_RULING":
      return `Dealer が ${nameOf(event.playerId)} の操作を裁定`;
    default:
      return "";
  }
}

/** Hero の収支の表記（実額 + BB 補助。D49）。未完了の Hand は null。 */
export function formatHeroNet(
  summary: ReplayHandSummary,
  showBB: boolean,
): string | null {
  const net = summary.heroNet;
  if (net === null) return null;
  const sign = net > 0 ? "+" : net < 0 ? "−" : "±";
  return `${sign}${formatChipsWithBB(Math.abs(net), summary.bigBlind, showBB)}`;
}

/** 一覧の Hero の札の表記（配られる前に打ち切った Hand は「札なし」）。 */
export function heroCardsLabel(summary: ReplayHandSummary): string {
  return summary.heroHoleCards === null
    ? "札なし"
    : summary.heroHoleCards.map(cardShortLabel).join(" ");
}

const startedAtFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Hand の開始時刻（この端末の時刻帯の 月/日 時:分）。読めない値はそのまま返す。 */
export function formatStartedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : startedAtFormat.format(date);
}
