// ETIQUETTE の確認（Ack）が要る裁定の判定（UX-11 #226・D145）。
// - Ack が要るかは、Hero に見える公開の DEALER_RULING の notes だけから決定論で導く（outcome・basis・前後の Event に依らない）。
//   Ack の単位は裁定の seq で、notes が複数でも 1 回。
// - 判定は裁定・合法 Action・状態遷移の意味を変えない（表示の文言は client の dealer-feedback.ts が持ち、ここは集合だけを持つ）。
// - 確認した位置（ackedThroughSeq）は server の HandRuntime のメモリにだけ持ち、Event には残さない（D145）。
import type { HandEvent } from "./hand-events.js";
import { visibleEvents } from "./projection.js";
import type { RulingCode } from "./ruling.js";

/**
 * Ack が要る RulingCode（D145 の 7 種。client の ETIQUETTE の文言の表のキーと同じ集合）。
 * 拘束・撤回の記録（out_of_turn_binding / out_of_turn_released）と、額の調整だけの裁定は Ack を要らない。
 */
export const ETIQUETTE_ACK_CODES: ReadonlySet<RulingCode> = new Set<RulingCode>(
  [
    "out_of_turn",
    "string_bet",
    "oversized_chip",
    "declaration_ignored",
    "half_raise_completed",
    "under_half_raise",
    "check_facing_bet",
  ],
);

/** 裁定の notes に Ack の要る理由が 1 つでもあるか。 */
export function requiresEtiquetteAck(notes: readonly RulingCode[]): boolean {
  return notes.some((code) => ETIQUETTE_ACK_CODES.has(code));
}

/**
 * viewer に見える Event のうち、viewer への Ack の要る DEALER_RULING の seq（Log の順）。
 * viewer に見えない Event（system・engine・他者の private）は使わない（Hidden 情報で Ack の要否を決めない。D28）。
 */
export function etiquetteAckRulingSeqs(
  events: readonly HandEvent[],
  viewerId: string,
): number[] {
  return visibleEvents(events, viewerId)
    .filter(
      (e) =>
        e.type === "DEALER_RULING" &&
        e.playerId === viewerId &&
        requiresEtiquetteAck(e.notes),
    )
    .map((e) => e.seq);
}
