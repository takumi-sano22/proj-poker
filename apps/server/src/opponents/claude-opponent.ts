// Claude の Opponent Agent（Model Adapter。docs/03 §3・D87）。
// Claude Agent SDK の query() を「1 回の判断」として使い、ローカルでログイン済みの Claude Code の OAuth（サブスク枠）で呼ぶ。API キーは使わない。
// 渡すのはその CPU の KnowledgeState・Legal Action・Persona だけ（D28・docs/05 §1）。出力の検証・Retry・Fallback は Orchestrator（D40・D41）。
// ログイン切れ・利用枠の上限・子プロセスの失敗は例外（＝障害。D86）にし、形の崩れた出力は不正な出力として Orchestrator の検証に回す。
import { cardToString, type Card } from "@proj-poker/engine";
import {
  ClaudeCallError,
  runStructuredQuery,
  type ClaudeQuery,
} from "../claude/structured-query.js";
import {
  OpponentOutageError,
  type OpponentAgent,
  type OpponentFactory,
  type OpponentInput,
} from "./opponent-agent.js";
import { describePersona } from "./persona.js";

// 呼び出しの共通部分（#82 で claude/structured-query.ts へ切り出した）。既存の import 先を変えないよう、ここからも出す。
export {
  API_BILLING_ENV_KEYS,
  buildClaudeEnv,
  outageKindOf,
  type ClaudeQuery,
} from "../claude/structured-query.js";

export interface ClaudeOpponentOptions {
  /** 具体モデル名。role-based config（MODEL_ROLES.opponent_fast）から渡す。 */
  readonly model: string;
  /** 子プロセスの環境。buildClaudeEnv の結果を渡す。 */
  readonly env: Record<string, string>;
  /** CPU の性格付け（docs/05 §2）を Prompt 用の文章にしたもの（describePersona の結果）。空なら Prompt に入れない。 */
  readonly persona?: string;
  /** 省略時は SDK の query()。 */
  readonly query?: ClaudeQuery;
}

/** Claude の呼び出しが判断を返せなかった（障害）。Orchestrator は例外を障害として Hand を止める（D86）。 */
export class ClaudeOpponentError extends OpponentOutageError {
  override readonly name = "ClaudeOpponentError";
}

const SYSTEM_PROMPT = [
  "あなたはノーリミット・テキサスホールデム（キャッシュゲーム）の卓に座る 1 人のプレイヤーです。",
  "渡された「あなたに見えている情報」と「選べる Action」だけを使い、自分の手番の Action を 1 つ選んでください。",
  "答えは StructuredOutput ツールで、文章を書かずにすぐ返してください。",
  "- action: 選べる Action の type のどれか",
  "- amount: bet / raise のときだけ付ける。この Street での自分の累計額（to 額）の整数で、示された範囲に入れる。それ以外の Action には付けない",
  "- rationale: 判断の理由を日本語 1 文で",
].join("\n");

export class ClaudeOpponent implements OpponentAgent {
  constructor(private readonly options: ClaudeOpponentOptions) {}

  async decide(input: OpponentInput, signal?: AbortSignal): Promise<unknown> {
    try {
      return await runStructuredQuery({
        query: this.options.query,
        model: this.options.model,
        systemPrompt: SYSTEM_PROMPT,
        prompt: buildOpponentPrompt(input, this.options.persona),
        schema: outputSchema(input),
        env: this.options.env,
        signal,
      });
    } catch (error) {
      // 失敗の種類（未ログイン・利用枠の上限・それ以外）を持つ障害として Orchestrator へ伝える（D86）。
      if (error instanceof ClaudeCallError) {
        throw new ClaudeOpponentError(error.message, error.failureKind);
      }
      throw error;
    }
  }
}

/**
 * Claude の CPU を作る OpponentFactory。seed は使わない（LLM の判断は seed で再現しない）。
 * 卓で割り当てた Persona（#51）はその CPU の Prompt にだけ入れる。割り当てが無ければ options.persona のまま。
 */
export function createClaudeOpponentFactory(
  options: ClaudeOpponentOptions,
): OpponentFactory {
  return (_seed, _playerId, persona) =>
    new ClaudeOpponent(
      persona === undefined
        ? options
        : { ...options, persona: describePersona(persona) },
    );
}

/**
 * Claude へ渡す Prompt（user message）。入力は OpponentInput（KnowledgeState・Legal Action・前回の不正の理由）と Persona だけ。
 * KnowledgeState は whitelist で作られた Projection なので、他者の Hidden Cards・Future Cards は元から入っていない（D28）。
 */
export function buildOpponentPrompt(
  input: OpponentInput,
  persona?: string,
): string {
  const sections: string[] = [];
  // Persona は中身があるときだけ節ごと入れる（条件付きの指示を文で書かない）。
  if (persona !== undefined && persona.trim() !== "") {
    sections.push(`## あなたの性格\n${persona.trim()}`);
  }
  sections.push(
    `## あなたに見えている情報（あなたの ID は ${input.knowledge.viewerId}。Card は 2 文字で、As はスペードの A、Td はダイヤの 10）`,
    JSON.stringify(input.knowledge, cardReplacer),
    "## 選べる Action",
    input.legal.actions.map(describeLegalAction).join("\n"),
  );
  if (input.correction !== undefined) {
    sections.push(
      "## 前回の答えは使えなかった",
      `${input.correction.stage}: ${input.correction.reason}。選べる Action と額の範囲の中から選び直してください。`,
    );
  }
  return sections.join("\n\n");
}

/** 構造化出力の JSON Schema。action は今選べる type に絞る（合法性の最終判断は Orchestrator と Engine。D40）。 */
export function outputSchema(input: OpponentInput): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: input.legal.actions.map((a) => a.type),
      },
      amount: { type: "integer" },
      rationale: { type: "string" },
    },
  };
}

/**
 * Legal Action を Prompt の 1 行にする。call / all_in は額が決まっているので「amount は付けない」と行ごとに書く。
 * #51・#53 の実測で、call の行の額（または to 額）を amount に写して Schema の不正（→ Retry）になる回があった。
 * 検証は緩めず（D40）、迷いやすい行の上で指示する。
 */
function describeLegalAction(
  action: OpponentInput["legal"]["actions"][number],
): string {
  switch (action.type) {
    case "fold":
    case "check":
      return `- ${action.type}`;
    case "call":
      return `- call（追加で ${action.amount} 出す。amount は付けない）`;
    case "all_in":
      return `- all_in（この Street の累計が ${action.amount} になる。amount は付けない）`;
    case "bet":
    case "raise":
      return `- ${action.type}（amount = この Street の累計額。${action.min}〜${action.max}）`;
  }
}

/** Card を "As" 形式の文字列にする（JSON の { rank: 14, suit: "s" } より読みやすくする）。 */
function cardReplacer(_key: string, value: unknown): unknown {
  return isCard(value) ? cardToString(value) : value;
}

function isCard(value: unknown): value is Card {
  return (
    typeof value === "object" &&
    value !== null &&
    "rank" in value &&
    "suit" in value
  );
}
