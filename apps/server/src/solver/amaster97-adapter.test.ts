// Solver Adapter のテスト（docs/09 §7: Capability Detection・Supported / Unsupported・Timeout・Cancellation・
// Invalid Input・Parse Failure・Version Metadata・Range Assumption の保持）。実 Solver は呼ばず、偽の Solver と録画で確かめる。
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseCard,
  parseCards,
  parseRange,
  type VillainRange,
} from "@proj-poker/engine";
import {
  AMASTER97_CAPABILITY,
  AMASTER97_PINNED_COMMIT,
  createAmaster97Adapter,
  detectAmaster97Install,
  type InstallState,
} from "./amaster97-adapter.js";
import { createSolverAdapterFromEnv } from "./index.js";
import type { ProcessCommand } from "./process.js";
import { rangeFromModel } from "./spot.js";
import {
  createFakeSolver,
  writeFakeInstall,
  type FakeSolver,
} from "./testing/fake-solver.js";
import { FLOP_SPOT, RIVER_SPOT, TURN_SPOT } from "./testing/fixed-spots.js";
import {
  SOLVER_FALLBACK,
  SolverError,
  type AnalysisSpot,
  type SolverErrorCode,
} from "./types.js";

let fake: FakeSolver;
let installed: InstallState;

beforeEach(() => {
  fake = createFakeSolver();
  installed = detectAmaster97Install(writeFakeInstall(fake.dir));
});

afterEach(() => {
  fake.cleanup();
});

function adapter(
  command: ProcessCommand,
  overrides: { install?: InstallState; maxConcurrency?: number } = {},
) {
  return createAmaster97Adapter({
    install: overrides.install ?? installed,
    timeoutMs: 10_000,
    maxConcurrency: overrides.maxConcurrency ?? 1,
    iterations: 200,
    command,
  });
}

/** analyze が SolverError の code で失敗することを確かめる。 */
async function expectSolverError(
  promise: Promise<unknown>,
  code: SolverErrorCode,
): Promise<SolverError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SolverError);
  expect((error as SolverError).code).toBe(code);
  return error as SolverError;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Capability Detection", () => {
  it("宣言は #76 で動いた範囲だけ（HU・Turn / River・Cash。Rake・ICM・Side Pot なし）", () => {
    const a = adapter(fake.command("recorded"));
    expect(a.capabilities()).toEqual({
      playerCounts: [2],
      streets: ["turn", "river"],
      modes: ["cash"],
      rakeSupport: false,
      icmSupport: false,
      sidePotSupport: false,
    });
    expect(a.capabilities()).toBe(AMASTER97_CAPABILITY);
  });

  it("導入先の install.json と Python を確かめる", () => {
    expect(installed).toMatchObject({
      installed: true,
      info: { commit: AMASTER97_PINNED_COMMIT, version: "1.11.0" },
    });
    // 未設定・install.json が無い・形が違う・Python が無いは、いずれも未導入（理由つき）。
    const empty = mkdtempSync(join(fake.dir, "empty-"));
    const states = [
      detectAmaster97Install(null),
      detectAmaster97Install(empty),
      detectAmaster97Install(writeFakeInstall(fake.dir, { commit: "main" })),
      detectAmaster97Install(writeFakeInstall(fake.dir, { solver: "other" })),
      detectAmaster97Install(
        writeFakeInstall(fake.dir, { python: join(empty, "no-python") }),
      ),
    ];
    for (const state of states) {
      expect(state.installed).toBe(false);
      if (!state.installed) expect(state.detail).not.toBe("");
    }
  });

  it("環境変数が未設定なら、どの Spot も solver_not_installed（起動は止めない）", () => {
    const a = createSolverAdapterFromEnv({});
    expect(a.supports(RIVER_SPOT)).toMatchObject({
      supported: false,
      reason: "solver_not_installed",
      fallback: SOLVER_FALLBACK,
    });
  });
});

