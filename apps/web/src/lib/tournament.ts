// Tournament の表示（#190・docs/06 §15・D49・D108・D127〜D130）。値はサーバーが Event Log から計算した状況（TournamentTableStatus）と
// HeroView の公開の Event をそのまま読み、文言に直すだけ（順位・Payout・Level を画面で計算し直さない）。
// 表示の規則（Level の残りの書き方・順位の並べ方・未決の書き方）は人間判断を経ていない暫定の表示で、変えてよい（PR の Review Required）。
import {
  TOURNAMENT_PRESET_IDS,
  TOURNAMENT_PRESETS,
  type AnteKind,
  type HeroView,
  type TournamentPresetId,
  type TournamentResult,
  type TournamentResultPlacement,
} from "@proj-poker/engine";
import type { SessionRequest, TournamentTableStatus } from "./api.js";
import { formatChips } from "./format.js";

/** 新しい Session の選択肢 1 つ（select の値・表示・送る設定）。 */
export interface SessionChoiceOption {
  readonly value: "cash" | TournamentPresetId;
  readonly label: string;
  readonly request: SessionRequest;
}

/** Level が上がる間隔（例: "10 Hand ごと" / "プレイ時間 10 分ごと"）。値は Preset の設定から作る（D127・D128）。 */
function levelInterval(presetId: TournamentPresetId, short: boolean): string {
  const { schedule } = TOURNAMENT_PRESETS[presetId];
  if (schedule.kind === "hand_count")
    return `${schedule.handsPerLevel} Hand ごと`;
  const minutes = Math.round(schedule.levelDurationMs / 60_000);
  return short ? `${minutes} 分ごと` : `プレイ時間 ${minutes} 分ごと`;
}

/** Tournament の Preset の説明（例: "6-max STT・10 Hand ごとに Level"）。 */
export function presetSummary(presetId: TournamentPresetId): string {
  const { tableSize } = TOURNAMENT_PRESETS[presetId];
  return `${tableSize}-max STT・${levelInterval(presetId, false)}に Level`;
}

/**
 * 新しい Session の選択肢（Cash と Tournament の標準 Preset。D128）。Cash を先頭（既定）に置く。
 * 表記は Hero の欄にも置けるよう短くする（例: "Tournament（10 Hand ごと）"。参加人数などは Tournament の欄の presetSummary）。
 */
export const SESSION_CHOICES: readonly SessionChoiceOption[] = [
  { value: "cash", label: "Cash Game", request: { mode: "cash" } },
  ...TOURNAMENT_PRESET_IDS.map((presetId): SessionChoiceOption => ({
    value: presetId,
    label: `Tournament（${levelInterval(presetId, true)}）`,
    request: { mode: "tournament", presetId },
  })),
];

/** 設定から選択肢の値を引く。 */
export function sessionChoiceValue(
  request: SessionRequest,
): SessionChoiceOption["value"] {
  return request.mode === "cash" ? "cash" : request.presetId;
}

/** 選択肢の値から設定を引く。知らない値は Cash（既定）にする。 */
export function sessionChoiceOf(value: string): SessionRequest {
  return (
    SESSION_CHOICES.find((c) => c.value === value)?.request ?? {
      mode: "cash",
    }
  );
}

/** Ante の名前（big_blind_ante は BB の席がまとめて払う Ante。D128）。Ante の無い設定は null。 */
export function anteName(kind: AnteKind): string | null {
  switch (kind) {
    case "none":
      return null;
    case "per_player":
      return "Ante";
    case "big_blind_ante":
      return "BB Ante";
  }
}

/** Ante の 1 行（例: "BB Ante 20"）。Ante の無い Level は null。 */
export function anteText(kind: AnteKind, amount: number): string | null {
  const name = anteName(kind);
  return name === null || amount <= 0 ? null : `${name} ${formatChips(amount)}`;
}

/**
 * HeroView の公開の HAND_STARTED から、この Hand の Tournament の Level と Ante を読む（見出しの 1 行に使う）。
 * Cash の Hand（tournament を持たない）は null。
 */
export function handLevelOf(
  view: HeroView,
): { readonly level: number; readonly ante: string | null } | null {
  const started = view.log.find((e) => e.type === "HAND_STARTED");
  if (started?.type !== "HAND_STARTED" || started.tournament === undefined) {
    return null;
  }
  return {
    level: started.tournament.level,
    ante:
      started.ante === undefined
        ? null
        : anteText(started.ante.kind, started.ante.amount),
  };
}

/** 次の Level までの残り（例: "11 Hand 目から（今 3 Hand 目）" / "プレイ時間であと約 7 分"）。最後の Level なら null。 */
export function untilNextLevelText(
  status: TournamentTableStatus,
): string | null {
  const next = status.nextLevel;
  if (next === null) return null;
  if (next.until.kind === "hand_count") {
    return `${next.until.handNumber} Hand 目から（今 ${status.handNumber} Hand 目）`;
  }
  const ms = next.until.remainingPlayMs;
  // Level は Hand の開始時に決まる（Hand の途中では上がらない。D128）ので、時間が過ぎていれば次の Hand から上がる。
  if (ms <= 0) return "次の Hand から";
  return `プレイ時間であと約 ${Math.max(1, Math.ceil(ms / 60_000))} 分`;
}

const equityFormat = new Intl.NumberFormat("ja-JP", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** ICM Equity（pt。Evidence で小数第 1 位に丸め済み）の表記（例: "98.2pt"）。賞金の額（整数の pt）は payoutText。 */
export function equityText(value: number): string {
  return `${equityFormat.format(value)}pt`;
}

/** 順位の表記。未決（Tournament が続いている・Hero の Bust で終えたときに残っていた CPU・打ち切り）は「未決」（D129）。 */
export function placeText(place: number | null): string {
  return place === null ? "未決" : `${place} 位`;
}

/** Payout（pt。Chip とは別の量）の表記。順位が未決なら「未確定」。 */
export function payoutText(payout: number | null): string {
  return payout === null ? "未確定" : `${formatChips(payout)}pt`;
}

/**
 * 順位の一覧の並び。順位の決まっていない Player（残っている・未決）を先に席順のまま、続けて決まった順位の上から並べる
 * （未決の Player は、決まった誰よりも長く残っている）。
 */
export function orderedPlacements(
  result: TournamentResult,
): readonly TournamentResultPlacement[] {
  const undecided = result.placements.filter((p) => p.place === null);
  const decided = result.placements
    .filter((p) => p.place !== null)
    .sort((a, b) => (a.place ?? 0) - (b.place ?? 0));
  return [...undecided, ...decided];
}

/**
 * Tournament が終わったときの案内（Session の終わりの案内の代わり）。Hero の順位と Payout を 1 文で出す（D129）。
 * 続いている Tournament は null。打ち切った Tournament（ai_outage）は、残っていた Player の順位が決まらないことを伝える。
 */
export function tournamentEndMessage(
  result: TournamentResult,
  heroId: string,
): string | null {
  if (result.status === "in_progress") return null;
  if (result.status === "abandoned") {
    return "AI の判断を受け取れなかったため、Tournament を打ち切りました。残っていた Player（Hero を含む）の順位と Payout は決まっていません。";
  }
  const hero = result.placements.find((p) => p.playerId === heroId);
  if (hero?.place == null) return null;
  if (hero.place === 1) {
    return `Hero が優勝しました（1 位・Payout ${payoutText(hero.payout)}）。Tournament は終了です。`;
  }
  return `Hero は ${hero.place} 位で Tournament を終えました（Payout ${payoutText(hero.payout)}）。`;
}
