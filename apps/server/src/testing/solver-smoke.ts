// 実 Solver（amaster97/poker_solver）の手動スモーク（#81）。実際に Solver を動かすので CI と pnpm test では動かさない。
// 本番と同じ経路（createSolverAdapterFromEnv → supports → analyze）で #76 の固定 Spot の River と Turn を解き、
// Root の戦略・所要時間・Version Metadata を出す。Flop と Multiway は Unsupported になることも確かめる。
// 最後に Turn を Timeout（2 秒）と Cancel（1 秒後に abort）で止め、runner のプロセスが残らないことを pgrep で確かめる。
// 実行: POKER_SOLVER_HOME=<導入先> pnpm --filter @proj-poker/server smoke:solver
import { spawnSync } from "node:child_process";
import { createSolverAdapterFromEnv, SolverError } from "../solver/index.js";
import {
  FLOP_SPOT,
  RIVER_SPOT,
  TURN_SPOT,
} from "../solver/testing/fixed-spots.js";
import type { AnalysisSpot } from "../solver/types.js";

const adapter = createSolverAdapterFromEnv();
const cases: [string, AnalysisSpot][] = [
  ["river", RIVER_SPOT],
  ["turn", TURN_SPOT],
  ["flop", FLOP_SPOT],
  ["multiway_river", { ...RIVER_SPOT, playerCount: 3 }],
];

for (const [name, spot] of cases) {
  const support = adapter.supports(spot);
  if (!support.supported) {
    console.log(
      JSON.stringify({
        name,
        supported: false,
        reason: support.reason,
        detail: support.detail,
      }),
    );
    continue;
  }
  try {
    const evidence = await adapter.analyze(spot);
    console.log(
      JSON.stringify({
        name,
        supported: true,
        wallMs: evidence.stats.wallMs,
        decisionNodes: evidence.stats.decisionNodes,
        iterations: evidence.convergence.iterations,
        strategy: Object.fromEntries(
          evidence.strategy.map((s) => [s.key, Number(s.frequency.toFixed(4))]),
        ),
        solver: evidence.solver,
        ev: evidence.ev.available,
        rangeCombos: {
          oop: evidence.rangeAssumptions.oop.comboCount,
          ip: evidence.rangeAssumptions.ip.comboCount,
        },
        warnings: evidence.warnings,
      }),
    );
  } catch (error) {
    if (!(error instanceof SolverError)) throw error;
    console.log(
      JSON.stringify({
        name,
        supported: true,
        error: error.code,
        message: error.message,
      }),
    );
  }
}

/** 止めた後に runner のプロセスが残っていないか（pgrep は該当なしで exit 1）。 */
function leftoverRunners(): string {
  return spawnSync(
    "pgrep",
    ["-f", String.raw`^\S*python\S* \S*amaster97_runner\.py$`],
    { encoding: "utf8" },
  ).stdout.trim();
}

if (adapter.supports(TURN_SPOT).supported) {
  const stops: [string, () => Promise<unknown>][] = [
    ["turn_timeout_2s", () => adapter.analyze(TURN_SPOT, { timeoutMs: 2000 })],
    [
      "turn_cancel_1s",
      () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1000);
        return adapter.analyze(TURN_SPOT, { signal: controller.signal });
      },
    ],
  ];
  for (const [name, run] of stops) {
    const started = performance.now();
    try {
      await run();
      console.log(JSON.stringify({ name, error: null }));
    } catch (error) {
      if (!(error instanceof SolverError)) throw error;
      console.log(
        JSON.stringify({
          name,
          error: error.code,
          ms: Math.round(performance.now() - started),
          leftover: leftoverRunners() || "none",
        }),
      );
    }
  }
}