describe("Supported Spot", () => {
  it("HU の River / Turn は supported", () => {
    const a = adapter(fake.command("recorded"));
    expect(a.supports(RIVER_SPOT)).toEqual({ supported: true });
    expect(a.supports(TURN_SPOT)).toEqual({ supported: true });
  });

  it("録画した出力を SolverEvidence に正規化する（Root の行動 × 頻度・Hand Class ごと・EV は取れないと明示）", async () => {
    const evidence = await adapter(fake.command("recorded")).analyze(
      RIVER_SPOT,
    );
    expect(evidence.kind).toBe("solver");
    expect(evidence.scope).toBe("heads_up");
    expect(evidence.node).toEqual({ street: "river", actor: "oop" });
    const byKey = Object.fromEntries(evidence.strategy.map((s) => [s.key, s]));
    expect(byKey.check?.action).toEqual({ kind: "check" });
    expect(byKey.bet_50?.action).toEqual({ kind: "bet", potFraction: 0.5 });
    // All-in の額は Effective Stack（Chip）。
    expect(byKey.all_in?.action).toEqual({ kind: "all_in", amount: 64 });
    const sum = evidence.strategy.reduce((a, s) => a + s.frequency, 0);
    expect(sum).toBeCloseTo(1, 6);
    // 実 Solver の River（#76 の固定 Spot）は Check が大半。
    expect(byKey.check?.frequency).toBeGreaterThan(0.8);
    expect(Object.keys(evidence.byHandClass).length).toBeGreaterThan(0);
    expect(evidence.ev.available).toBe(false);
    expect(evidence.ev.reason).not.toBe("");
    expect(evidence.convergence).toMatchObject({
      iterations: 200,
      exploitability: null,
    });
    expect(evidence.assumptions).toContain(
      "HU（2 人）の Solver の結果。Multiway の Exact GTO ではない",
    );
    expect(evidence.spot).toEqual({
      street: "river",
      board: ["Ks", "7d", "2c", "4h", "9s"],
      pot: 48,
      effectiveStack: 64,
      playerCount: 2,
      rakeRate: 0,
    });
  });

  it("Solver へは検証済みの値を Chip × 100・具体的な Combo で渡す", async () => {
    await adapter(fake.command("recorded")).analyze(RIVER_SPOT, {
      iterations: 50,
    });
    const request = fake.lastRequest() as Record<string, unknown> & {
      ranges: { oop: string[]; ip: string[] };
    };
    expect(request).toMatchObject({
      protocol: 1,
      street: "river",
      board: ["Ks", "7d", "2c", "4h", "9s"],
      pot: 4800,
      effective_stack: 6400,
      bet_tree: {
        bet_pot_fractions: [0.5],
        raise_multipliers: [3],
        all_in: true,
        raise_cap: 4,
      },
      iterations: 50,
    });
    // #76 の有効 Combo 数（Board と衝突する Combo を除いた数）と同じ。
    expect(request.ranges.oop).toHaveLength(207);
    expect(request.ranges.ip).toHaveLength(152);
    expect(request.ranges.oop[0]).toMatch(/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/);
  });
});

describe("Unsupported Spot（正常系として理由つきで返す）", () => {
  const a = () => adapter(fake.command("recorded"));
  const cases: [string, AnalysisSpot, string][] = [
    ["Flop", FLOP_SPOT, "street"],
    ["Multiway（3 人）", { ...RIVER_SPOT, playerCount: 3 }, "player_count"],
    ["Tournament", { ...RIVER_SPOT, mode: "tournament" }, "mode"],
    ["Rake あり", { ...RIVER_SPOT, rakeRate: 0.05 }, "rake"],
    [
      "Bet Size が 6 種",
      {
        ...RIVER_SPOT,
        betTree: {
          ...RIVER_SPOT.betTree,
          betPotFractions: [0.25, 0.33, 0.5, 0.75, 1, 1.5],
        },
      },
      "bet_tree",
    ],
    [
      "% が重なる Bet Size",
      {
        ...RIVER_SPOT,
        betTree: { ...RIVER_SPOT.betTree, betPotFractions: [0.5, 0.501] },
      },
      "bet_tree",
    ],
    [
      "攻撃回数が計測した 4 回を超える",
      { ...RIVER_SPOT, betTree: { ...RIVER_SPOT.betTree, raiseCap: 5 } },
      "bet_tree",
    ],
  ];
  it.each(cases)("%s", (_name, spot, reason) => {
    expect(a().supports(spot)).toMatchObject({
      supported: false,
      reason,
      fallback: ["math", "range_analysis", "kb", "review_ai"],
    });
  });

  it("Solver 未導入は solver_not_installed。Capability 外の理由が先に出る", () => {
    const notInstalled: InstallState = { installed: false, detail: "未導入" };
    const a = adapter(fake.command("recorded"), { install: notInstalled });
    expect(a.supports(RIVER_SPOT)).toMatchObject({
      supported: false,
      reason: "solver_not_installed",
    });
    expect(a.supports({ ...RIVER_SPOT, playerCount: 4 })).toMatchObject({
      reason: "player_count",
    });
  });

  it("Multiway の理由は HU Solver を Multiway の Exact GTO として扱わないことを書く", () => {
    const result = a().supports({ ...TURN_SPOT, playerCount: 3 });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.detail).toContain("Exact GTO");
  });

  it("supports を通らない Spot を analyze しても Solver を動かさない", async () => {
    await expectSolverError(a().analyze(FLOP_SPOT), "unsupported");
    await expectSolverError(
      adapter(fake.command("recorded"), {
        install: { installed: false, detail: "未導入" },
      }).analyze(RIVER_SPOT),
      "unsupported",
    );
    expect(fake.calls()).toBe(0);
  });
});

