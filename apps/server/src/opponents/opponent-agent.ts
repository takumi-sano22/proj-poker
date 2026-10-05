// CPU の意思決定を差し替えられる Adapter の境界（docs/03 §2 の Opponent Agent Adapter）。
// Domain（Poker Engine）の外に置き、Orchestrator はこの Interface だけを知る。
// LLM の Opponent に差し替えても、入力は「その Player の KnowledgeState と Legal Action」だけに保つ（D28・D71）。
import type {
  InvalidOutputStage,
  KnowledgeState,
  LegalActionSet,
  PlayerAction,
} from "@proj-poker/engine";

/** 出力の検証で不正と判定した段。AI_ACTION_INVALID の Event にも残すので、型は Engine の Event と共有する（D83）。 */
export type { InvalidOutputStage };

/** 前回の出力が不正だった理由。再要求（Retry）のときだけ渡す（D41）。 */
export interface OpponentCorrection {
  readonly stage: InvalidOutputStage;
  readonly reason: string;
}

/** CPU に渡す入力。global な HandState・他者の Hole Cards・Deck は型の上でも渡せない。 */
export interface OpponentInput {
  /** projectKnowledgeState の結果（その CPU に見える Event だけを畳み込み、Position・Math を足したもの）。 */
  readonly knowledge: KnowledgeState;
  /** 今の手番の Legal Action（Engine が計算したもの。D40）。 */
  readonly legal: LegalActionSet;
  /** 直前の出力が不正だったときの理由。最初の要求には付かない。 */
  readonly correction?: OpponentCorrection;
}

/**
 * CPU に期待する出力の形（docs/05 §1: Action・必要なら Amount・任意の短い Rationale）。
 * amount は bet / raise だけが持ち、この Street の累計（to 額）。
 */
export interface OpponentOutput {
  readonly action: PlayerAction["type"];
  readonly amount?: number;
  readonly rationale?: string;
}

export interface OpponentAgent {
  /**
   * 選んだ Action を返す。形は OpponentOutput を期待するが、LLM の出力は何が来るか分からないので unknown で受け、
   * 呼び出し側（Orchestrator）が Schema → Legal Action → Amount Range の順に検証する（ここを信用しない）。
   * 例外・応答時間の超過は「障害」として扱われ、不正な出力とは区別される（D41・D86）。
   */
  decide(input: OpponentInput): Promise<unknown>;
}

/** CPU を 1 人分作る。seed は Hand の seed から席ごとに導く（同じ seed なら同じ判断を再現する）。 */
export type OpponentFactory = (seed: number, playerId: string) => OpponentAgent;
