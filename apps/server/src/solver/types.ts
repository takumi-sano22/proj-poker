// Solver Adapter の型（docs/03 §8・docs/research/05 §2 / §5）。Adapter の外から見えるのはこの形だけで、
// Solver 固有の入出力（amaster97 の JSON 等）は Adapter の中で正規化する（Review AI へ直接渡さない）。
import type { Card, Combo, RangeAssumption, Street } from "@proj-poker/engine";

/** Solver が扱える範囲（Capability Envelope。docs/research/05 §2）。実測で動いた範囲だけを宣言する。 */
export interface SolverCapability {
  readonly playerCounts: readonly number[];
  readonly streets: readonly Street[];
  readonly modes: readonly ("cash" | "tournament")[];
  readonly rakeSupport: boolean;
  readonly icmSupport: boolean;
  readonly sidePotSupport: boolean;
}

/**
 * Bet Tree（全 Street・両者で同じ）。Bet は Pot に対する割合、Raise は直前の Bet の倍数（amaster97 の定義）。
 * 例: 50% pot の Bet・3 倍の Raise（初回の Raise は 50% pot-after-call と同じ額）・All-in あり・1 Street の攻撃 4 回まで。
 */
export interface BetTree {
  readonly betPotFractions: readonly number[];
  readonly raiseMultipliers: readonly number[];
  readonly allIn: boolean;
  /** 1 Street あたりの Bet / Raise の回数の上限（Bet を含む）。 */
  readonly raiseCap: number;
}

/** Solver に渡す Range が何を仮定したものか。Evidence にそのまま残す（Range は推定で、実際の札ではない）。 */
export type SpotRangeAssumption =
  | {
      /** #79 の Range Model（判断時点の KnowledgeState から仮定した Range）。 */
      readonly source: "range_model";
      readonly model: RangeAssumption;
    }
  | {
      /** Range の表記から作った Range（Board と衝突する Combo は除いてある）。 */
      readonly source: "notation";
      readonly notation: string;
      /** なぜこの Range を仮定したか（例: 「Hero の Range は CO Open の標準 Range と仮定」）。 */
      readonly note: string;
    };

export interface SpotRange {
  readonly combos: readonly Combo[];
  readonly assumption: SpotRangeAssumption;
}

/** 解きたい Spot（正規化した Solver Request。docs/research/05 §5）。額は Chip の最小単位の整数（D74）。 */
export interface AnalysisSpot {
  readonly street: Street;
  /** この Street の開始時点で Hand に残っている人数（Fold していない人数。All-in 済みの Player も数える）。 */
  readonly playerCount: number;
  /**
   * この Street の時点で Side Pot があるか（Pot ごとに参加資格が違う）。Solver は単一の Pot しか解けないので、
   * あれば Unsupported にする（人数を誤って数えても Pot 全額を単一の Pot として解かないための明示の印）。
   */
  readonly sidePot: boolean;
  readonly mode: "cash" | "tournament";
  /** 判断時点の Board（Street に応じた枚数）。 */
  readonly board: readonly Card[];
  /** Street 開始時の Pot。 */
  readonly pot: number;
  /** Street 開始時の Effective Stack（両者の残りの少ない方）。 */
  readonly effectiveStack: number;
  /** Rake の割合（0 = なし）。 */
  readonly rakeRate: number;
  /** Postflop の位置ごとの Range。OOP が先に行動する。 */
  readonly ranges: { readonly oop: SpotRange; readonly ip: SpotRange };
  readonly betTree: BetTree;
  /**
   * 呼び出し側の前提（例: Multiway だった Hand を HU に絞った・Prior Action・Card Removal・Bunching の扱い）。
   * Evidence の assumptions にそのまま載せ、Review に表示する（docs/research/05 §4）。
   */
  readonly assumptions: readonly string[];
}

/** Unsupported の理由。Unsupported は Error ではなく正常系（Math + Range + KB + Review AI へ Fallback する）。 */
export type UnsupportedReason =
  | "player_count"
  | "street"
  | "mode"
  | "rake"
  | "side_pot"
  | "bet_tree"
  | "solver_not_installed";

/** Unsupported のときに代わりに使う Evidence（docs/research/05 §4・OI-009）。 */
export const SOLVER_FALLBACK = [
  "math",
  "range_analysis",
  "kb",
  "review_ai",
] as const;

