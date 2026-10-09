// Tournament の Payout と Result（D108・D127・D129・docs/02 §7・#186）。
// Hand は Engine で実際に進め（積んだ Deck と All-in）、Result は Event Log から計算する。期待値は手計算。
// 標準 Preset（参加費 100pt・50 / 30 / 20）の Snapshot を SESSION_STARTED に置く。
import { describe, expect, it } from "vitest";
import { recordSessionEvent, startHand } from "./hand-engine.js";
import {
  BOARD,
  TABLE,
  nextSeating,
  playAllIn,
  seat,
} from "./testing/tournament-hands.js";
import {
  PAYOUT_POLICY_VERSION,
  payoutsByPlace,
  prizePoolOf,
  tournamentResult,
  type TournamentResult,
} from "./tournament-payout.js";
import { TOURNAMENT_PRESETS } from "./tournament.js";

const STANDARD = TOURNAMENT_PRESETS.stt6_hand_count;

/** 順位が決まった Player の賞金の合計（pt）。 */
function decidedTotal(result: TournamentResult): number {
  return result.placements.reduce((sum, p) => sum + (p.payout ?? 0), 0);
}

describe("prizePoolOf / payoutsByPlace（#186）", () => {
  it("標準 6-max STT は 100pt × 6 = 600pt を 50 / 30 / 20 で 300 / 180 / 120（D127）", () => {
    const pool = prizePoolOf(STANDARD.entryFee, STANDARD.tableSize);
    expect(pool).toBe(600);
    expect(payoutsByPlace(STANDARD.payout, pool)).toEqual([300, 180, 120]);
  });

  it("端数は切り捨て、余りを上位の順位から 1pt ずつ配る（OI-007 の暫定 Policy）", () => {
    const structure = STANDARD.payout;
    // 101 × 50 / 30 / 20% = 50.5 / 30.3 / 20.2 → 50 / 30 / 20（余り 1 は 1 位へ）。
    expect(payoutsByPlace(structure, 101)).toEqual([51, 30, 20]);
    // 7 × 50 / 30 / 20% = 3.5 / 2.1 / 1.4 → 3 / 2 / 1（余り 1 は 1 位へ）。
    expect(payoutsByPlace(structure, 7)).toEqual([4, 2, 1]);
    // 2 × 34 / 33 / 33% = 0.68 / 0.66 / 0.66 → 0 / 0 / 0（余り 2 は 1 位と 2 位へ）。
    expect(
      payoutsByPlace({ kind: "percentages", percentages: [34, 33, 33] }, 2),
    ).toEqual([1, 1, 0]);
    expect(payoutsByPlace(structure, 0)).toEqual([0, 0, 0]);
    // 安全な整数の Prize Pool なら、× 割合が安全な整数を超える額でも配れる（合計は Prize Pool）。
    const large = 100_000_000_000_001;
    const amounts = payoutsByPlace(structure, large);
    expect(amounts).toEqual([
      50_000_000_000_001, 30_000_000_000_000, 20_000_000_000_000,
    ]);
    expect(amounts.reduce((sum, a) => sum + a, 0)).toBe(large);
  });

  it("Custom の割合でも合計は Prize Pool（後から足す Payout の構造と同じ経路）", () => {
    expect(
      payoutsByPlace({ kind: "percentages", percentages: [65, 35] }, 600),
    ).toEqual([390, 210]);
    expect(
      payoutsByPlace({ kind: "percentages", percentages: [100] }, 600),
    ).toEqual([600]);
  });

  it("割合の合計が 100% でない・1 以上の整数でない・Prize Pool や参加費が整数でないなら投げる", () => {
    expect(() =>
      payoutsByPlace({ kind: "percentages", percentages: [50, 30] }, 600),
    ).toThrow(RangeError);
    expect(() =>
      payoutsByPlace({ kind: "percentages", percentages: [60, 30, 20] }, 600),
    ).toThrow(RangeError);
    expect(() =>
      payoutsByPlace({ kind: "percentages", percentages: [50.5, 49.5] }, 600),
    ).toThrow(RangeError);
    expect(() =>
      payoutsByPlace({ kind: "percentages", percentages: [] }, 600),
    ).toThrow(RangeError);
    expect(() => payoutsByPlace(STANDARD.payout, 1.5)).toThrow(RangeError);
    expect(() => payoutsByPlace(STANDARD.payout, -1)).toThrow(RangeError);
    expect(() => prizePoolOf(0, 6)).toThrow(RangeError);
    expect(() => prizePoolOf(100, 0)).toThrow(RangeError);
  });
});

