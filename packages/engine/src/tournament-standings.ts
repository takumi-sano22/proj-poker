// Tournament の Elimination と順位（D108・D129・docs/02 §7・#185）。
// 順位は Event Log から都度計算する派生 Projection で、保存しない（D129。テーブルを足さない）。新しい Event も足さない:
// - Elimination（Bust = Elimination。D108）は、Tournament の Session の Hand の HAND_FINISHED の stacks で Stack が 0 になったこと
//   （Bust した席は次の Hand に座らない。nextHandSeating・D80）
// - Tournament の終了は SESSION_ENDED（hero_busted / hero_last_standing。D129）。ai_outage は Tournament を終えずに打ち切ったもの
// どちらも既存の Event にそのまま残っているので、同じ事実の二つ目の表現を Event に足さない（版 9・10 で保存した Tournament も同じ経路で読める）。
// Hero が誰かは知らない（Hero の順位は、呼び出し側が Hero の playerId で placements から引く）。
import type { HandEvent } from "./hand-events.js";
import { sessionSettingsOf } from "./tournament.js";

/**
 * Tournament の進み具合。
 * - in_progress: まだ終わっていない（Session が続いている）
 * - finished: 終わった（Hero の Bust か、Hero が最後の 1 人。SESSION_ENDED の hero_busted / hero_last_standing。D129）
 * - abandoned: 終える前に打ち切った（CPU の障害で Hero が Session の終了を選んだ。SESSION_ENDED の ai_outage）。
 *   打ち切った Hand は Chip を動かさないので、その Hand では誰も Bust しない。残っていた Player（Hero を含む）の順位は決めない
 *   （OI-007 の暫定 Policy。docs/02 §7）
 */
export type TournamentStatus = "in_progress" | "finished" | "abandoned";

/** 1 人の順位。 */
export interface TournamentPlacement {
  readonly playerId: string;
  /**
   * 順位（1 始まり）。同じ Hand で Bust し開始時の Stack も同じなら同じ値（同順位。賞金の合算と等分は #186）。
   * Hero が最後の 1 人（hero_last_standing）なら Hero が 1 位。まだ決まっていない（Tournament が続いている・Hero の Bust で終えた時点で
   * 残っていた CPU〔残りが 1 人でも〕。D129）なら null。
   */
  readonly place: number | null;
  /** Bust した Hand の ID。Bust していなければ null。 */
  readonly eliminatedInHandId: string | null;
}

export interface TournamentStandings {
  readonly status: TournamentStatus;
  /** 参加人数（Session の最初の Hand に座った人数）。 */
  readonly entrants: number;
  /** 最後に終わった Hand の後に Stack が残っている人数（残人数）。 */
  readonly remaining: number;
  /** 参加者ごとの順位。並びは Session の最初の Hand の席順（時計回り）。 */
  readonly placements: readonly TournamentPlacement[];
}

/**
 * Session の Hand の Event Log（Session の最初の Hand から論理順序で並べたもの。D117）から、Tournament の Elimination と順位を作る。
 * 同じ入力からは同じ結果になる（決定論）。cash の Session（Tournament の設定の無い SESSION_STARTED・SESSION_STARTED の無い旧版の
 * Session）は null。
 *
 * - Hand ごとに、開始時に座っていて HAND_FINISHED の Stack が 0 になった Player をその Hand の Bust とする。
 *   HAND_FINISHED の無い Hand（打ち切った Hand・進行中の Hand）では誰も Bust しない（Chip が動いていない）
 * - Bust した Player の順位は「その Hand の後に残った人数 + 1」から。同じ Hand で複数人が Bust したら、Hand の開始時の Stack
 *   （HAND_STARTED の seats の stack）の多い方を上位にし、同じなら同順位にする（OI-007 の暫定 Policy。docs/02 §7）
 * - Hero が最後の 1 人（SESSION_ENDED の hero_last_standing）なら、その 1 人を 1 位にする（優勝）。Hero の Bust（hero_busted）で終えた
 *   ときに残っていた CPU の順位は、残りが 1 人（Heads-Up で Hero が Bust）でも未決のままにする（D129。CPU だけで続けない）
 *
 * Event Log が Session の Hand として矛盾する（Bust した Player がまた座る・途中の Hand に SESSION_ENDED がある・残りが 0 人になる等）
 * なら、誤った順位を作らずに RangeError を投げる。
 */
