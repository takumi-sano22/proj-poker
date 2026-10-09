// CPU の Public Tournament Context（D109・D130・#188）の Scenario と情報境界。
// - 値は公開の Hand の開始時の Stack と Session の設定だけから、ICM Calculator（icm.ts）と同じ計算で作る
// - Cash の Hand（Session の情報を渡さない）の KnowledgeState は項目ごと持たない（Prompt を変えない）
// - 他者の Hole Cards・Deck を変えても、Hand の途中で Action が進んでも値は変わらない（Hand の開始時の公開の Stack だけを読む）
import { describe, expect, it } from "vitest";
import { applyAction, startHand } from "./hand-engine.js";
import type { HandEvent, SeatInit } from "./hand-events.js";
import { ICM_POLICY, bubbleFactors, icmEquities } from "./icm.js";
import { getLegalActions } from "./legal-actions.js";
import { projectKnowledgeState } from "./projection.js";
import { PHASE1_CASH_PRESET } from "./table-config.js";
import {
  TOURNAMENT_KNOWLEDGE_VERSION,
  tournamentKnowledgeOf,
  tournamentStageOf,
  type TournamentSessionInfo,
} from "./tournament-knowledge.js";
import { PAYOUT_POLICY_VERSION } from "./tournament-payout.js";
import { TOURNAMENT_PRESETS, tableConfigForLevel } from "./tournament.js";

const STANDARD = TOURNAMENT_PRESETS.stt6_hand_count;
const SESSION: TournamentSessionInfo = { config: STANDARD, entrants: 6 };
/** 標準 6-max STT の Level 3（25 / 50・Big Blind Ante 50。D127）。 */
const LEVEL3 = STANDARD.levels[2]!;

const SEATS: SeatInit[] = [
  { playerId: "hero", stack: 3_000 },
  { playerId: "cpu1", stack: 2_500 },
  { playerId: "cpu2", stack: 2_000 },
  { playerId: "cpu3", stack: 1_500 },
];

function tournamentHand(seed: number, seats = SEATS): HandEvent[] {
  const started = startHand({
    handId: `h-${seed}`,
    seats,
    buttonPlayerId: "hero",
    config: tableConfigForLevel(PHASE1_CASH_PRESET, LEVEL3, "big_blind_ante"),
    deal: { seed },
    tournament: { level: 3, handNumber: 25, playTimeMs: 0 },
  });
  if (!started.ok) throw new Error(started.error.message);
  return [...started.value.events];
}

/** seed 1 の Hand を、手番の Player が Call / Check して count 回進めた Event Log。 */
function afterActions(count: number): HandEvent[] {
  const started = startHand({
    handId: "h-1",
    seats: SEATS,
    buttonPlayerId: "hero",
    config: tableConfigForLevel(PHASE1_CASH_PRESET, LEVEL3, "big_blind_ante"),
    deal: { seed: 1 },
    tournament: { level: 3, handNumber: 25, playTimeMs: 0 },
  });
  if (!started.ok) throw new Error(started.error.message);
  let { state } = started.value;
  const out: HandEvent[] = [...started.value.events];
  for (let i = 0; i < count && state.actorIndex !== null; i++) {
    const actor = state.players[state.actorIndex]!;
    const types = getLegalActions(state)?.actions.map((a) => a.type) ?? [];
    const result = applyAction(state, actor.playerId, {
      type: types.includes("call") ? "call" : "check",
    });
    if (!result.ok) throw new Error(result.error.message);
    state = result.value.state;
    out.push(...result.value.events);
  }
  return out;
}

