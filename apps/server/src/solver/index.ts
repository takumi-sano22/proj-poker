// Solver Adapter の入口（#81）。Review（#82）は supports で確かめてから analyze を呼び、
// Unsupported・失敗（SolverError）のときは Math + Range + KB へ Fallback する。
import {
  parseSolverIterations,
  parseSolverMaxConcurrency,
  parseSolverTimeoutMs,
  resolveSolverHome,
} from "../config.js";
import {
  createAmaster97Adapter,
  detectAmaster97Install,
} from "./amaster97-adapter.js";
import type { SolverAdapter } from "./types.js";

export {
  AMASTER97_CAPABILITY,
  AMASTER97_PINNED_COMMIT,
  AMASTER97_SOLVER_ID,
  DEFAULT_BET_TREE,
  createAmaster97Adapter,
  detectAmaster97Install,
} from "./amaster97-adapter.js";
export type {
  Amaster97AdapterConfig,
  Amaster97Install,
  InstallState,
} from "./amaster97-adapter.js";
export { rangeFromModel, rangeFromNotation, validateSpot } from "./spot.js";
export { SOLVER_FALLBACK, SolverError } from "./types.js";
export type {
  AnalysisSpot,
  BetTree,
  SolveOptions,
  SolverAction,
  SolverActionFrequency,
  SolverAdapter,
  SolverCapability,
  SolverErrorCode,
  SolverEvidence,
  SpotRange,
  SpotRangeAssumption,
  SupportResult,
  UnsupportedReason,
} from "./types.js";

/**
 * 環境変数から Primary Solver の Adapter を作る。POKER_SOLVER_HOME が未設定・未導入なら、
 * どの Spot も Unsupported（solver_not_installed）になる（起動は止めない）。
 */
export function createSolverAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SolverAdapter {
  return createAmaster97Adapter({
    install: detectAmaster97Install(resolveSolverHome(env.POKER_SOLVER_HOME)),
    timeoutMs: parseSolverTimeoutMs(env.SOLVER_TIMEOUT_MS),
    maxConcurrency: parseSolverMaxConcurrency(env.SOLVER_MAX_CONCURRENCY),
    iterations: parseSolverIterations(env.SOLVER_ITERATIONS),
  });
}
