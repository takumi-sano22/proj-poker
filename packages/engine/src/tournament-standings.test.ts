// Tournament の Elimination と順位（D108・D129・docs/02 §7・#185）。
// Hand は Engine で実際に進め（積んだ Deck と All-in）、次の Hand の席と Button は nextHandSeating で決める（Hand Engine を複製しない）。
// 期待値は手計算。
import { describe, expect, it } from "vitest";
import { applyAction, recordSessionEvent, startHand } from "./hand-engine.js";
import type { HandEvent, SeatInit, SessionEndReason } from "./hand-events.js";
import { getLegalActions } from "./legal-actions.js";
import { nextHandSeating } from "./position.js";
import { PHASE1_CASH_PRESET, type TableConfig } from "./table-config.js";
import { stackedDeck } from "./testing/stacked-deck.js";
import { tournamentStandings } from "./tournament-standings.js";
import { TOURNAMENT_PRESETS, tableConfigForLevel } from "./tournament.js";

const STANDARD = TOURNAMENT_PRESETS.stt6_hand_count;
const TABLE: TableConfig = tableConfigForLevel(
  PHASE1_CASH_PRESET,
  { smallBlind: 10, bigBlind: 20, ante: 0 },
  "none",
);

interface HandSpec {
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
function playAllIn(spec: HandSpec): HandEvent[] {
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
function nextSeating(previous: readonly HandEvent[]) {
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

const seat = (playerId: string, stack: number): SeatInit => ({
  playerId,
  stack,
});

// 役の無い Board（Flush・Straight にならない）。Pocket Aces が勝つ。
const BOARD = "Kd Qs 5h Jc 6s";

describe("tournamentStandings（#185）", () => {
  it("同じ Hand で複数人が Bust したら開始時の Stack の多い方が上位、同じなら同順位。残りが 1 人ならその 1 人が 1 位（Hero 優勝）", () => {
    // 4 人が All-in。hero（Aces）が全員を Bust させる。Bust の後に残るのは hero だけ。
    // 順位: cpu3（開始 1,000）が 2 位、cpu1・cpu2（開始 500 で同じ）は同順位の 3 位（4 位は空く）。
    const hand = playAllIn({
      handId: "h1",
      seats: [
        seat("hero", 3_000),
        seat("cpu1", 500),
        seat("cpu2", 500),
        seat("cpu3", 1_000),
      ],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "7c 2d", cpu2: "8c 3d", cpu3: "9c 4d" },
      board: BOARD,
      sessionStart: "tournament",
      sessionEnd: "hero_last_standing",
    });
    const standings = tournamentStandings([hand]);
    expect(standings).toEqual({
      status: "finished",
      entrants: 4,
      remaining: 1,
      placements: [
        { playerId: "hero", place: 1, eliminatedInHandId: null },
        { playerId: "cpu1", place: 3, eliminatedInHandId: "h1" },
        { playerId: "cpu2", place: 3, eliminatedInHandId: "h1" },
        { playerId: "cpu3", place: 2, eliminatedInHandId: "h1" },
      ],
    });
  });

  it("Bust の席を除いて Heads-Up へ移り（Button = SB）、Hero が Heads-Up で Bust したら Hero は 2 位・残った CPU が 1 位", () => {
    // Hand 1: 3 人が All-in。hero（Aces）が Main Pot（400 × 3）と Side Pot（200 × 2）を取り 1,600、cpu1 は 2,400、cpu2 が Bust（3 位）。
    const hand1 = playAllIn({
      handId: "h1",
      seats: [seat("hero", 600), seat("cpu1", 3_000), seat("cpu2", 400)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "Tc Th", cpu2: "7c 2d" },
      board: BOARD,
      sessionStart: "tournament",
    });
    const afterHand1 = tournamentStandings([hand1]);
    expect(afterHand1).toEqual({
      status: "in_progress",
      entrants: 3,
      remaining: 2,
      placements: [
        { playerId: "hero", place: null, eliminatedInHandId: null },
        { playerId: "cpu1", place: null, eliminatedInHandId: null },
        { playerId: "cpu2", place: 3, eliminatedInHandId: "h1" },
      ],
    });

    // Hand 2: Bust した cpu2 を除いた Heads-Up。Button は前の Button（hero）の次の席の cpu1 で、Heads-Up の Button は SB。
    const next = nextSeating(hand1);
    expect(next).toEqual({
      kind: "next_hand",
      seats: [seat("hero", 1_600), seat("cpu1", 2_400)],
      buttonPlayerId: "cpu1",
    });
    const hand2 = playAllIn({
      handId: "h2",
      seats: next.seats,
      buttonPlayerId: next.buttonPlayerId,
      holes: { hero: "7c 2d", cpu1: "As Ah" },
      board: BOARD,
      sessionEnd: "hero_busted",
    });
    expect(
      hand2.find((e) => e.type === "BLIND_POSTED" && e.blind === "small"),
    ).toMatchObject({ playerId: "cpu1" });

    const standings = tournamentStandings([hand1, hand2]);
    expect(standings).toEqual({
      status: "finished",
      entrants: 3,
      remaining: 1,
      placements: [
        { playerId: "hero", place: 2, eliminatedInHandId: "h2" },
        { playerId: "cpu1", place: 1, eliminatedInHandId: null },
        { playerId: "cpu2", place: 3, eliminatedInHandId: "h1" },
      ],
    });
    // 同じ Event Log からは同じ順位（決定論）。
    expect(tournamentStandings([hand1, hand2])).toEqual(standings);
  });

  it("Hero が Bust して CPU が 2 人以上残ったら、Hero の順位だけを確定し、残った CPU の順位は未決（D129）", () => {
    // hero（500）だけが Bust し、cpu1（Aces・3,000）が Main Pot を取る。cpu2・cpu3（3,500。同じ役）は Side Pot（500 × 2）を分けて 500 ずつ残る。
    const hand = playAllIn({
      handId: "h1",
      seats: [
        seat("hero", 500),
        seat("cpu1", 3_000),
        seat("cpu2", 3_500),
        seat("cpu3", 3_500),
      ],
      buttonPlayerId: "hero",
      holes: { hero: "7c 2d", cpu1: "As Ah", cpu2: "8c 3d", cpu3: "8d 3c" },
      board: BOARD,
      sessionStart: "tournament",
      sessionEnd: "hero_busted",
    });
    expect(tournamentStandings([hand])).toEqual({
      status: "finished",
      entrants: 4,
      remaining: 3,
      placements: [
        { playerId: "hero", place: 4, eliminatedInHandId: "h1" },
        { playerId: "cpu1", place: null, eliminatedInHandId: null },
        { playerId: "cpu2", place: null, eliminatedInHandId: null },
        { playerId: "cpu3", place: null, eliminatedInHandId: null },
      ],
    });
  });

  it("CPU の障害で打ち切った Tournament は abandoned。打ち切った Hand では誰も Bust せず、残った Player の順位は決めない", () => {
    const hand1 = playAllIn({
      handId: "h1",
      seats: [seat("hero", 600), seat("cpu1", 3_000), seat("cpu2", 400)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "Tc Th", cpu2: "7c 2d" },
      board: BOARD,
      sessionStart: "tournament",
    });
    const next = nextSeating(hand1);
    const started = startHand({
      handId: "h2",
      seats: next.seats,
      buttonPlayerId: next.buttonPlayerId,
      config: TABLE,
      deal: { seed: 1 },
    });
    if (!started.ok) throw new Error(started.error.message);
    const aborted = recordSessionEvent(started.value.state, {
      type: "HAND_ABORTED",
      reason: "ai_outage",
    });
    const ended = recordSessionEvent(aborted.state, {
      type: "SESSION_ENDED",
      sessionId: "s1",
      reason: "ai_outage",
    });
    const hand2 = [...started.value.events, ...aborted.events, ...ended.events];
    expect(tournamentStandings([hand1, hand2])).toEqual({
      status: "abandoned",
      entrants: 3,
      remaining: 2,
      placements: [
        { playerId: "hero", place: null, eliminatedInHandId: null },
        { playerId: "cpu1", place: null, eliminatedInHandId: null },
        { playerId: "cpu2", place: 3, eliminatedInHandId: "h1" },
      ],
    });
  });

  it("Session の Hand として矛盾する Event Log からは順位を作らない（RangeError）", () => {
    const hand1 = playAllIn({
      handId: "h1",
      seats: [seat("hero", 600), seat("cpu1", 3_000), seat("cpu2", 400)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "Tc Th", cpu2: "7c 2d" },
      board: BOARD,
      sessionStart: "tournament",
    });
    // Bust した cpu2 がまた座っている。
    expect(() => tournamentStandings([hand1, hand1])).toThrow(RangeError);
    // Session が終わった後に Hand がある。
    const ended = playAllIn({
      handId: "h1",
      seats: [seat("hero", 3_000), seat("cpu1", 500)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "7c 2d" },
      board: BOARD,
      sessionStart: "tournament",
      sessionEnd: "hero_last_standing",
    });
    expect(() => tournamentStandings([ended, hand1])).toThrow(RangeError);
  });

  it("cash の Session と、SESSION_STARTED の無い旧版の Session は null", () => {
    const cash = playAllIn({
      handId: "h1",
      seats: [seat("hero", 1_000), seat("cpu1", 1_000)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "7c 2d" },
      board: BOARD,
      sessionStart: "cash",
    });
    expect(tournamentStandings([cash])).toBeNull();
    const old = playAllIn({
      handId: "h1",
      seats: [seat("hero", 1_000), seat("cpu1", 1_000)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "7c 2d" },
      board: BOARD,
    });
    expect(tournamentStandings([old])).toBeNull();
    expect(tournamentStandings([])).toBeNull();
  });
});
