// Review の Solver Evidence（docs/03 §7 の Solver Capability Check・§8・docs/05 §10）。
// 判断時点の Hero Information Set から AnalysisSpot を組み、Capability Gate（supports）を通ったときだけ Solver を呼ぶ。
// Unsupported（Multiway・Flop・未導入等）・当てはまらない Node・Solver の失敗は正常系として Fallback の理由を残す（Math・Range・KB へ）。
// Solver の結果は HU・抽象化した Bet Tree の近似で、Multiway の Exact GTO として扱わない（不変条件 5）。
import {
  cardToString,
  heroRange,
  villainRange,
  type Card,
  type HeroInformationSet,
  type KnowledgeState,
} from "@proj-poker/engine";
import { DEFAULT_BET_TREE } from "../solver/amaster97-adapter.js";
import { rangeFromModel } from "../solver/spot.js";
import {
  SolverError,
  type AnalysisSpot,
  type SolverAdapter,
  type SolverErrorCode,
  type SpotRange,
} from "../solver/types.js";
import type { SolverEvidenceItem } from "./types.js";

export interface SolverEvidenceOptions {
  readonly signal?: AbortSignal;
  /** Solver の失敗の本文をログに残す（Evidence には決まった文だけを入れる。パス等を Review へ渡さない）。 */
  readonly onFailure?: (error: unknown) => void;
}

/** Multiway 等で Range を組まない Spot に入れる空の Range（supports は Range を見ないので、Unsupported の判定だけに使う）。 */
const NOT_BUILT: SpotRange = {
  combos: [],
  assumption: {
    source: "notation",
    notation: "",
    note: "Solver の対象外（Capability の判定だけに使い、解かない）",
  },
};

/** Solver の失敗を Review へ渡す決まった文（失敗の本文は Evidence に入れない）。 */
const FAILURE_DETAIL: Readonly<Record<SolverErrorCode, string>> = {
  unsupported: "Solver の対象外だった",
  invalid_input: "Solver に渡す Spot を作れなかった",
  timeout: "Solver が上限の時間内に終わらなかった",
  cancelled: "Solver を取り消した",
  process_failed: "Solver が異常終了した",
  parse_failure: "Solver の出力を読めなかった",
};

/**
 * 判断時点の Information Set から Solver Evidence を作る。
 * 1. Capability Gate: Spot の構造（人数・Street・Mode・Rake・Side Pot・Bet Tree・導入の有無）で supports を通す
 * 2. Solver が返すのは Street の最初の判断（OOP）の戦略だけなので、Hero がその Node（その Street でまだ誰も動いていない最初の手番）
 *    のときだけ解く。それ以外（IP・Bet への直面等）は not_applicable
 * 3. analyze の失敗（Timeout・異常終了等）は failed（Fallback）
 */
