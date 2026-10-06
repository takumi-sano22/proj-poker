// Review の Solver Evidence のテスト（Capability Gate・Root の Node だけ解く・失敗の Fallback）。実 Solver は呼ばない。
import {
  heroInformationSets,
  parseCards,
  type HeroInformationSet,
} from "@proj-poker/engine";
import { describe, expect, it, vi } from "vitest";
import {
  AMASTER97_CAPABILITY,
  DEFAULT_BET_TREE,
} from "../solver/amaster97-adapter.js";
import {
  SolverError,
  type AnalysisSpot,
  type SolverAdapter,
  type SolverEvidence,
} from "../solver/types.js";
import {
  BTN_VS_UTG,
  SB_VS_BTN,
  playScriptedHand,
} from "../testing/review-eval/hands.js";
import { buildSolverEvidence, handClassOf } from "./solver-evidence.js";

const setAt = (events: ReturnType<typeof playScriptedHand>, index: number) =>
  heroInformationSets(events, "hero")[index] as HeroInformationSet;

/** 渡された Spot を記録し、決めた結果を返す Solver。supports は Capability（HU・Turn / River）だけを見る。 */
function stubSolver(analyze: (spot: AnalysisSpot) => Promise<SolverEvidence>) {
  const spots: AnalysisSpot[] = [];
  const analyzeMock = vi.fn((spot: AnalysisSpot) => {
    spots.push(spot);
    return analyze(spot);
  });
  const adapter: SolverAdapter = {
    capabilities: () => AMASTER97_CAPABILITY,
    supports: (spot) =>
      spot.playerCount === 2 &&
      (spot.street === "turn" || spot.street === "river") &&
      !spot.sidePot
        ? { supported: true }
        : {
            supported: false,
            reason: spot.playerCount === 2 ? "street" : "player_count",
            detail: "対象外",
            fallback: ["math", "range_analysis", "kb", "review_ai"],
          },
    analyze: analyzeMock,
  };
  return { adapter, spots, analyze: analyzeMock };
}

/** Solver の結果（形だけ。値は Turn の 98s の Spot を模したもの）。 */
function fakeEvidence(spot: AnalysisSpot): SolverEvidence {
  return {
    kind: "solver",
    solver: {
      id: "amaster97/poker_solver",
      repository: "https://example.invalid/poker_solver.git",
      version: "1.11.0",
      commit: "f78f1b2bc338dd8cbb5226ecb8398bbdb3635676",
      pinnedCommit: true,
    },
    scope: "heads_up",
    node: { street: spot.street, actor: "oop" },
    spot: {
      street: spot.street,
      board: ["Th", "7c", "2s", "6d"],
      pot: spot.pot,
      effectiveStack: spot.effectiveStack,
      playerCount: 2,
      sidePot: false,
      rakeRate: 0,
    },
    betTree: DEFAULT_BET_TREE,
    strategy: [
      { key: "check", action: { kind: "check" }, frequency: 0.7 },
      {
        key: "bet_50",
        action: { kind: "bet", potFraction: 0.5 },
        frequency: 0.3,
      },
    ],
    byHandClass: {
      "98s": { check: 0.45, bet_50: 0.55 },
      AA: { check: 0.9, bet_50: 0.1 },
    },
    ev: { available: false, reason: "取れない" },
    convergence: {
      iterations: 200,
      exploitability: null,
      note: "Iteration 数",
    },
    rangeAssumptions: {
      oop: {
        ...spot.ranges.oop.assumption,
        comboCount: spot.ranges.oop.combos.length,
      },
      ip: {
        ...spot.ranges.ip.assumption,
        comboCount: spot.ranges.ip.combos.length,
      },
    },
    assumptions: ["HU（2 人）の Solver の結果。Multiway の Exact GTO ではない"],
    warnings: [],
    stats: { wallMs: 1, decisionNodes: 8 },
  };
}