describe("tournamentKnowledgeOf: Scenario", () => {
  it("4 人残り（6 人参加・3 位まで入賞）: Bubble で、Payout・BB 換算・ICM Equity・Bubble Factor は ICM Calculator と同じ値", () => {
    const k = tournamentKnowledgeOf(tournamentHand(1), "hero", SESSION);
    expect(k.version).toBe(TOURNAMENT_KNOWLEDGE_VERSION);
    expect(k.icmPolicyVersion).toBe(ICM_POLICY.version);
    expect(k.payoutPolicyVersion).toBe(PAYOUT_POLICY_VERSION);
    expect(k.stackBasis).toBe("hand_start");
    expect(k.entrants).toBe(6);
    expect(k.remaining).toBe(4);
    expect(k.level).toBe(3);
    expect(k.handNumber).toBe(25);
    expect([k.smallBlind, k.bigBlind]).toEqual([25, 50]);
    expect(k.anteKind).toBe("big_blind_ante");
    expect(k.ante).toBe(50);
    // Prize Pool は 100pt × 6 人 = 600pt を 50 / 30 / 20（D127）。
    expect(k.prizePool).toBe(600);
    expect(k.payoutsByPlace).toEqual([300, 180, 120]);
    expect(k.stage).toBe("bubble");

    // Stack は Hand の開始時（Blind・Ante を払う前）の値で、BB 換算は丸めない。
    expect(k.seats.map((s) => [s.playerId, s.stack, s.stackBb])).toEqual([
      ["hero", 3_000, 60],
      ["cpu1", 2_500, 50],
      ["cpu2", 2_000, 40],
      ["cpu3", 1_500, 30],
    ]);
    const stacks = SEATS.map((s) => ({ playerId: s.playerId, stack: s.stack }));
    const icm = icmEquities(stacks, [300, 180, 120]);
    expect(k.seats.map((s) => s.icmEquity)).toEqual(
      icm.players.map((p) => p.equity),
    );
    expect(k.seats.map((s) => s.icmEquityPercent)).toEqual(
      icm.players.map((p) => p.equityPercent),
    );
    // 4 人で 1〜3 位の 600pt を争う（Σ Equity = 600。浮動小数の誤差の範囲）。
    expect(k.seats.reduce((sum, s) => sum + s.icmEquity, 0)).toBeCloseTo(
      600,
      9,
    );
    expect(k.bubbleFactors).toEqual(
      bubbleFactors(stacks, [300, 180, 120], "hero"),
    );
    // Bubble では、どの相手との All-in も負けの痛みが勝ちの得より大きい（Bubble Factor > 1）。
    expect(k.bubbleFactors.map((b) => b.opponentId)).toEqual([
      "cpu1",
      "cpu2",
      "cpu3",
    ]);
    for (const b of k.bubbleFactors) {
      expect(b.bubbleFactor).not.toBeNull();
      expect(b.bubbleFactor as number).toBeGreaterThan(1);
    }
  });

  it("Bubble Factor は viewer から見た値（席ごとに違う相手の並び）", () => {
    const events = tournamentHand(1);
    const k = tournamentKnowledgeOf(events, "cpu3", SESSION);
    expect(k.bubbleFactors.map((b) => b.opponentId)).toEqual([
      "hero",
      "cpu1",
      "cpu2",
    ]);
    // 全席の Stack と Equity は viewer に依らず同じ（公開の情報）。
    expect(k.seats).toEqual(
      tournamentKnowledgeOf(events, "hero", SESSION).seats,
    );
  });

  it("Heads-Up は heads_up で、Bubble Factor は 1", () => {
    const k = tournamentKnowledgeOf(
      tournamentHand(1, [
        { playerId: "hero", stack: 6_000 },
        { playerId: "cpu1", stack: 3_000 },
      ]),
      "hero",
      SESSION,
    );
    expect(k.stage).toBe("heads_up");
    expect(k.bubbleFactors[0]?.bubbleFactor).toBeCloseTo(1, 9);
  });
});

describe("tournamentStageOf: 残人数と入賞の数", () => {
  it.each([
    [6, 3, "before_bubble"],
    [5, 3, "before_bubble"],
    [4, 3, "bubble"],
    [3, 3, "in_the_money"],
    [2, 3, "heads_up"],
    [3, 1, "before_bubble"],
    [2, 1, "heads_up"],
  ] as const)("残り %i 人・%i 位まで入賞 → %s", (remaining, paid, stage) => {
    expect(tournamentStageOf(remaining, paid)).toBe(stage);
  });
});

describe("KnowledgeState の tournament", () => {
  it("Session の情報を渡さない（Cash の）Projection は項目ごと持たない", () => {
    const k = projectKnowledgeState(tournamentHand(1), "hero");
    expect("tournament" in k).toBe(false);
  });

  it("Session の情報を渡すと、viewer から見た Tournament Context を持つ", () => {
    const events = tournamentHand(1);
    const k = projectKnowledgeState(events, "cpu1", { tournament: SESSION });
    expect(k.tournament).toEqual(
      tournamentKnowledgeOf(events, "cpu1", SESSION),
    );
  });

  it("他者の Hole Cards・Deck を変えても、Hand の途中で Action が進んでも、Tournament Context は変わらない", () => {
    const base = projectKnowledgeState(tournamentHand(1), "cpu2", {
      tournament: SESSION,
    }).tournament;
    for (const seed of [2, 3, 99]) {
      expect(
        projectKnowledgeState(tournamentHand(seed), "cpu2", {
          tournament: SESSION,
        }).tournament,
      ).toEqual(base);
    }
    const progressed = afterActions(2);
    expect(progressed.some((e) => e.type === "ACTION_TAKEN")).toBe(true);
    for (const viewer of ["cpu2", "hero"]) {
      expect(
        projectKnowledgeState(progressed, viewer, { tournament: SESSION })
          .tournament?.seats,
      ).toEqual(base?.seats);
    }
  });

  it("Tournament の値に Hole Cards・Deck は入らない（構造の whitelist）", () => {
    const k = tournamentKnowledgeOf(tournamentHand(1), "hero", SESSION);
    const text = JSON.stringify(k);
    expect(text).not.toMatch(/holeCards|deck|rank|suit/);
  });
});

describe("tournamentKnowledgeOf: 入力の検証", () => {
  it("Level と経過の無い Hand（Cash の Hand）・座っていない viewer・残人数より少ない参加人数は拒否する", () => {
    const cash = startHand({
      handId: "c-1",
      seats: SEATS,
      buttonPlayerId: "hero",
      config: PHASE1_CASH_PRESET,
      deal: { seed: 1 },
    });
    if (!cash.ok) throw new Error(cash.error.message);
    expect(() =>
      tournamentKnowledgeOf(cash.value.events, "hero", SESSION),
    ).toThrow(RangeError);
    expect(() =>
      tournamentKnowledgeOf(tournamentHand(1), "nobody", SESSION),
    ).toThrow(RangeError);
    expect(() =>
      tournamentKnowledgeOf(tournamentHand(1), "hero", {
        config: STANDARD,
        entrants: 3,
      }),
    ).toThrow(RangeError);
  });
});