describe("Timeout", () => {
  it("上限で SIGKILL し、プロセスを残さずに timeout で返す", async () => {
    const a = adapter(fake.command("sleep"));
    await expectSolverError(
      a.analyze(RIVER_SPOT, { timeoutMs: 1000 }),
      "timeout",
    );
    const pid = fake.pid();
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
  });
});

describe("Cancellation", () => {
  it("AbortSignal で SIGKILL し、プロセスを残さずに cancelled で返す", async () => {
    const controller = new AbortController();
    const promise = adapter(fake.command("sleep")).analyze(RIVER_SPOT, {
      signal: controller.signal,
    });
    // 偽の Solver が pid を書くまで待ってから止める。
    while (fake.pid() === 0 || Number.isNaN(fake.pid())) {
      await new Promise((r) => setTimeout(r, 20));
    }
    controller.abort();
    await expectSolverError(promise, "cancelled");
    expect(isAlive(fake.pid())).toBe(false);
  });

  it("取り消し済みの signal では Solver を動かさない", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectSolverError(
      adapter(fake.command("recorded")).analyze(RIVER_SPOT, {
        signal: controller.signal,
      }),
      "cancelled",
    );
    expect(fake.calls()).toBe(0);
  });

  it("同時実行数（既定 1）を超えた分は待ち、待っている間の取り消しは Solver を動かさない", async () => {
    const a = adapter(fake.command("slow"), { maxConcurrency: 1 });
    const controller = new AbortController();
    const first = a.analyze(RIVER_SPOT);
    const second = a.analyze(TURN_SPOT, { signal: controller.signal });
    const third = a.analyze(RIVER_SPOT);
    controller.abort();
    await expectSolverError(second, "cancelled");
    await Promise.all([first, third]);
    // 2 回だけ動き、1 回目が終わってから 2 回目が始まる（重ならない）。
    const log = fake.callLog().map((l) => l.split(" "));
    expect(log.map(([, kind]) => kind)).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
    expect(Number(log[2]?.[2])).toBeGreaterThanOrEqual(Number(log[1]?.[2]));
  });
});