describe("buildSolverEvidence", () => {
  it("Hero が HU の Turn で最初に動く（OOP の Root）ときだけ解く: Pot・有効 Stack は判断時点、Range は Hero と相手の Range Model", async () => {
    const { adapter, spots } = stubSolver((s) =>
      Promise.resolve(fakeEvidence(s)),
    );
    const set = setAt(playScriptedHand(SB_VS_BTN), 2);
    const item = await buildSolverEvidence(set, adapter);
    expect(spots).toHaveLength(1);
    const spot = spots[0] as AnalysisSpot;
    expect(spot).toMatchObject({
      street: "turn",
      playerCount: 2,
      sidePot: false,
      mode: "cash",
      pot: set.knowledge.pot,
      effectiveStack: set.knowledge.math.effectiveStack,
      rakeRate: 0,
    });
    expect(spot.board).toEqual(set.knowledge.board);
    expect(spot.ranges.oop.assumption).toMatchObject({
      source: "range_model",
      model: { playerId: "hero", position: "SB", preflopSpot: "call_open" },
    });
    expect(spot.ranges.ip.assumption).toMatchObject({
      source: "range_model",
      model: { playerId: "cpu5", position: "BTN", preflopSpot: "open" },
    });
    expect(spot.ranges.oop.combos.length).toBeGreaterThan(0);
    expect(spot.ranges.ip.combos.length).toBeGreaterThan(0);

    expect(item).toMatchObject({
      status: "supported",
      id: "solver:amaster97/poker_solver@f78f1b2bc338:review-sb_vs_btn/d2",
      scope: "heads_up",
      heroHandClass: "98s",
      heroHandClassStrategy: { check: 0.45, bet_50: 0.55 },
    });
    if (item.status !== "supported") throw new Error("supported ではない");
    // Hand Class の頻度は Class の Combo を合わせたものという前提を足す。全 Class の表は渡さない。
    expect(item.assumptions.at(-1)).toContain("98s");
    expect(item).not.toHaveProperty("byHandClass");
  });

  it("Bet に直面した判断・IP の判断（Root の後の Node）は解かない", async () => {
    const stub = stubSolver((s) => Promise.resolve(fakeEvidence(s)));
    const { adapter } = stub;
    // River で Bet に直面して Call（HU・River なので Capability は通る）。
    const facing = await buildSolverEvidence(
      setAt(playScriptedHand(BTN_VS_UTG), 3),
      adapter,
    );
    expect(facing).toMatchObject({
      status: "not_applicable",
      reason: "not_root_node",
    });
    // Turn で相手の Check の後に Check（IP）。
    const ip = await buildSolverEvidence(
      setAt(playScriptedHand(BTN_VS_UTG), 2),
      adapter,
    );
    expect(ip).toMatchObject({
      status: "not_applicable",
      reason: "not_root_node",
    });
    expect(stub.analyze).not.toHaveBeenCalled();
  });

  it("Capability の外（Flop）は supports の理由のまま Unsupported にし、解かない", async () => {
    const stub = stubSolver((s) => Promise.resolve(fakeEvidence(s)));
    const { adapter } = stub;
    const flop = await buildSolverEvidence(
      setAt(playScriptedHand(SB_VS_BTN), 1),
      adapter,
    );
    expect(flop).toEqual({
      status: "unsupported",
      reason: "street",
      detail: "対象外",
    });
    expect(stub.analyze).not.toHaveBeenCalled();
  });

  it("Solver の失敗（Timeout・異常終了・それ以外の例外）は failed で Fallback し、本文は Evidence に入れずに onFailure へ渡す", async () => {
    const set = setAt(playScriptedHand(SB_VS_BTN), 2);
    const cases = [
      [new SolverError("timeout", "/secret/path で 60000ms"), "timeout"],
      [
        new SolverError("process_failed", "exit 1 /secret/path"),
        "process_failed",
      ],
      [new Error("/secret/path"), "process_failed"],
    ] as const;
    for (const [error, code] of cases) {
      const { adapter } = stubSolver(() => Promise.reject(error));
      const onFailure = vi.fn();
      const item = await buildSolverEvidence(set, adapter, { onFailure });
      expect(item).toMatchObject({ status: "failed", code });
      expect(JSON.stringify(item)).not.toContain("/secret/path");
      expect(onFailure).toHaveBeenCalledWith(error);
    }
  });
});

describe("handClassOf", () => {
  it.each([
    ["9h 8h", "98s"],
    ["8h 9h", "98s"],
    ["Ah Kd", "AKo"],
    ["Td Tc", "TT"],
    ["2c As", "A2o"],
  ])("%s → %s", (cards, expected) => {
    expect(handClassOf(parseCards(cards))).toBe(expected);
  });
});