export function tournamentStandings(
  hands: readonly (readonly HandEvent[])[],
): TournamentStandings | null {
  const [first] = hands;
  if (first === undefined) return null;
  const settings = sessionSettingsOf(first);
  if (settings?.mode !== "tournament") return null;

  const entrants = startedOf(first).seats.map((s) => s.playerId);
  const placements = new Map<string, TournamentPlacement>(
    entrants.map((playerId) => [
      playerId,
      { playerId, place: null, eliminatedInHandId: null },
    ]),
  );
  const alive = new Set(entrants);
  let ended: Extract<HandEvent, { type: "SESSION_ENDED" }> | null = null;

  for (const events of hands) {
    const started = startedOf(events);
    if (ended !== null) {
      throw new RangeError(
        `Session が終わった後の Hand がある: ${started.handId}`,
      );
    }
    // Bust した Player は次の Hand に座らない（nextHandSeating）。座っているのは残っている参加者だけ。
    const seated = started.seats.map((s) => s.playerId);
    if (seated.some((id) => !alive.has(id))) {
      throw new RangeError(
        `残っていない Player が座った Hand がある: ${started.handId}`,
      );
    }
    if (seated.length !== alive.size) {
      throw new RangeError(
        `残っている Player が座っていない Hand がある: ${started.handId}`,
      );
    }
    const finished = events.find((e) => e.type === "HAND_FINISHED");
    if (finished?.type === "HAND_FINISHED") {
      eliminate(started, finished.stacks, alive, placements);
    }
    const sessionEnded = events.find((e) => e.type === "SESSION_ENDED");
    if (sessionEnded?.type === "SESSION_ENDED") ended = sessionEnded;
  }

  // Hero が最後の 1 人で終えたときだけ、その 1 人を 1 位にする。Hero の Bust で終えたときの残りの CPU は未決（D129）。
  const [last] = alive;
  if (
    ended?.reason === "hero_last_standing" &&
    alive.size === 1 &&
    last !== undefined
  ) {
    placements.set(last, {
      playerId: last,
      place: 1,
      eliminatedInHandId: null,
    });
  }

  return {
    status:
      ended === null
        ? "in_progress"
        : ended.reason === "ai_outage"
          ? "abandoned"
          : "finished",
    entrants: entrants.length,
    remaining: alive.size,
    placements: entrants.map((id) => placements.get(id) as TournamentPlacement),
  };
}

/** 終わった Hand の Bust を alive から抜き、順位を付ける。 */
function eliminate(
  started: Extract<HandEvent, { type: "HAND_STARTED" }>,
  stacks: readonly { readonly playerId: string; readonly amount: number }[],
  alive: Set<string>,
  placements: Map<string, TournamentPlacement>,
): void {
  const stackAfter = new Map(stacks.map((s) => [s.playerId, s.amount]));
  const busted = started.seats.filter((s) => {
    const amount = stackAfter.get(s.playerId);
    if (amount === undefined) {
      throw new RangeError(
        `HAND_FINISHED に座った Player の Stack が無い: ${s.playerId}`,
      );
    }
    return amount === 0;
  });
  if (busted.length === 0) return;
  const remainingAfter = alive.size - busted.length;
  if (remainingAfter < 1) {
    throw new RangeError(`全員が Bust した Hand がある: ${started.handId}`);
  }
  for (const player of busted) {
    // 同じ Hand の Bust は、開始時の Stack が自分より多い人数だけ下がる（同じなら同順位）。
    const above = busted.filter((b) => b.stack > player.stack).length;
    placements.set(player.playerId, {
      playerId: player.playerId,
      place: remainingAfter + 1 + above,
      eliminatedInHandId: started.handId,
    });
  }
  for (const player of busted) alive.delete(player.playerId);
}

function startedOf(
  events: readonly HandEvent[],
): Extract<HandEvent, { type: "HAND_STARTED" }> {
  const started = events[0];
  if (started?.type !== "HAND_STARTED") {
    throw new RangeError("Hand の最初の Event が HAND_STARTED でない");
  }
  return started;
}