describe("Invalid Input（Solver には渡さない）", () => {
  const card = parseCard;
  const cases: [string, AnalysisSpot][] = [
    [
      "不正なカード",
      {
        ...RIVER_SPOT,
        board: [...RIVER_SPOT.board.slice(0, 4), { rank: 1, suit: "x" }],
      } as unknown as AnalysisSpot,
    ],
    ["Board の重複", { ...RIVER_SPOT, board: parseCards("Ks Ks 2c 4h 9s") }],
    [
      "Street と Board の枚数が合わない",
      { ...RIVER_SPOT, board: parseCards("Ks 7d 2c 4h") },
    ],
    ["負の Pot", { ...RIVER_SPOT, pot: -48 }],
    ["小数の Pot", { ...RIVER_SPOT, pot: 48.5 }],
    ["Effective Stack が 0", { ...RIVER_SPOT, effectiveStack: 0 }],
    [
      "空の Range",
      {
        ...RIVER_SPOT,
        ranges: {
          ...RIVER_SPOT.ranges,
          ip: { ...RIVER_SPOT.ranges.ip, combos: [] },
        },
      },
    ],
    [
      "Board と衝突する Combo",
      {
        ...RIVER_SPOT,
        ranges: {
          ...RIVER_SPOT.ranges,
          oop: {
            ...RIVER_SPOT.ranges.oop,
            combos: [[card("Ks"), card("Kd")]],
          },
        },
      },
    ],
    [
      "同じ札 2 枚の Combo",
      {
        ...RIVER_SPOT,
        ranges: {
          ...RIVER_SPOT.ranges,
          oop: {
            ...RIVER_SPOT.ranges.oop,
            combos: [[card("Ah"), card("Ah")]],
          },
        },
      },
    ],
    [
      "重複した Combo",
      {
        ...RIVER_SPOT,
        ranges: {
          ...RIVER_SPOT.ranges,
          ip: {
            ...RIVER_SPOT.ranges.ip,
            combos: [
              [card("Ah"), card("Ad")],
              [card("Ad"), card("Ah")],
            ],
          },
        },
      },
    ],
    [
      "Bet Size が NaN",
      {
        ...RIVER_SPOT,
        betTree: { ...RIVER_SPOT.betTree, betPotFractions: [Number.NaN] },
      },
    ],
    [
      "Raise 倍率が 1 以下",
      {
        ...RIVER_SPOT,
        betTree: { ...RIVER_SPOT.betTree, raiseMultipliers: [1] },
      },
    ],
  ];
  it.each(cases)("%s", async (_name, spot) => {
    await expectSolverError(
      adapter(fake.command("recorded")).analyze(spot),
      "invalid_input",
    );
    expect(fake.calls()).toBe(0);
  });

  it("不正な timeoutMs・iterations", async () => {
    const a = adapter(fake.command("recorded"));
    await expectSolverError(
      a.analyze(RIVER_SPOT, { timeoutMs: 0 }),
      "invalid_input",
    );
    await expectSolverError(
      a.analyze(RIVER_SPOT, { iterations: 1.5 }),
      "invalid_input",
    );
    await expectSolverError(
      a.analyze(RIVER_SPOT, { iterations: 10_000_000 }),
      "invalid_input",
    );
    expect(fake.calls()).toBe(0);
  });
});

describe("Parse Failure と異常終了", () => {
  const recorded = {
    protocol: 1,
    solver_version: "1.11.0",
    iterations: 200,
    decision_nodes: 8,
    hand_counts: [152, 207],
    root_actor: "oop",
    range_aggregate: { check: 0.88, bet_50: 0.12, all_in: 0 },
    per_class: { AQs: { check: 1, bet_50: 0, all_in: 0 } },
    solve_wall_s: 0.03,
    warnings: [],
  };
  const json = (patch: Record<string, unknown>) =>
    JSON.stringify({ ...recorded, ...patch });

  it("形の合った JSON は読める（以下の失敗の対照）", async () => {
    const evidence = await adapter(fake.command("json", json({}))).analyze(
      RIVER_SPOT,
    );
    expect(evidence.strategy.map((s) => s.key)).toEqual([
      "check",
      "bet_50",
      "all_in",
    ]);
  });

  it.each([
    ["JSON ではない", () => fake.command("garbage")],
    [
      "頻度の合計が 1 ではない（読めても正しいとは限らない）",
      () =>
        fake.command(
          "json",
          json({ range_aggregate: { check: 0.3, bet_50: 0.2 } }),
        ),
    ],
    [
      "Root にあり得ない行動のラベル",
      () =>
        fake.command(
          "json",
          json({ range_aggregate: { check: 0.5, "raise_3.0x": 0.5 } }),
        ),
    ],
    [
      "Bet Tree に無い Bet Size",
      () =>
        fake.command(
          "json",
          json({ range_aggregate: { check: 0.5, bet_75: 0.5 } }),
        ),
    ],
    [
      "範囲外の頻度",
      () =>
        fake.command(
          "json",
          json({ range_aggregate: { check: 1.5, bet_50: -0.5 } }),
        ),
    ],
    ["protocol が違う", () => fake.command("json", json({ protocol: 2 }))],
    [
      "root_actor が OOP ではない",
      () => fake.command("json", json({ root_actor: "ip" })),
    ],
    [
      "per_class に知らない行動",
      () => fake.command("json", json({ per_class: { AQs: { fold: 1 } } })),
    ],
  ] as const)("%s → parse_failure", async (_name, command) => {
    await expectSolverError(
      adapter(command()).analyze(RIVER_SPOT),
      "parse_failure",
    );
  });

  it("exit 1 は process_failed（stderr の要点を載せる）", async () => {
    const error = await expectSolverError(
      adapter(fake.command("crash")).analyze(RIVER_SPOT),
      "process_failed",
    );
    expect(error.message).toContain("Invalid rank");
  });

  it("起動できない（実行ファイルが無い）は process_failed", async () => {
    await expectSolverError(
      adapter({ file: join(fake.dir, "no-such-solver"), args: [] }).analyze(
        RIVER_SPOT,
      ),
      "process_failed",
    );
  });
});

