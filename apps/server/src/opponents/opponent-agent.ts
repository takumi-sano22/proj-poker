// CPU の意思決定を差し替えられる Adapter の境界（docs/03 §2 の Opponent Agent Adapter）。
// Domain（Poker Engine）の外に置き、Orchestrator はこの Interface だけを知る。
// LLM の Opponent に差し替えても、入力は「その Player の KnowledgeState と Legal Action」だけに保つ（D28・D71）。
import type {
  InvalidOutputStage,
  KnowledgeState,
  OutageKind,
  LegalActionSet,
  PlayerAction,
} from "@proj-poker/engine";
import type { Persona } from "./persona.js";

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

/**
 * CPU が判断を返せなかった「障害」の種類（D86）。Hero のダイアログにも出す（内部のエラー本文は出さない）。
 * - timeout: 判断待ちの上限を超えた（Orchestrator が決める）
 * - unauthenticated: 未ログイン・認証切れ
 * - usage_limit: 利用枠の上限
 * - error: それ以外の呼び出しの失敗
 * Emergency Bot への切り替えのきっかけとして EMERGENCY_BOT_ENGAGED の Event にも残すので、型は Engine の Event と共有する（D95）。
 */
export type { OutageKind };

/**
 * 障害の種類が分かっている例外。Agent がこれを投げると Orchestrator はその種類で障害を記録する。
 * それ以外の例外は種類の分からない障害（error）として扱う。
 */
export class OpponentOutageError extends Error {
  constructor(
    message: string,
    readonly outageKind: Exclude<OutageKind, "timeout"> = "error",
  ) {
    super(message);
  }
}

export interface OpponentAgent {
  /**
   * 選んだ Action を返す。形は OpponentOutput を期待するが、LLM の出力は何が来るか分からないので unknown で受け、
   * 呼び出し側（Orchestrator）が Schema → Legal Action → Amount Range の順に検証する（ここを信用しない）。
   * 例外・応答時間の超過は「障害」として扱われ、不正な出力とは区別される（D41・D86）。
   * signal は呼び出し側が結果を待たなくなった（応答時間の超過・アプリ終了）ときに abort される。
   * 外部の処理（LLM の子プロセス等）を持つ実装はこれで中断し、使わない実装は無視してよい。
   */
  decide(input: OpponentInput, signal?: AbortSignal): Promise<unknown>;
}

/**
 * CPU を 1 人分作る。seed は Hand の seed から席ごとに導く（同じ seed なら同じ判断を再現する）。
 * persona はその CPU 自身の Persona（卓の設定で割り当てたもの。#51）。その CPU の Agent の中だけで使い、
 * OpponentInput（KnowledgeState）には入れない（他 CPU の Secret Persona を漏らさない。D28）。
 */
export type OpponentFactory = (
  seed: number,
  playerId: string,
  persona?: Persona,
) => OpponentAgent;
