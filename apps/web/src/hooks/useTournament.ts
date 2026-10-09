// 卓の Tournament の状況（#190）。表示中の Hand ごとにサーバーの GET /api/hands/:handId/tournament を読み、卓の状態が進むたび
// （View の seq・Hand の終了）に読み直す（Bust・順位は Hand の終わりで決まり、time-base の残りはプレイ時間で減るため）。
// 古い応答は usePolled が要求の番号で捨てる（LC-041）。次の Hand の応答が届くまでは前の Hand の値を出したままにし、欄が一瞬消えて
// 進行ログの位置が跳ねないようにする（Level・Blind の見出しは HeroView から作るので、ここが遅れても古くならない）。
import type { HeroView } from "@proj-poker/engine";
import { useEffect, useState } from "react";
import { tournamentPath, type TournamentTableStatus } from "../lib/api.js";
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

  // 読めた値だけを残す（次の Hand を読み終えるまで前の値を出す）。Hand が無くなったら消す。
  // 読めた値は描画の中で写す（effect で setState しない。React の「前の props から state を作る」書き方）。
  const [shown, setShown] = useState<TournamentTableStatus | null>(null);
  if (data !== null && data.tournament !== shown) setShown(data.tournament);
  return handId === null ? null : shown;
}
