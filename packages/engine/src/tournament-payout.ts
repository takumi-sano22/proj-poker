// Tournament の Payout と Result（D108・D127・D129・docs/02 §7・#186）。
// Payout は pt（参加費の単位）で数える賞金で、Chip（Hand の中で動き、総量が保存される量。D74）とは別の量。Stack・Pot から計算しない。
// Result は Event Log から都度計算する派生 Projection で、保存しない（D129。テーブル・Event を足さない）:
// - 順位は tournamentStandings（#185）から、Prize Pool と Payout の構造は SESSION_STARTED の設定の Snapshot（D129）から読む
// Hero が誰かは知らない（Hero の順位と Payout は、呼び出し側が Hero の playerId で placements から引く）。
import type { HandEvent } from "./hand-events.js";
import {
  tournamentStandings,
  type TournamentPlacement,
  type TournamentStatus,
} from "./tournament-standings.js";
import { sessionSettingsOf, type PayoutStructure } from "./tournament.js";

/**
 * Payout の端数・同順位の配り方の版（OI-007 の暫定 Policy の 1 版目。人間判断を経ていない。docs/02 §7）。
 * Result は都度計算するので、規則を変えるときは版を上げて Result に残し、どの規則で計算した額かを読み手が分かるようにする。
 */
export const PAYOUT_POLICY_VERSION = "phase8_provisional_v1";

/** 1 人の順位と賞金。 */
export interface TournamentResultPlacement extends TournamentPlacement {
  /**
   * 賞金（pt）。入賞しなかった順位は 0。順位が未決（Tournament が続いている・Hero の Bust で終えた時点で残っていた CPU・打ち切りで
   * 残っていた Player）なら null（未確定。D129・OI-007）。
   */
  readonly payout: number | null;
}

export interface TournamentResult {
  readonly status: TournamentStatus;
  /** 参加人数（Session の最初の Hand に座った人数）。 */
  readonly entrants: number;
  /** 最後に終わった Hand の後に Stack が残っている人数（残人数）。 */
  readonly remaining: number;
  /** 参加費（pt。1 人分。設定の Snapshot の値）。 */
  readonly entryFee: number;
  /** Prize Pool（pt）= 参加費 × 参加人数（D127）。 */
  readonly prizePool: number;
  /** 端数・同順位の配り方の版（PAYOUT_POLICY_VERSION）。 */
  readonly payoutPolicyVersion: string;
  /** 順位ごとの賞金（pt。1 位から入賞の数だけ）。同順位の合算・等分の前の額で、合計は Prize Pool。 */
  readonly payoutsByPlace: readonly number[];
  /** 参加者ごとの順位と賞金。並びは Session の最初の Hand の席順（時計回り。tournamentStandings と同じ）。 */
  readonly placements: readonly TournamentResultPlacement[];
}

/** Prize Pool（pt）= 参加費 × 参加人数（D127）。 */
export function prizePoolOf(entryFee: number, entrants: number): number {
  if (!Number.isSafeInteger(entryFee) || entryFee <= 0) {
    throw new RangeError(`参加費は 1 以上の整数: ${entryFee}`);
  }
  if (!Number.isSafeInteger(entrants) || entrants <= 0) {
    throw new RangeError(`参加人数は 1 以上の整数: ${entrants}`);
  }
  const pool = entryFee * entrants;
  if (!Number.isSafeInteger(pool)) {
    throw new RangeError(`Prize Pool が整数で表せない: ${pool}`);
  }
  return pool;
}

/**
 * 順位ごとの賞金（pt。1 位から入賞の数だけ）。合計は必ず Prize Pool と一致する。
 * percentages は Prize Pool に割合を掛けて切り捨て、余りを上位の順位から 1pt ずつ配る（OI-007 の暫定 Policy。docs/02 §7）。
 * 切り捨てで減るのは順位ごとに 1pt 未満なので、余りは入賞の数より少なく、上位から 1 周で配り切れる。
 * Custom Payout は PayoutStructure の kind を足し、ここで分岐する（D108）。
 */
export function payoutsByPlace(
  structure: PayoutStructure,
  prizePool: number,
): number[] {
  if (
    !Number.isSafeInteger(prizePool) ||
    prizePool < 0 ||
    !Number.isSafeInteger(prizePool * 100)
  ) {
    throw new RangeError(`Prize Pool は 0 以上の整数: ${prizePool}`);
  }
  switch (structure.kind) {
    case "percentages": {
      const { percentages } = structure;
      // 設定の検証（validateTournamentConfig）を通った値でも、合計が 100% でなければ Prize Pool を配り切れないので確かめ直す。
      if (
        percentages.length === 0 ||
        !percentages.every((p) => Number.isSafeInteger(p) && p > 0)
      ) {
        throw new RangeError("Payout は 1 以上の整数の % の列");
      }
      const total = percentages.reduce((sum, p) => sum + p, 0);
      if (total !== 100) {
        throw new RangeError(
          `Payout の割合の合計は 100%: ${percentages.join(" / ")}`,
        );
      }
      const base = percentages.map((p) => Math.floor((prizePool * p) / 100));
      const rest = prizePool - base.reduce((sum, a) => sum + a, 0);
      return base.map((amount, i) => amount + (i < rest ? 1 : 0));
    }
  }
}

