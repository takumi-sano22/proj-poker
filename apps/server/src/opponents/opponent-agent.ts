// CPU の意思決定を差し替えられる Adapter の境界（docs/03 §2 の Opponent Agent Adapter）。
// Domain（Poker Engine）の外に置き、Orchestrator はこの Interface だけを知る。
// 将来 LLM の Opponent に差し替えても、入力は「その Player の KnowledgeState と Legal Action」だけに保つ（D28・D71）。
import type {
  KnowledgeState,
  LegalActionSet,
  PlayerAction,
} from "@proj-poker/engine";

/** CPU に渡す入力。global な HandState・他者の Hole Cards・Deck は型の上でも渡せない。 */
export interface OpponentInput {
  /** projectKnowledgeState の結果（その CPU に見える Event だけを畳み込み、Position・Math を足したもの）。 */
  readonly knowledge: KnowledgeState;
  /** 今の手番の Legal Action（Engine が計算したもの。D40）。 */
  readonly legal: LegalActionSet;
}

export interface OpponentAgent {
  /** 選んだ Action を返す。合法性は呼び出し側が Engine で検証する（ここを信用しない）。 */
  decide(input: OpponentInput): PlayerAction;
}

/** CPU を 1 人分作る。seed は Hand の seed から席ごとに導く（同じ seed なら同じ判断を再現する）。 */
export type OpponentFactory = (seed: number, playerId: string) => OpponentAgent;
