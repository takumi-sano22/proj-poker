// Claude の構造化出力の 1 回の呼び出し（docs/03 §3・D87）。Opponent（#50）と Review（#82）が共有する。
// Claude Agent SDK の query() を「1 回の単発の問い合わせ」として使い、ローカルでログイン済みの Claude Code の OAuth（サブスク枠）で呼ぶ。
// API キーは使わない（子プロセスの環境から外す）。出力の検証・Retry は呼び出し側（Opponent は Orchestrator、Review は generateReview）。
// ログイン切れ・利用枠の上限・子プロセスの失敗は例外（ClaudeCallError）にし、構造化出力を作れなかったのは null（不正な出力）として返す。
import { tmpdir } from "node:os";
import {
  query as sdkQuery,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** SDK の query() と同じ形。テストでは Fake（録画済み応答）に差し替え、Claude を呼ばない。 */
export type ClaudeQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/** Claude を呼ぶ子プロセスの環境から外す変数。あると OAuth（サブスク枠）ではなく API 課金になる（D87）。 */
export const API_BILLING_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/**
 * 子プロセスに渡す環境を作る。SDK の env は子プロセスの環境を丸ごと置き換えるので、
 * 親の環境（PATH・HOME 等）を写したうえで API 課金に切り替わる変数だけを外す。
 */
export function buildClaudeEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if ((API_BILLING_ENV_KEYS as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return env;
}

/** 呼び出しの失敗の種類。未ログインと利用枠の上限だけを分け、残りは error（案内を変えるため。#52）。 */
export type ClaudeFailureKind = "unauthenticated" | "usage_limit" | "error";

/** Claude の呼び出しが結果を返せなかった（障害）。構造化出力の不正（null を返す）とは区別する。 */
export class ClaudeCallError extends Error {
  override readonly name = "ClaudeCallError";
  constructor(
    message: string,
    readonly failureKind: ClaudeFailureKind = "error",
  ) {
    super(message);
  }
}

/**
 * assistant message の error（SDK の SDKAssistantMessageError）を失敗の種類に分ける。
 * ダイアログで「ログインし直す」「枠が戻るまで待つ」を案内できるよう、未ログインと利用枠の上限だけを分け、残りは error にする。
 */
export function outageKindOf(apiError: string | null): ClaudeFailureKind {
  switch (apiError) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "verification_required":
      return "unauthenticated";
    case "billing_error":
    case "rate_limit":
      return "usage_limit";
    default:
      return "error";
  }
}

export interface StructuredQueryParams {
  /** 省略時は SDK の query()。 */
  readonly query?: ClaudeQuery;
  /** 具体モデル名。role-based config（MODEL_ROLES）から渡す。 */
  readonly model: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  /** 構造化出力の JSON Schema。 */
  readonly schema: Record<string, unknown>;
  /** 子プロセスの環境。buildClaudeEnv の結果を渡す。 */
  readonly env: Record<string, string>;
  /** 呼び出し側が結果を待たなくなった（上限の超過・アプリ終了）ときに abort する。子プロセスを止める。 */
  readonly signal?: AbortSignal;
  /**
   * ターン数の上限（既定 1 = 単発）。構造化出力が JSON として読めない・Schema に合わないとき、SDK はモデルに直させるために
   * 次のターンを使う。長い出力（Review）ではその直しを 1 回許すために 2 にする（#82 の実測で、1 では JSON の崩れで止まった）。
   */
  readonly maxTurns?: number;
}

/**
 * 構造化出力を 1 回だけ問い合わせる。返り値は structured_output そのもの（形は呼び出し側が検証する）。
 * 構造化出力を作れなかった（Schema に合う出力を返さない・ターン上限）ときは null（不正な出力として呼び出し側の検証に回す）。
 * ログイン切れ・利用枠の上限・実行中の失敗・結果なしは ClaudeCallError。子プロセスの起動・SDK の例外はそのまま投げる。
 *
 * Options の項目の並びは録画の指紋（opponent-eval の hashParams は JSON の文字列から作る）に入るので、並べ替えない。
 */
export async function runStructuredQuery(
  params: StructuredQueryParams,
): Promise<unknown> {
  const query = params.query ?? sdkQuery;
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  const { signal } = params;
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const messages = query({
      prompt: params.prompt,
      options: {
        model: params.model,
        systemPrompt: params.systemPrompt,
        outputFormat: { type: "json_schema", schema: params.schema },
        // 単発の問い合わせにする: ターン 1（既定）・組み込みツールなし・設定ファイル（CLAUDE.md / settings）と MCP を読まない。
        maxTurns: params.maxTurns ?? 1,
        tools: [],
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        // 呼び出しごとのセッション履歴を ~/.claude/projects へ残さない。
        persistSession: false,
        // 作業ディレクトリ由来の文脈（リポジトリの git の状態・メモリ等）を渡さないよう、リポジトリの外で動かす。
        // 実測（#50）で、リポジトリ内を cwd にすると入力が約 500 token 増えた。
        cwd: tmpdir(),
        thinking: { type: "disabled" },
        env: params.env,
        abortController,
      },
    });
    // 認証切れ・利用枠の上限などは、result の前の assistant message の error に種類が載る。
    let apiError: string | null = null;
    for await (const message of messages) {
      if (message.type === "assistant" && message.error !== undefined) {
        apiError = message.error;
      }
      if (message.type !== "result") continue;
      if (message.subtype === "success") {
        if (message.is_error) {
          throw new ClaudeCallError(
            `Claude の呼び出しが失敗した（${apiError ?? "unknown"}）: ${message.result}`,
            outageKindOf(apiError),
          );
        }
        // structured_output が無い・形が違う場合も、そのまま返して呼び出し側の検証（Schema）で不正にする。
        return message.structured_output;
      }
      // 構造化出力を作れなかった（Schema に合う出力を返さない・ターン上限）のは、モデルの出力の不正として扱う。
      if (
        message.subtype === "error_max_structured_output_retries" ||
        message.subtype === "error_max_turns"
      ) {
        return null;
      }
      throw new ClaudeCallError(
        `Claude の呼び出しが失敗した（${message.subtype}）: ${message.errors.join(" / ")}`,
      );
    }
    throw new ClaudeCallError("Claude から結果が返らなかった");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
