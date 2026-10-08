// Tournament の順位・Payout のテスト用に、Engine で Hand を実際に進める（積んだ Deck と All-in）ヘルパー（#185・#186）。
// 次の Hand の席と Button は nextHandSeating で決める（Hand Engine を複製しない）。
import { applyAction, recordSessionEvent, startHand } from "../hand-engine.js";
import type { HandEvent, SeatInit, SessionEndReason } from "../hand-events.js";
import { getLegalActions } from "../legal-actions.js";
import { nextHandSeating } from "../position.js";
import { PHASE1_CASH_PRESET, type TableConfig } from "../table-config.js";
import { TOURNAMENT_PRESETS, tableConfigForLevel } from "../tournament.js";
import { stackedDeck } from "./stacked-deck.js";

const STANDARD = TOURNAMENT_PRESETS.stt6_hand_count;
export const TABLE: TableConfig = tableConfigForLevel(
  PHASE1_CASH_PRESET,
  { smallBlind: 10, bigBlind: 20, ante: 0 },
  "none",
);

export interface HandSpec {
  readonly handId: string;
  readonly seats: readonly SeatInit[];
  readonly buttonPlayerId: string;
  readonly holes: Readonly<Record<string, string>>;
  readonly board: string;
  /** Session の最初の Hand に置く SESSION_STARTED（Tournament の設定の Snapshot を持たせるか）。 */
  readonly sessionStart?: "tournament" | "cash";
  /** Hand の終わりに続ける SESSION_ENDED の理由。 */
  readonly sessionEnd?: SessionEndReason;
}

/** 手番の Player が全員 All-in（できなければ Call / Check）して Hand を最後まで進めた Event Log。 */
export function playAllIn(spec: HandSpec): HandEvent[] {
  const started = startHand({
    handId: spec.handId,
    seats: spec.seats,
    buttonPlayerId: spec.buttonPlayerId,
    config: TABLE,
    deal: {
      deck: stackedDeck(
        spec.seats,
        spec.buttonPlayerId,
        spec.holes,
        spec.board,
      ),
    },
  });
  if (!started.ok) throw new Error(started.error.message);
  let { state } = started.value;
  const events: HandEvent[] = [...started.value.events];
  if (spec.sessionStart !== undefined) {
    const session = recordSessionEvent(state, {
      type: "SESSION_STARTED",
      sessionId: "s1",
      ...(spec.sessionStart === "tournament" ? { tournament: STANDARD } : {}),
    });
    state = session.state;
    events.push(...session.events);
  }
  while (state.status === "in_progress" && state.actorIndex !== null) {
    const actor = state.players[state.actorIndex];
    const types = getLegalActions(state)?.actions.map((a) => a.type) ?? [];
    const type = types.includes("all_in")
      ? "all_in"
      : types.includes("call")
        ? "call"
        : "check";
    const result = applyAction(state, actor!.playerId, { type });
    if (!result.ok) throw new Error(result.error.message);
    state = result.value.state;
    events.push(...result.value.events);
  }
  if (spec.sessionEnd !== undefined) {
    events.push(
      ...recordSessionEvent(state, {
        type: "SESSION_ENDED",
        sessionId: "s1",
        reason: spec.sessionEnd,
      }).events,
    );
  }
  return events;
}

/** 前の Hand の結果から nextHandSeating で次の Hand の席と Button を決める（Bust の除外・Button の移動・Heads-Up）。 */
export function nextSeating(previous: readonly HandEvent[]) {
  const started = previous[0];
  const finished = previous.find((e) => e.type === "HAND_FINISHED");
  if (started?.type !== "HAND_STARTED" || finished?.type !== "HAND_FINISHED") {
    throw new Error("Hand が終わっていない");
  }
  const seating = nextHandSeating(
    {
      seatOrder: started.seats.map((s) => s.playerId),
      stacks: finished.stacks,
      buttonPlayerId: started.buttonPlayerId,
    },
    TABLE,
  );
  if (!seating.ok || seating.value.kind !== "next_hand") {
    throw new Error("次の Hand が無い");
  }
  return seating.value;
}

export const seat = (playerId: string, stack: number): SeatInit => ({
  playerId,
  stack,
});

// 役の無い Board（Flush・Straight にならない）。Pocket Aces が勝つ。
export const BOARD = "Kd Qs 5h Jc 6s";
