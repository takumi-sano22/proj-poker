// 保存済みの Hand の Session の mode と Tournament の情報（D129・#189）。Review（ICM の Evidence）と Drill（Tournament の Hand を
// 題材にしない暫定 Policy）が、Hand の Event Log から読むために使う。読むのは Session の最初の保存済みの Hand の SESSION_STARTED
// （設定の Snapshot）と HAND_STARTED（参加人数）だけ（Hand Orchestrator の tournamentSessionOf と同じ決め方）。
import {
  sessionSettingsOf,
  type SessionSettings,
  type TournamentSessionInfo,
} from "@proj-poker/engine";
import type { EventStore } from "./event-store.js";

type SessionReader = Pick<EventStore, "sessionHandIds" | "read">;

/**
 * Hand の Session の設定。Session の最初の保存済みの Hand の SESSION_STARTED から読む。Tournament の設定の無い Session（mode を
 * 指定しない Session・旧版の行・SESSION_STARTED の無い Hand）は cash。Snapshot が壊れていれば例外（sessionSettingsOf）。
 */
export function sessionSettingsOfHand(
  store: SessionReader,
  handId: string,
): SessionSettings {
  const first = store.sessionHandIds(handId)[0] ?? handId;
  return (
    sessionSettingsOf(store.read(first).map((s) => s.event)) ?? {
      mode: "cash",
    }
  );
}

/**
 * Tournament の Hand の Session の情報（設定の Snapshot・参加人数）。cash の Hand は null。
 * 参加人数は Session の最初の Hand に座った人数（Prize Pool = 参加費 × 参加人数。tournamentResult と同じ）。
 */
export function tournamentSessionInfoOfHand(
  store: SessionReader,
  handId: string,
): TournamentSessionInfo | null {
  const settings = sessionSettingsOfHand(store, handId);
  if (settings.mode !== "tournament") return null;
  const first = store.sessionHandIds(handId)[0] ?? handId;
  const started = store.read(first)[0]?.event;
  if (started?.type !== "HAND_STARTED") {
    throw new Error(`Session の最初の Hand に HAND_STARTED が無い: ${first}`);
  }
  return { config: settings.tournament, entrants: started.seats.length };
}