/**
 * Session の Hand の Event Log（Session の最初の Hand から論理順序で並べたもの。D117）から、Tournament の Result（順位と賞金）を作る。
 * 同じ入力からは同じ結果になる（決定論）。cash の Session・SESSION_STARTED の無い旧版の Session は null（tournamentStandings と同じ）。
 *
 * - 順位が決まった Player の賞金は、その順位の賞金（入賞しなかった順位は 0）
 * - 同順位（同じ Hand で Bust し、開始時の Stack も同じ）の n 人は、その順位から n 個分の順位の賞金を合算して等分する。等分の余りは、
 *   Bust した Hand の席順で Button の左から時計回りに 1pt ずつ配る（OI-007 の暫定 Policy。docs/02 §7）
 * - 順位が未決の Player の賞金は null（未確定）。Hero の Bust で終えたときも、Hero の賞金はその順位で確定する（D129）
 *
 * 入賞の数が参加人数より多い（Prize Pool を配り切れない）・Event Log が Session の Hand として矛盾するなら RangeError を投げる。
 */
export function tournamentResult(
  hands: readonly (readonly HandEvent[])[],
): TournamentResult | null {
  const standings = tournamentStandings(hands);
  const [first] = hands;
  if (standings === null || first === undefined) return null;
  const settings = sessionSettingsOf(first);
  if (settings?.mode !== "tournament") return null;
  const config = settings.tournament;

  const prizePool = prizePoolOf(config.entryFee, standings.entrants);
  const byPlace = payoutsByPlace(config.payout, prizePool);
  if (byPlace.length > standings.entrants) {
    throw new RangeError(
      `入賞の数（${byPlace.length}）が参加人数（${standings.entrants}）より多い`,
    );
  }

  // 決まった順位ごとに、その順位の Player（同順位なら複数人）をまとめる。
  const groups = new Map<number, TournamentPlacement[]>();
  for (const placement of standings.placements) {
    if (placement.place === null) continue;
    groups.set(placement.place, [
      ...(groups.get(placement.place) ?? []),
      placement,
    ]);
  }
  const startedById = new Map(
    hands.map((events) => {
      const started = events[0];
      if (started?.type !== "HAND_STARTED") {
        throw new RangeError("Hand の最初の Event が HAND_STARTED でない");
      }
      return [started.handId, started] as const;
    }),
  );

  const payouts = new Map<string, number>();
  for (const [place, members] of groups) {
    // 同順位の n 人は、place から n 個分の順位の賞金を合算する（入賞しなかった順位は 0）。
    const total = byPlace
      .slice(place - 1, place - 1 + members.length)
      .reduce((sum, a) => sum + a, 0);
    const ordered =
      members.length === 1 ? members : fromButtonLeft(members, startedById);
    const share = Math.floor(total / ordered.length);
    const rest = total - share * ordered.length;
    ordered.forEach((member, i) => {
      payouts.set(member.playerId, share + (i < rest ? 1 : 0));
    });
  }

  return {
    status: standings.status,
    entrants: standings.entrants,
    remaining: standings.remaining,
    entryFee: config.entryFee,
    prizePool,
    payoutPolicyVersion: PAYOUT_POLICY_VERSION,
    payoutsByPlace: byPlace,
    placements: standings.placements.map((placement) => ({
      ...placement,
      payout: payouts.get(placement.playerId) ?? null,
    })),
  };
}

/**
 * 同順位の Player を、Bust した Hand の席順（時計回り）で Button の左から並べる（等分の余りを配る順。D75 の端数と同じ考え方）。
 * 同順位は同じ Hand の Bust だけから生まれるので、全員の eliminatedInHandId は同じ。
 */
function fromButtonLeft(
  members: readonly TournamentPlacement[],
  startedById: ReadonlyMap<
    string,
    Extract<HandEvent, { type: "HAND_STARTED" }>
  >,
): TournamentPlacement[] {
  const handId = members[0]?.eliminatedInHandId ?? null;
  const started = handId === null ? undefined : startedById.get(handId);
  if (
    started === undefined ||
    members.some((m) => m.eliminatedInHandId !== handId)
  ) {
    throw new RangeError("同順位の Player が同じ Hand で Bust していない");
  }
  const seats = started.seats.map((s) => s.playerId);
  const button = seats.indexOf(started.buttonPlayerId);
  const order = [...seats.slice(button + 1), ...seats.slice(0, button + 1)];
  return [...members].sort(
    (a, b) => order.indexOf(a.playerId) - order.indexOf(b.playerId),
  );
}
