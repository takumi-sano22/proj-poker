// Primary Solver（amaster97/poker_solver。D96）の Solver Adapter（docs/03 §8。#81）。
// Capability は #76 の PoC で動いた HU の River / Turn だけを宣言し、Flop・Multiway・未導入は Unsupported（正常系）にする。
// Solver は Python ライブラリ（Rust 拡張）なので、solver/amaster97_runner.py を子プロセスで動かし、stdin / stdout の JSON でやり取りする。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardToString, type Combo } from "@proj-poker/engine";
import { runProcess, type ProcessCommand } from "./process.js";
import { validateSpot } from "./spot.js";
import {
  SOLVER_FALLBACK,
  SolverError,
  type AnalysisSpot,
  type BetTree,
  type SolveOptions,
  type SolverAction,
  type SolverActionFrequency,
  type SolverAdapter,
  type SolverCapability,
  type SolverEvidence,
  type SupportResult,
  type UnsupportedReason,
} from "./types.js";

export const AMASTER97_SOLVER_ID = "amaster97/poker_solver";

/** 想定する固定 commit（solver/setup-amaster97.sh と同じ値。#76 で計測した版）。 */
export const AMASTER97_PINNED_COMMIT =
  "f78f1b2bc338dd8cbb5226ecb8398bbdb3635676";

/** 実測で動いた範囲（#76・D96）。Flop は動いたが 13 分・16.9 GB のため宣言しない。Rake は非 0 で ValueError を実測。 */
export const AMASTER97_CAPABILITY: SolverCapability = {
  playerCounts: [2],
  streets: ["turn", "river"],
  modes: ["cash"],
  rakeSupport: false,
  icmSupport: false,
  sidePotSupport: false,
};

/** #76 の計測と同じ Bet Tree（50% pot の Bet・3 倍の Raise・All-in・1 Street 4 回まで）。 */
export const DEFAULT_BET_TREE: BetTree = {
  betPotFractions: [0.5],
  raiseMultipliers: [3],
  allIn: true,
  raiseCap: 4,
};

/** amaster97 の Bet Size と Raise 倍率は各 5 種まで（HUNLConfig の制約）。攻撃回数は計測した 4 回までにする。 */
const MAX_BET_SIZES = 5;
const MAX_RAISE_SIZES = 5;
const MAX_RAISE_CAP = 4;

/**
 * Solver に渡す額の倍率。amaster97 は額を整数で扱い Bet Size を丸めるので、Chip（BB = 2 の最小単位）のままだと
 * 50% pot 等の額が粗くなる。Chip × 100 にして渡す（Root の戦略は Pot に対する比だけで決まり、倍率に依らない）。
 */
const CHIP_SCALE = 100;

/** runner の入出力の形の版（amaster97_runner.py の PROTOCOL と同じ値）。 */
const PROTOCOL = 1;

/** 同じリポジトリの runner。src からも dist からも 2 階層上の apps/server/solver にある。 */
export const AMASTER97_RUNNER_PATH = fileURLToPath(
  new URL("../../solver/amaster97_runner.py", import.meta.url),
);

/** 導入先の install.json（setup-amaster97.sh が書く）。Version Metadata の正本。 */
export interface Amaster97Install {
  readonly repository: string;
  readonly commit: string;
  readonly version: string;
  readonly python: string;
}

export type InstallState =
  | { readonly installed: true; readonly info: Amaster97Install }
  | { readonly installed: false; readonly detail: string };

/** POKER_SOLVER_HOME の install.json と Python を確かめる。無い・壊れているなら未導入（理由つき）。 */
export function detectAmaster97Install(home: string | null): InstallState {
  if (home === null) {
    return {
      installed: false,
      detail:
        "POKER_SOLVER_HOME が未設定（solver/setup-amaster97.sh で導入する）",
    };
  }
  const path = join(home, "install.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      installed: false,
      detail: `install.json を読めない: ${path}（${(error as Error).message}）`,
    };
  }
  const r = raw as Record<string, unknown>;
  const fields = ["repository", "commit", "version", "python"] as const;
  if (
    typeof raw !== "object" ||
    raw === null ||
    r.solver !== AMASTER97_SOLVER_ID ||
    fields.some((f) => typeof r[f] !== "string" || r[f] === "") ||
    !/^[0-9a-f]{40}$/.test(r.commit as string)
  ) {
    return {
      installed: false,
      detail: `install.json の形が違う: ${path}`,
    };
  }
  const info: Amaster97Install = {
    repository: r.repository as string,
    commit: r.commit as string,
    version: r.version as string,
    python: r.python as string,
  };
  if (!existsSync(info.python)) {
    return {
      installed: false,
      detail: `Solver の Python が無い: ${info.python}`,
    };
  }
  return { installed: true, info };
}

