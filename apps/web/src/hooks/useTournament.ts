// 卓の Tournament の状況（#190）。表示中の Hand ごとにサーバーの GET /api/hands/:handId/tournament を読み、卓の状態が進むたび
// （View の seq・Hand の終了）に読み直す（Bust・順位は Hand の終わりで決まる）。time-base の進行中の Hand は、Hero の考え中・AI の
// 応答待ちの間も残り時間が減るので、一定の間隔（TOURNAMENT_REFRESH_MS）でも読み直す。
// 古い応答は usePolled が要求の番号で捨てる（LC-041）。返すのは表示中の Hand の値だけ（Hand が変わったら、新しい Hand を読み終えるまで
// null。前の Hand の Level・残人数・結果を今の卓に出さない。読み込みに失敗しても別の Hand の値は出さない）。
import type { HeroView } from "@proj-poker/engine";
import { useEffect } from "react";
import { tournamentPath, type TournamentTableStatus } from "../lib/api.js";
import { TOURNAMENT_REFRESH_MS } from "../lib/config.js";
import { lastSeqOf } from "../lib/view-model.js";
import { usePolled } from "./usePolled.js";

export function useTournament(
  handId: string | null,
  view: HeroView | null,
): TournamentTableStatus | null {
  const { data, refresh } = usePolled<{
    readonly tournament: TournamentTableStatus | null;
  }>(handId === null ? null : tournamentPath(handId));
  // 表示中の Hand の View が進んだら読み直す（初回は usePolled が path の変化で読む）。
  const progress =
    view === null || view.handId !== handId
      ? null
      : `${view.status}:${lastSeqOf(view)}`;
  useEffect(() => {
    if (progress !== null) refresh();
  }, [progress, refresh]);

  // usePolled は path（Hand）が変わると前の値を見せないので、data は表示中の Hand の値か null。念のため handId も照合する。
  const current =
    data?.tournament != null && data.tournament.handId === handId
      ? data.tournament
      : null;

  // time-base の進行中の Hand は、卓の状態が進まなくても残り時間を読み直す（サーバーが要求の時点のプレイ時間で測る）。
  const ticking =
    current !== null &&
    current.handId === handId &&
    current.schedule.kind === "time_base" &&
    current.nextLevel !== null &&
    view?.handId === handId &&
    view.status === "in_progress";
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(refresh, TOURNAMENT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [ticking, refresh]);

  return current;
}