describe("Version Metadata", () => {
  it("install.json の commit と Solver の版を Evidence に残す", async () => {
    const evidence = await adapter(fake.command("recorded")).analyze(
      RIVER_SPOT,
    );
    expect(evidence.solver).toEqual({
      id: "amaster97/poker_solver",
      repository: "https://github.com/amaster97/poker_solver.git",
      version: "1.11.0",
      commit: AMASTER97_PINNED_COMMIT,
      pinnedCommit: true,
    });
    expect(evidence.warnings).toEqual([]);
  });

  it("固定 commit と違う・版が install.json と違うなら warnings に載せる", async () => {
    const other = "0".repeat(40);
    const install = detectAmaster97Install(
      writeFakeInstall(fake.dir, { commit: other, version: "1.12.0" }),
    );
    const evidence = await adapter(fake.command("recorded"), {
      install,
    }).analyze(RIVER_SPOT);
    expect(evidence.solver).toMatchObject({
      commit: other,
      version: "1.11.0",
      pinnedCommit: false,
    });
    expect(evidence.warnings).toHaveLength(2);
  });
});

describe("Range Assumption の保持", () => {
  it("Range Model（#79）の Assumption と表記の Assumption をそのまま Evidence に残す", async () => {
    const board = RIVER_SPOT.board;
    const dead = new Set(board.map((c) => `${c.rank}${c.suit}`));
    const combos = parseRange("QQ+,AKs").filter(
      ([x, y]) =>
        !dead.has(`${x.rank}${x.suit}`) && !dead.has(`${y.rank}${y.suit}`),
    );
    const modelRange: VillainRange = {
      assumption: {
        playerId: "co",
        profileId: "standard",
        position: "CO",
        preflopSpot: "open",
        preflopNotation: "QQ+,AKs",
        postflop: [],
        comboCount: combos.length,
      },
      combos,
    };
    const spot: AnalysisSpot = {
      ...RIVER_SPOT,
      ranges: { ...RIVER_SPOT.ranges, ip: rangeFromModel(modelRange) },
      assumptions: ["Flop までは 3 人。Turn で 1 人が Fold し HU になった"],
    };
    const evidence = await adapter(fake.command("recorded")).analyze(spot);
    expect(evidence.rangeAssumptions.ip).toEqual({
      source: "range_model",
      model: modelRange.assumption,
      comboCount: combos.length,
    });
    expect(evidence.rangeAssumptions.oop).toMatchObject({
      source: "notation",
      note: "#76 の PoC の OOP Range",
      comboCount: 207,
    });
    expect(evidence.assumptions).toContain(
      "Flop までは 3 人。Turn で 1 人が Fold し HU になった",
    );
    // Solver へ渡した IP の Combo は Range Model の Combo そのもの（Hand Class に丸めない）。
    const request = fake.lastRequest() as { ranges: { ip: string[] } };
    expect(request.ranges.ip).toHaveLength(combos.length);
  });
});

describe("createAmaster97Adapter の設定", () => {
  it("同時実行数は 1 以上の整数", () => {
    expect(() =>
      adapter(fake.command("recorded"), { maxConcurrency: 0 }),
    ).toThrow(RangeError);
  });
});