export interface Amaster97AdapterConfig {
  readonly install: InstallState;
  /** 1 回の Solve の既定の上限（ミリ秒）。 */
  readonly timeoutMs: number;
  /** 同時に動かす Solver の数の上限。超えた分は待ち行列で待つ。 */
  readonly maxConcurrency: number;
  /** 既定の Iteration 数。 */
  readonly iterations: number;
  /** 子プロセスの起動方法。既定は導入先の Python で runner を動かす（テストは偽の Solver を渡す）。 */
  readonly command?: ProcessCommand;
}

/** Iteration 数の上限（誤って巨大な値を渡して CPU を占有し続けないため）。 */
const MAX_ITERATIONS = 100_000;

export function createAmaster97Adapter(
  config: Amaster97AdapterConfig,
): SolverAdapter {
  if (
    !Number.isSafeInteger(config.maxConcurrency) ||
    config.maxConcurrency < 1
  ) {
    throw new RangeError(`同時実行数は 1 以上の整数: ${config.maxConcurrency}`);
  }
  const limiter = new Limiter(config.maxConcurrency);

  function supports(spot: AnalysisSpot): SupportResult {
    const reason = unsupportedReason(spot, config.install);
    if (reason === null) return { supported: true };
    return {
      supported: false,
      reason: reason.reason,
      detail: reason.detail,
      fallback: SOLVER_FALLBACK,
    };
  }

  async function analyze(
    spot: AnalysisSpot,
    options: SolveOptions = {},
  ): Promise<SolverEvidence> {
    // 不正な入力は Capability の判定より先に弾く（壊れた Spot を Unsupported の Fallback に紛れさせない。docs/09 §7）。
    // Solver にも渡さない（#76: Board の重複・Board と衝突する手を Solver は弾かない）。
    const errors = validateSpot(spot);
    const timeoutMs = options.timeoutMs ?? config.timeoutMs;
    const iterations = options.iterations ?? config.iterations;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      errors.push(`timeoutMs は正の整数: ${timeoutMs}`);
    }
    if (
      !Number.isSafeInteger(iterations) ||
      iterations <= 0 ||
      iterations > MAX_ITERATIONS
    ) {
      errors.push(`iterations は 1〜${MAX_ITERATIONS} の整数: ${iterations}`);
    }
    if (errors.length > 0) {
      throw new SolverError("invalid_input", errors.join(" / "));
    }

    // supports を通らない Spot は解かない（呼び出し側が supports を先に呼ぶ約束。ここでも二重に確かめる）。
    const support = supports(spot);
    if (!support.supported) {
      throw new SolverError("unsupported", support.detail);
    }
    if (!config.install.installed) {
      throw new SolverError("unsupported", config.install.detail);
    }
    const install = config.install.info;

    const request = buildRequest(spot, iterations);
    const command = config.command ?? {
      file: install.python,
      args: [AMASTER97_RUNNER_PATH],
    };

    // 同時実行数の枠を取ってから動かす（待っている間も Cancel が効く）。Timeout は枠を取ってからの Solve の時間に掛ける。
    const release = await limiter.acquire(options.signal);
    let outcome;
    try {
      outcome = await runProcess(command, JSON.stringify(request), {
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } finally {
      release();
    }

    switch (outcome.kind) {
      case "timeout":
        throw new SolverError(
          "timeout",
          `Solver が ${timeoutMs}ms で終わらなかった（止めた。結果なし）`,
        );
      case "cancelled":
        throw new SolverError("cancelled", "Solver を取り消した（結果なし）");
      case "failed":
        throw new SolverError(
          "process_failed",
          `Solver を動かせない: ${outcome.message}`,
        );
      case "exited":
        if (outcome.code !== 0) {
          throw new SolverError(
            "process_failed",
            `Solver が異常終了した（exit ${outcome.code ?? "なし"}・signal ${outcome.signal ?? "なし"}）: ${tail(outcome.stderr)}`,
          );
        }
        return toEvidence(
          parseOutput(outcome.stdout, spot),
          spot,
          install,
          outcome.wallMs,
        );
    }
  }

  return {
    capabilities: () => AMASTER97_CAPABILITY,
    supports,
    analyze,
  };
}

/** Capability と Spot を照らして Unsupported の理由を返す（対応していれば null）。Capability を先に、導入の有無を最後に見る。 */
function unsupportedReason(
  spot: AnalysisSpot,
  install: InstallState,
): { reason: UnsupportedReason; detail: string } | null {
  const cap = AMASTER97_CAPABILITY;
  if (!cap.playerCounts.includes(spot.playerCount)) {
    return {
      reason: "player_count",
      detail: `Solver は HU（2 人）だけを解く。${spot.playerCount} 人の Spot は Math・Range・KB で代える（HU Solver の結果を Multiway の Exact GTO として扱わない。OI-009）`,
    };
  }
  if (!cap.streets.includes(spot.street)) {
    return {
      reason: "street",
      detail: `Solver は Turn と River だけを解く（D96）。${spot.street} は Math・Range・KB で代える`,
    };
  }
  if (!cap.modes.includes(spot.mode)) {
    return {
      reason: "mode",
      detail: `Solver は Cash だけを解く（ICM は扱わない）: ${spot.mode}`,
    };
  }
  if (spot.rakeRate > 0) {
    return {
      reason: "rake",
      detail:
        "Solver は Rake を扱えない（Rake ありの Spot は Math・Range・KB で代える）",
    };
  }
  const tree = spot.betTree;
  const percents = tree.betPotFractions.map((f) => Math.round(f * 100));
  if (
    tree.betPotFractions.length < 1 ||
    tree.betPotFractions.length > MAX_BET_SIZES ||
    tree.raiseMultipliers.length < 1 ||
    tree.raiseMultipliers.length > MAX_RAISE_SIZES ||
    tree.raiseCap > MAX_RAISE_CAP ||
    new Set(percents).size !== percents.length
  ) {
    return {
      reason: "bet_tree",
      detail: `Solver が表せない Bet Tree（Bet Size 1〜${MAX_BET_SIZES} 種で % が重ならない・Raise 倍率 1〜${MAX_RAISE_SIZES} 種・攻撃 ${MAX_RAISE_CAP} 回まで）`,
    };
  }
  if (!install.installed) {
    return { reason: "solver_not_installed", detail: install.detail };
  }
  return null;
}

/** runner へ渡す入力（amaster97_runner.py が読む形）。 */
interface Amaster97Request {
  readonly protocol: number;
  readonly street: "turn" | "river";
  readonly board: readonly string[];
  readonly pot: number;
  readonly effective_stack: number;
  readonly bet_tree: {
    readonly bet_pot_fractions: readonly number[];
    readonly raise_multipliers: readonly number[];
    readonly all_in: boolean;
    readonly raise_cap: number;
  };
  readonly ranges: {
    readonly oop: readonly string[];
    readonly ip: readonly string[];
  };
  readonly iterations: number;
}

function buildRequest(
  spot: AnalysisSpot,
  iterations: number,
): Amaster97Request {
  const combo = ([a, b]: Combo) => `${cardToString(a)}${cardToString(b)}`;
  return {
    protocol: PROTOCOL,
    street: spot.street as "turn" | "river",
    board: spot.board.map(cardToString),
    pot: spot.pot * CHIP_SCALE,
    effective_stack: spot.effectiveStack * CHIP_SCALE,
    bet_tree: {
      bet_pot_fractions: spot.betTree.betPotFractions,
      raise_multipliers: spot.betTree.raiseMultipliers,
      all_in: spot.betTree.allIn,
      raise_cap: spot.betTree.raiseCap,
    },
    ranges: {
      oop: spot.ranges.oop.combos.map(combo),
      ip: spot.ranges.ip.combos.map(combo),
    },
    iterations,
  };
}

/** runner の出力を読んだもの。 */
interface ParsedOutput {
  readonly solverVersion: string;
  readonly iterations: number;
  readonly decisionNodes: number;
  readonly strategy: readonly SolverActionFrequency[];
  readonly byHandClass: Record<string, Record<string, number>>;
  readonly warnings: readonly string[];
}

/** 頻度の合計が 1 から外れてよい幅（浮動小数の誤差）。 */
const FREQUENCY_TOLERANCE = 1e-3;

/**
 * runner の stdout を読む。JSON として読めても、形・行動のラベル・頻度が想定と違えば parse_failure にする
 * （「読めた = 正しい」にしない。#76）。
 */
function parseOutput(stdout: string, spot: AnalysisSpot): ParsedOutput {
  const fail = (why: string): never => {
    throw new SolverError("parse_failure", `Solver の出力を読めない: ${why}`);
  };
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail(`JSON ではない（${tail(line, 120)}）`);
  }
  if (typeof raw !== "object" || raw === null) return fail("object ではない");
  const o = raw as Record<string, unknown>;
  if (o.protocol !== PROTOCOL)
    return fail(`protocol が違う: ${String(o.protocol)}`);
  if (typeof o.solver_version !== "string")
    return fail("solver_version が無い");
  if (!isPositiveInt(o.iterations)) return fail("iterations が不正");
  if (!Number.isSafeInteger(o.decision_nodes))
    return fail("decision_nodes が不正");
  if (o.root_actor !== "oop")
    return fail(`root_actor が oop ではない: ${String(o.root_actor)}`);
  if (
    !Array.isArray(o.warnings) ||
    o.warnings.some((w) => typeof w !== "string")
  ) {
    return fail("warnings が不正");
  }

  const aggregate = readDistribution(o.range_aggregate);
  if (aggregate === null) {
    return fail(
      "range_aggregate が不正（空・範囲外の頻度・合計が 1 ではない）",
    );
  }
  const strategy: SolverActionFrequency[] = [];
  for (const [key, frequency] of Object.entries(aggregate)) {
    const action = actionOf(key, spot);
    if (action === null) return fail(`知らない行動のラベル: ${key}`);
    strategy.push({ key, action, frequency });
  }

  if (
    typeof o.per_class !== "object" ||
    o.per_class === null ||
    Array.isArray(o.per_class) ||
    Object.keys(o.per_class).length === 0
  ) {
    return fail("per_class が不正（空）");
  }
  // Hand Class ごとも Range 全体と同じ基準で確かめる（Review が Hero の Hand Class の頻度を引くため、不完全な戦略を通さない）。
  const byHandClass: Record<string, Record<string, number>> = {};
  for (const [handClass, value] of Object.entries(o.per_class)) {
    const freqs = readDistribution(value);
    if (freqs === null || Object.keys(freqs).some((k) => !(k in aggregate))) {
      return fail(
        `per_class の ${handClass} が不正（空・範囲外の頻度・合計が 1 ではない・知らない行動）`,
      );
    }
    byHandClass[handClass] = freqs;
  }

  return {
    solverVersion: o.solver_version,
    iterations: o.iterations as number,
    decisionNodes: o.decision_nodes as number,
    strategy,
    byHandClass,
    warnings: o.warnings as string[],
  };
}