export type SupportResult =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason: UnsupportedReason;
      /** 人が読む理由（Review の Assumption 表示に使える）。 */
      readonly detail: string;
      readonly fallback: typeof SOLVER_FALLBACK;
    };

export interface SolveOptions {
  /** 1 回の Solve の上限（ミリ秒）。省略時は Config の既定値。待ち行列で待つ時間は含めない。 */
  readonly timeoutMs?: number;
  /** Hand 終了・Session 終了・ユーザー操作で止める。待ち行列で待っている間も効く。 */
  readonly signal?: AbortSignal;
  /** Iteration 数。省略時は Config の既定値。 */
  readonly iterations?: number;
}

/** Root で選べる行動（OOP の最初の判断）。 */
export type SolverAction =
  | { readonly kind: "check" }
  | { readonly kind: "bet"; readonly potFraction: number }
  | { readonly kind: "all_in"; readonly amount: number };

export interface SolverActionFrequency {
  /** 行動の識別子（"check" / "bet_50" / "all_in"）。byHandClass のキーと同じ。 */
  readonly key: string;
  readonly action: SolverAction;
  readonly frequency: number;
}

/** 正規化した Solver の結果（docs/research/05 §5 の Normalized Result）。Review の Evidence の 1 つ。 */
export interface SolverEvidence {
  readonly kind: "solver";
  /** Version Metadata。commit は導入時に固定した値（install.json）。 */
  readonly solver: {
    readonly id: string;
    readonly repository: string;
    readonly version: string;
    readonly commit: string;
    /** Adapter が想定する固定 commit と一致するか（一致しなければ warnings にも載せる）。 */
    readonly pinnedCommit: boolean;
  };
  /** HU の Solver の結果。Multiway の Exact GTO ではない（不変条件 5）。 */
  readonly scope: "heads_up";
  /** 戦略を取った Node。Root（Street の最初の判断で、OOP が行動する）だけ。 */
  readonly node: { readonly street: Street; readonly actor: "oop" };
  readonly spot: {
    readonly street: Street;
    readonly board: readonly string[];
    readonly pot: number;
    readonly effectiveStack: number;
    readonly playerCount: number;
    readonly sidePot: boolean;
    readonly rakeRate: number;
  };
  readonly betTree: BetTree;
  /** Root の Range 全体の行動頻度（OOP の Range の Combo 数で重み付け）。 */
  readonly strategy: readonly SolverActionFrequency[];
  /** Root の Hand Class（"AKs" 等）ごとの行動頻度（キーは strategy の key）。 */
  readonly byHandClass: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  /** Action EV。今の呼び出し経路では取れないので、推測で埋めず「取れない」と明示する（#76）。 */
  readonly ev: { readonly available: false; readonly reason: string };
  /** 収束の目安。exploitability は計算しない（Turn で数分かかる。#76）ので Iteration 数で持つ。 */
  readonly convergence: {
    readonly iterations: number;
    readonly exploitability: null;
    readonly note: string;
  };
  /** Solver に渡した Range の Assumption（Range Assumption の保持。docs/09 §7）。 */
  readonly rangeAssumptions: {
    readonly oop: SpotRangeAssumption & { readonly comboCount: number };
    readonly ip: SpotRangeAssumption & { readonly comboCount: number };
  };
  /** Review に表示する前提（HU であること・Bet Tree の定義・呼び出し側の前提）。 */
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
  readonly stats: {
    /** 子プロセスの起動から終了まで（ミリ秒）。 */
    readonly wallMs: number;
    readonly decisionNodes: number;
  };
}

/** analyze の失敗の種類。Unsupported（supports の正常系）とは別に扱う（docs/09 §7）。 */
export type SolverErrorCode =
  /** supports を通さずに analyze を呼んだ（呼び出し側の誤り）。 */
  | "unsupported"
  /** 入力が不正（不正なカード・Range・負の Pot 等）。Solver には渡していない。 */
  | "invalid_input"
  | "timeout"
  | "cancelled"
  /** Solver が異常終了した（exit が 0 でない・起動できない）。 */
  | "process_failed"
  /** Solver の出力が読めない・形が違う。 */
  | "parse_failure";

export class SolverError extends Error {
  constructor(
    readonly code: SolverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SolverError";
  }
}

export interface SolverAdapter {
  capabilities(): SolverCapability;
  supports(spot: AnalysisSpot): SupportResult;
  analyze(spot: AnalysisSpot, options?: SolveOptions): Promise<SolverEvidence>;
}
