// 保存済み Event の upcast（D76）。旧版の payload を、読み込み時に現在の HandEvent の形へそろえる。
// 保存済みの行は書き換えない（events は append-only。D37）。読むたびに同じ変換をする。
import type { HandEvent } from "@proj-poker/engine";

/** 版 1 の POT_AWARDED（Phase 1 の単一 Pot。potIndex と eligible が無い）。 */
type PotAwardedV1 = Omit<
  Extract<HandEvent, { type: "POT_AWARDED" }>,
  "potIndex" | "eligible"
>;

/** 版 1 の Event。POT_AWARDED 以外の形は版 2 と同じ。 */
export type HandEventV1 =
  Exclude<HandEvent, { type: "POT_AWARDED" }> | PotAwardedV1;

/**
 * 版 1 → 版 2（D78）。版 1 は単一 Pot なので、POT_AWARDED を Main Pot（potIndex 0）とし、
 * eligible はその時点で Fold していない Player（Button の左から時計回りの順。版 2 の Engine と同じ順）で補う。
 * Fold で決着した Hand では勝者 1 人、Showdown ではその Hand に残った全員になる。
 * events は 1 Hand 分を seq 順に渡す（Fold の有無を前の Event から数えるため）。
 */
export function upcastV1ToV2(events: readonly HandEventV1[]): HandEvent[] {
  const folded = new Set<string>();
  let seatsFromButton: readonly string[] = [];
  return events.map((event): HandEvent => {
    switch (event.type) {
      case "HAND_STARTED": {
        const ids = event.seats.map((s) => s.playerId);
        const button = ids.indexOf(event.buttonPlayerId);
        seatsFromButton = ids.map(
          (_, k) => ids[(button + 1 + k) % ids.length] as string,
        );
        return event;
      }
      case "ACTION_TAKEN":
        if (event.action === "fold") folded.add(event.playerId);
        return event;
      case "POT_AWARDED":
        return {
          ...event,
          potIndex: 0,
          eligible: seatsFromButton.filter((id) => !folded.has(id)),
        };
      default:
        return event;
    }
  });
}