/**
 * 行動の確率分布 { ラベル: 頻度 } を読む。空でなく、頻度は 0〜1 の有限の数で、合計が 1（誤差の幅は許す）でなければ null。
 * Range 全体（range_aggregate）と Hand Class ごと（per_class）の両方に使う。
 */
function readDistribution(value: unknown): Record<string, number> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [key, f] of Object.entries(value)) {
    if (
      typeof f !== "number" ||
      !Number.isFinite(f) ||
      f < 0 ||
      f > 1 + FREQUENCY_TOLERANCE
    ) {
      return null;
    }
    out[key] = f;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  return Math.abs(sum - 1) <= FREQUENCY_TOLERANCE ? out : null;
}

/** amaster97 の行動ラベル（"check" / "bet_50" / "all_in"）を正規化した行動にする。Root（OOP の最初の判断）にあり得ないものは null。 */
function actionOf(key: string, spot: AnalysisSpot): SolverAction | null {
  if (key === "check") return { kind: "check" };
  if (key === "all_in") {
    return spot.betTree.allIn
      ? { kind: "all_in", amount: spot.effectiveStack }
      : null;
  }
  const bet = /^bet_(\d+)$/.exec(key);
  if (bet === null) return null;
  const percent = Number(bet[1]);
  const fraction = spot.betTree.betPotFractions.find(
    (f) => Math.round(f * 100) === percent,
  );
  return fraction === undefined ? null : { kind: "bet", potFraction: fraction };
}