export async function buildSolverEvidence(
  set: HeroInformationSet,
  solver: SolverAdapter,
  options: SolverEvidenceOptions = {},
): Promise<SolverEvidenceItem> {
  const { knowledge } = set;
  if (knowledge.street === "preflop") {
    return {
      status: "not_applicable",
      reason: "preflop",
      detail:
        "Preflop の判断は Solver の対象外（Range と Math・KB で評価する）",
    };
  }
  const structure = structuralSpot(knowledge);
  const support = solver.supports(structure);
  if (!support.supported) {
    return {
      status: "unsupported",
      reason: support.reason,
      // 未導入の理由（導入先のパス等）は Review へ渡さない。Capability の理由（人数・Street 等）はそのまま前提として渡す。
      detail:
        support.reason === "solver_not_installed"
          ? "Solver が導入されていない"
          : support.detail,
    };
  }
  if (knowledge.actionHistory.some((a) => a.street === knowledge.street)) {
    return {
      status: "not_applicable",
      reason: "not_root_node",
      detail:
        "Solver はその Street の最初の判断（OOP）の戦略だけを返す。この判断はその後の Node（IP・Bet への直面等）なので当てはめない",
    };
  }
  try {
    const evidence = await solver.analyze(
      rootSpot(knowledge, structure),
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const handClass = handClassOf(knowledge.holeCards ?? []);
    return {
      status: "supported",
      id: `solver:${evidence.solver.id}@${evidence.solver.commit.slice(0, 12)}:${set.handId}/d${set.decision.index}`,
      solver: evidence.solver,
      scope: evidence.scope,
      node: evidence.node,
      spot: {
        street: evidence.spot.street,
        board: evidence.spot.board,
        pot: evidence.spot.pot,
        effectiveStack: evidence.spot.effectiveStack,
      },
      betTree: evidence.betTree,
      strategy: evidence.strategy,
      heroHandClass: handClass,
      heroHandClassStrategy: evidence.byHandClass[handClass] ?? null,
      ev: evidence.ev,
      convergence: {
        iterations: evidence.convergence.iterations,
        note: evidence.convergence.note,
      },
      rangeAssumptions: evidence.rangeAssumptions,
      assumptions: [
        ...evidence.assumptions,
        `heroHandClassStrategy は Hand Class ${handClass}（Suit の組を区別しない）の Combo を合わせた頻度で、Hero の実際の 2 枚だけの頻度ではない。`,
      ],
      warnings: evidence.warnings,
    };
  } catch (error) {
    options.onFailure?.(error);
    const code: SolverErrorCode =
      error instanceof SolverError ? error.code : "process_failed";
    return { status: "failed", code, detail: FAILURE_DETAIL[code] };
  }
}

/** Spot の構造（Capability の判定に使う値）。Range はまだ組まない。 */
function structuralSpot(knowledge: KnowledgeState): AnalysisSpot {
  const active = knowledge.seats.filter((s) => !s.folded);
  const maxCommitted = Math.max(...active.map((s) => s.totalCommitted));
  return {
    street: knowledge.street,
    // Fold していない人数（All-in 済みの Player も数える）。
    playerCount: active.length,
    // 全額を出せずに All-in した Player がいれば、Pot ごとに参加資格が違う（Side Pot）。
    sidePot: active.some((s) => s.allIn && s.totalCommitted < maxCommitted),
    mode: "cash",
    board: knowledge.board,
    pot: knowledge.pot,
    effectiveStack: knowledge.math.effectiveStack,
    // Phase 1 の Preset に Rake は無い（Rule Profile に Rake の設定が入ったら、ここをその値にする）。
    rakeRate: 0,
    ranges: { oop: NOT_BUILT, ip: NOT_BUILT },
    betTree: DEFAULT_BET_TREE,
    assumptions: [],
  };
}

/**
 * Hero がその Street の最初の手番（OOP）のときの Spot。Street の中でまだ誰も動いていないので、判断時点の Pot・有効 Stack・
 * 相手の Range（#79 の Range Model）は Street の開始時点の値と同じ。Hero 側の Range は相手から見た Hero の Range（heroRange）。
 */
function rootSpot(
  knowledge: KnowledgeState,
  structure: AnalysisSpot,
): AnalysisSpot {
  const villain = knowledge.seats.find(
    (s) => s.playerId !== knowledge.viewerId && !s.folded,
  );
  if (villain === undefined) {
    throw new SolverError("invalid_input", "相手がいない");
  }
  return {
    ...structure,
    ranges: {
      oop: rangeFromModel(heroRange(knowledge)),
      ip: rangeFromModel(villainRange(knowledge, villain.playerId)),
    },
    assumptions: [
      "Hero（OOP）の Range は、相手から見た Hero の Range（Position と公開された Action の列から仮定した標準の Range）。Hero の実際の札は Range の 1 つとして扱う。",
      "相手（IP）の Range は Range Model の標準の想定で、Hero の札を除いてある（Card Removal）。",
    ],
  };
}

/** Hole Cards 2 枚の Hand Class（Solver の per_class のキーと同じ表記: "AKs" / "AKo" / "TT"）。 */
export function handClassOf(cards: readonly Card[]): string {
  const [a, b] = cards;
  if (a === undefined || b === undefined) return "";
  const [high, low] = a.rank >= b.rank ? [a, b] : [b, a];
  const h = cardToString(high).charAt(0);
  const l = cardToString(low).charAt(0);
  if (high.rank === low.rank) return `${h}${l}`;
  return `${h}${l}${high.suit === low.suit ? "s" : "o"}`;
}