describe("tournamentResult（#186）", () => {
  it("6 人の標準 STT で Hero が最後の 1 人なら 300 / 180 / 120 を配り、入賞しなかった順位は 0。合計は Prize Pool", () => {
    // 6 人が All-in。hero（Aces）が全員を Bust させる。開始時の Stack の多い順に 2〜6 位。
    const hand = playAllIn({
      handId: "h1",
      seats: [
        seat("hero", 5_000),
        seat("cpu1", 100),
        seat("cpu2", 200),
        seat("cpu3", 300),
        seat("cpu4", 400),
        seat("cpu5", 500),
      ],
      buttonPlayerId: "hero",
      holes: {
        hero: "As Ah",
        cpu1: "7c 2d",
        cpu2: "8c 3d",
        cpu3: "9c 4d",
        cpu4: "7d 2c",
        cpu5: "8d 3c",
      },
      board: BOARD,
      sessionStart: "tournament",
      sessionEnd: "hero_last_standing",
    });
    const result = tournamentResult([hand]);
    expect(result).toEqual({
      status: "finished",
      entrants: 6,
      remaining: 1,
      entryFee: 100,
      prizePool: 600,
      payoutPolicyVersion: PAYOUT_POLICY_VERSION,
      payoutsByPlace: [300, 180, 120],
      placements: [
        { playerId: "hero", place: 1, eliminatedInHandId: null, payout: 300 },
        { playerId: "cpu1", place: 6, eliminatedInHandId: "h1", payout: 0 },
        { playerId: "cpu2", place: 5, eliminatedInHandId: "h1", payout: 0 },
        { playerId: "cpu3", place: 4, eliminatedInHandId: "h1", payout: 0 },
        { playerId: "cpu4", place: 3, eliminatedInHandId: "h1", payout: 120 },
        { playerId: "cpu5", place: 2, eliminatedInHandId: "h1", payout: 180 },
      ],
    });
    expect(decidedTotal(result as TournamentResult)).toBe(600);
    // 同じ Event Log からは同じ Result（決定論）。
    expect(tournamentResult([hand])).toEqual(result);
  });

  it("同順位は順位の賞金を合算して等分し、余りは Bust した Hand の Button の左から時計回りに 1pt ずつ配る", () => {
    // 4 人（Prize Pool 400 → 200 / 120 / 80）。Button は cpu1。cpu1〜cpu3（開始 500 で同じ）が同じ Hand で Bust して同順位の 2 位。
    // 2〜4 位の賞金 120 + 80 + 0 = 200 を 3 人で等分して 66 と余り 2。Button（cpu1）の左から cpu2・cpu3 が 1pt 多く、cpu1 は 66。
    const hand = playAllIn({
      handId: "h1",
      seats: [
        seat("hero", 3_000),
        seat("cpu1", 500),
        seat("cpu2", 500),
        seat("cpu3", 500),
      ],
      buttonPlayerId: "cpu1",
      holes: { hero: "As Ah", cpu1: "7c 2d", cpu2: "8c 3d", cpu3: "9c 4d" },
      board: BOARD,
      sessionStart: "tournament",
      sessionEnd: "hero_last_standing",
    });
    const result = tournamentResult([hand]);
    expect(result?.payoutsByPlace).toEqual([200, 120, 80]);
    expect(result?.placements).toEqual([
      { playerId: "hero", place: 1, eliminatedInHandId: null, payout: 200 },
      { playerId: "cpu1", place: 2, eliminatedInHandId: "h1", payout: 66 },
      { playerId: "cpu2", place: 2, eliminatedInHandId: "h1", payout: 67 },
      { playerId: "cpu3", place: 2, eliminatedInHandId: "h1", payout: 67 },
    ]);
    expect(decidedTotal(result as TournamentResult)).toBe(400);
  });

  it("同順位が入賞の境目をまたぐなら、入賞しなかった順位の 0 を含めて合算する（3 位タイ 2 人で 80 + 0 を等分）", () => {
    // 4 人。cpu3（開始 1,000）が 2 位、cpu1・cpu2（開始 500）が同順位の 3 位で、3 位と 4 位の賞金 80 + 0 を 40 ずつ。
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
    const result = tournamentResult([hand]);
    expect(result?.placements.map((p) => [p.playerId, p.payout])).toEqual([
      ["hero", 200],
      ["cpu1", 40],
      ["cpu2", 40],
      ["cpu3", 120],
    ]);
    expect(decidedTotal(result as TournamentResult)).toBe(400);
  });

  it("Hero の Bust で終えたら Hero の賞金を確定し、残った CPU の賞金は未確定（null。D129）", () => {
    // 3 人（Prize Pool 300 → 150 / 90 / 60）。Hand 1 で cpu2 が 3 位、Hand 2（Heads-Up）で hero が Bust して 2 位。
    const hand1 = playAllIn({
      handId: "h1",
      seats: [seat("hero", 600), seat("cpu1", 3_000), seat("cpu2", 400)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "Tc Th", cpu2: "7c 2d" },
      board: BOARD,
      sessionStart: "tournament",
    });
    // 続いている Tournament でも、Bust して決まった順位の賞金は確定する。
    const inProgress = tournamentResult([hand1]);
    expect(inProgress?.status).toBe("in_progress");
    expect(inProgress?.placements.map((p) => [p.playerId, p.payout])).toEqual([
      ["hero", null],
      ["cpu1", null],
      ["cpu2", 60],
    ]);

    const next = nextSeating(hand1);
    const hand2 = playAllIn({
      handId: "h2",
      seats: next.seats,
      buttonPlayerId: next.buttonPlayerId,
      holes: { hero: "7c 2d", cpu1: "As Ah" },
      board: BOARD,
      sessionEnd: "hero_busted",
    });
    const result = tournamentResult([hand1, hand2]);
    expect(result?.status).toBe("finished");
    expect(result?.placements).toEqual([
      { playerId: "hero", place: 2, eliminatedInHandId: "h2", payout: 90 },
      { playerId: "cpu1", place: null, eliminatedInHandId: null, payout: null },
      { playerId: "cpu2", place: 3, eliminatedInHandId: "h1", payout: 60 },
    ]);
    // 未決の 1 位の賞金と、確定した賞金の合計が Prize Pool。
    expect(decidedTotal(result as TournamentResult)).toBe(300 - 150);
  });

  it("Hero が入賞の外で Bust したら Hero の賞金は 0 で確定し、残った CPU は未確定", () => {
    // 4 人（Prize Pool 400）。hero だけが Bust して 4 位（入賞は 3 位まで）。
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
    expect(
      tournamentResult([hand])?.placements.map((p) => [p.playerId, p.payout]),
    ).toEqual([
      ["hero", 0],
      ["cpu1", null],
      ["cpu2", null],
      ["cpu3", null],
    ]);
  });

  it("CPU の障害で打ち切った Tournament は、それまでに決まった順位の賞金だけを確定し、残っていた Player は未確定（OI-007）", () => {
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
    const result = tournamentResult([hand1, hand2]);
    expect(result?.status).toBe("abandoned");
    expect(result?.placements.map((p) => [p.playerId, p.payout])).toEqual([
      ["hero", null],
      ["cpu1", null],
      ["cpu2", 60],
    ]);
  });

  it("入賞の数が参加人数より多い（Prize Pool を配り切れない）なら投げる", () => {
    // 2 人で標準 Preset（入賞 3）。
    const hand = playAllIn({
      handId: "h1",
      seats: [seat("hero", 3_000), seat("cpu1", 500)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "7c 2d" },
      board: BOARD,
      sessionStart: "tournament",
      sessionEnd: "hero_last_standing",
    });
    expect(() => tournamentResult([hand])).toThrow(RangeError);
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
    expect(tournamentResult([cash])).toBeNull();
    const old = playAllIn({
      handId: "h1",
      seats: [seat("hero", 1_000), seat("cpu1", 1_000)],
      buttonPlayerId: "hero",
      holes: { hero: "As Ah", cpu1: "7c 2d" },
      board: BOARD,
    });
    expect(tournamentResult([old])).toBeNull();
    expect(tournamentResult([])).toBeNull();
  });
});