function toEvidence(
  out: ParsedOutput,
  spot: AnalysisSpot,
  install: Amaster97Install,
  wallMs: number,
): SolverEvidence {
  const pinnedCommit = install.commit === AMASTER97_PINNED_COMMIT;
  const warnings = [...out.warnings];
  if (!pinnedCommit) {
    warnings.push(
      `Solver の commit が固定した版と違う: ${install.commit}（想定 ${AMASTER97_PINNED_COMMIT}）`,
    );
  }
  if (out.solverVersion !== install.version) {
    warnings.push(
      `Solver の版が install.json と違う: ${out.solverVersion}（install.json ${install.version}）`,
    );
  }
  const tree = spot.betTree;
  const assumptions = [
    "HU（2 人）の Solver の結果。Multiway の Exact GTO ではない",
    `Bet Tree は抽象化したもの: Bet ${tree.betPotFractions.map((f) => `${Math.round(f * 100)}%`).join("・")} pot / Raise は直前の Bet の ${tree.raiseMultipliers.join("・")} 倍 / All-in ${tree.allIn ? "あり" : "なし"} / 1 Street の攻撃 ${tree.raiseCap} 回まで`,
    "Rake なし",
    "Street の最初の判断（OOP）の戦略だけ",
    "両者の Range は推定（rangeAssumptions）で、実際の札ではない",
    ...spot.assumptions,
  ];
  return {
    kind: "solver",
    solver: {
      id: AMASTER97_SOLVER_ID,
      repository: install.repository,
      version: out.solverVersion,
      commit: install.commit,
      pinnedCommit,
    },
    scope: "heads_up",
    node: { street: spot.street, actor: "oop" },
    spot: {
      street: spot.street,
      board: spot.board.map(cardToString),
      pot: spot.pot,
      effectiveStack: spot.effectiveStack,
      playerCount: spot.playerCount,
      rakeRate: spot.rakeRate,
    },
    betTree: tree,
    strategy: out.strategy,
    byHandClass: out.byHandClass,
    ev: {
      available: false,
      reason:
        "今の呼び出し経路（solve_range_vs_range_nash）は Action EV を返さない（#76）。推測で埋めない",
    },
    convergence: {
      iterations: out.iterations,
      exploitability: null,
      note: "exploitability は計算していない（Turn で数分かかるため。#76）。収束の目安は Iteration 数",
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
    assumptions,
    warnings,
    stats: { wallMs, decisionNodes: out.decisionNodes },
  };
}

function isPositiveInt(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** 長い stderr / stdout の末尾だけを残す（エラーメッセージ用）。 */
function tail(text: string, max = 500): string {
  const t = text.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

/** 同時実行数の上限。枠が空くまで待ち、待っている間に Cancel されたら待ち行列から外して cancelled にする。 */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(
        new SolverError("cancelled", "Solver を取り消した（結果なし）"),
      );
    }
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiting.indexOf(start);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(
          new SolverError(
            "cancelled",
            "Solver を取り消した（待ち行列で。結果なし）",
          ),
        );
      };
      const start = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve(this.releaser());
      };
      this.waiting.push(start);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 1 回だけ効く release（二重に呼んでも枠を余計に空けない）。 */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}
