# Issue #50: Claude Agent SDK（OAuth・サブスク枠）の Model Adapter と role-based model config

## 概要

Phase 3（AI Opponents）の子 Issue。CPU の判断を Claude（`opponent_fast` Role）で行う `ClaudeOpponent` を、Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）経由・ローカルでログイン済みの Claude Code の OAuth（サブスク枠）で作った（D87）。API キーは使わない。既定の CPU は RuleBot のままで、`OPPONENT_PROVIDER=claude` のときだけ Claude を使う。Event の形・`schema_version`・永続化スキーマは変えていない。

## 初期調査

- 前提（main 3edf68d）: #47 で `OpponentAgent.decide` は Promise を返し、Orchestrator が出力の検証（Schema → Legal Action → Amount Range）・1 回 Retry・RuleBot の Fallback・障害（例外・上限超過）を持つ。#48 で AI_ACTION_INVALID / AI_FALLBACK_USED が Event（版 4）。#49 で README・docs/03 §3 に OAuth の手順があり、「切り替える設定名は #50 で追記」となっていた。
- Orchestrator の判断待ちの上限（`ask`）は結果を捨てるだけで、CPU 側の処理を止める手段が無かった（RuleBot は同期なので不要だった）。
- SDK の型定義（0.3.289 の `sdk.d.ts`）で option を確かめた:
  - `tools: []` で組み込みツールを全部外せる（`allowedTools` は許可の自動承認で、ツールを外すものではない）。
  - `settingSources: []` で settings / CLAUDE.md を読まない。`mcpServers: {}` と `strictMcpConfig: true` で `.mcp.json`・ユーザー設定の MCP を読まない。
  - `env` は子プロセスの環境を丸ごと置き換える（`process.env` とは合成しない）。
  - `persistSession: false` でセッション履歴を `~/.claude/projects/` に残さない。
  - 構造化出力は `outputFormat: { type: "json_schema", schema }` で、結果は `result`（`subtype: "success"`）の `structured_output`。失敗は `error_max_turns` / `error_max_structured_output_retries` / `error_during_execution`。
  - ログイン切れ・利用枠の上限などは `assistant` message の `error`（`authentication_failed` / `rate_limit` / `billing_error` 等）と、`is_error: true` の `success` result で届く。
- `claude auth status` で、このマシンは claude.ai（max）でログイン済み・`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` は未設定であることを確認した（資格情報のファイルは読んでいない）。

## 変更内容

- `apps/server/package.json` / `pnpm-lock.yaml`: `@anthropic-ai/claude-agent-sdk@0.3.289`（固定版）を追加。最新の 0.3.290 は pnpm の公開からの経過日数の規則（minimumReleaseAge）に掛かり、`pnpm-workspace.yaml` へ除外を自動で足そうとしたため、規則を緩めず 1 つ前の版にした。SDK の peer dependency として `@anthropic-ai/sdk`・`zod`・`@modelcontextprotocol/sdk` が lockfile に入るが、直接の依存には入れておらず import もしない。`smoke:claude` script を追加。
- `apps/server/src/config.ts`: role-based config `MODEL_ROLES = { opponent_fast: "claude-haiku-4-5" }`（D85・OI-001 の暫定値）、`OpponentProvider` と `parseOpponentProvider`（未設定・空は `rulebot`、`rulebot` / `claude` 以外は起動時に RangeError）。`DEFAULT_OPPONENT_TIMEOUT_MS` を 15000 → 30000（下の実測による見直し）。
- `apps/server/src/opponents/claude-opponent.ts`（新規）:
  - `ClaudeOpponent.decide(input, signal?)`: `query()` を 1 回の判断として呼ぶ。option は `model`（role-based config から）・`systemPrompt`・`outputFormat`（action の enum は今選べる type）・`maxTurns: 1`・`tools: []`・`settingSources: []`・`mcpServers: {}`・`strictMcpConfig: true`・`persistSession: false`・`cwd: os.tmpdir()`・`thinking: disabled`・`env`・`abortController`。
  - 失敗の分け方: `is_error` の success result（ログイン切れ・上限）・`error_during_execution`・結果なし・SDK / 子プロセスの例外は例外（＝ #47 の障害）。`error_max_turns` / `error_max_structured_output_retries` は `null` を返し、Orchestrator の検証で Schema 違反（不正な出力 → Retry → Fallback）になる。
  - `buildClaudeEnv(process.env)`: `ANTHROPIC_API_KEY` と `ANTHROPIC_AUTH_TOKEN` を外した環境を作る。
  - `buildOpponentPrompt(input, persona?)`: KnowledgeState（Card は "As" 形式の文字列に置き換えた JSON）・選べる Action と額の範囲・前回の不正の理由（再要求のときだけ）・Persona（中身があるときだけ節ごと。中身は #51）。
  - `createClaudeOpponentFactory`: seed を使わない OpponentFactory。`query` を差し替えられる（テストは Fake）。
- `apps/server/src/opponents/opponent-agent.ts` / `hand-orchestrator.ts`: `decide(input, signal?)`。Orchestrator は判断待ちを打ち切ったとき（上限超過・`close()`）だけ signal を abort する。判断が返った後・例外の後は abort しない。
- `apps/server/src/index.ts`: `OPPONENT_PROVIDER` を読み、`claude` なら `createClaudeOpponentFactory({ model: MODEL_ROLES.opponent_fast, env: buildClaudeEnv(process.env) })`、それ以外は `createRuleBot`。不正な値は DB を開く前に止める。起動ログに provider（と model）を出す。
- `apps/server/src/testing/claude-smoke.ts`（新規・手動専用）: 本番と同じ Factory と HandOrchestrator で Hand を進め、1 回の判断ごとの Latency と検証結果、`query()` の最初の message までの時間（子プロセスの起動〜初期化）と `duration_api_ms` を集計する。CI と `pnpm test` では動かない（`*.test.ts` ではなく、build からも除外される `src/testing/` に置いた）。
- テスト:
  - `claude-opponent.test.ts`（新規）: `buildClaudeEnv` が 2 つの変数を外しほかを写す／`decide` に渡す option（ターン 1・ツールなし・設定と MCP を読まない・model・API キーを外した env・cwd・Schema の enum）／録画済みの正常な応答が検証を通る／未ログイン（録画）・rate_limit・実行中の失敗・結果なし・`query` の同期例外は障害（例外）／ターン上限・Schema の再試行上限は Schema 違反／signal の abort が SDK の abortController に伝わる（最初から abort 済みも）／Persona・correction の節の出し分け／Prompt の Action と額の範囲／20 Hand を Orchestrator で進め、どの Prompt にもその時点でその CPU が知ってよい札しか入らない（INV-TEST-007）。
  - `hand-orchestrator.test.ts`: 上限超過で signal が abort される／判断が返った・例外の後は abort しない／判断待ち中の `close()` で abort される。
  - `config.test.ts`: `parseOpponentProvider`・`MODEL_ROLES`。
- docs: docs/03 §1（Orchestrator の上限値・opponents の説明）・§3（切り替えの設定・呼び方・失敗の分け方・Latency）・§5（上限超過時の abort）、docs/11 OI-001（上限の見直しと実測）、README（環境変数表・「Claudeの認証」の手順 4）。

## 判断理由

- **action の enum を今選べる type に絞った**: 合法性の判断を LLM に任せるのではなく（最終判断は Orchestrator と Engine。D40）、選べない type を最初から出させないため。bet / raise の額の範囲は Schema の条件分岐が複雑になるので Prompt に書き、検証は Orchestrator の Amount Range に任せた。
- **構造化出力を作れなかったときは不正な出力として返す**: Issue の「Invalid Output は #47 の検証・Retry に乗せる」に従った。`error_max_turns` は実験で 1 回出た（モデルが StructuredOutput を呼ばずに文章で答えた）。一方、ログイン切れ・上限・実行時の失敗は出力の問題ではないので障害にした（Emergency Bot へ自動では切り替えない。D86）。
- **cwd をリポジトリの外にした**: 同じ Prompt で cwd だけを変えて入力 token を比べたところ、OS の一時ディレクトリ 995・本 worktree の `apps/server` 1515・リポジトリのルート 1308 で、リポジトリ内では作業ディレクトリ由来の文脈（git の状態等）が入っていた。ポーカーの情報境界ではないが、CPU の判断に要らない情報を渡さず、token も減らすため。
- **事前起動（`startup()`）は使わない**: 子プロセスの起動〜初期化は約 0.7 秒（判断全体の約 1 割）で、残りは API の応答だった。`startup()` は 1 つの WarmQuery が 1 回しか使えず、option（判断ごとに変わる Schema）も起動時に固定されるため、得る 0.7 秒に対して複雑さが見合わない。
- **`OPPONENT_TIMEOUT_MS` を 30000ms に見直した**: 2 回目の実測で 30 回中 1 回が 15.5 秒（API の応答が遅い回）で、15000ms では障害で Hand が止まる。最大の約 2 倍に置いた。OI-001 の暫定値で、確定ではない（docs/11 に注記）。
- **`OPPONENT_PROVIDER` の知らない値は起動時に止める**: ほかの設定（TABLE_SIZE 等）は不正値を既定に戻すが、`Claude` のような綴り違いで黙って RuleBot になると、Claude を試しているつもりで試せていないことに気づきにくいため。
- **`ANTHROPIC_AUTH_TOKEN` も外した**: Issue の指示どおり。`CLAUDE_CODE_OAUTH_TOKEN` は D87 で本プロダクトでは使わないとしているが、サブスク枠の認証なので API 課金には切り替わらず、外していない。

## 手動スモーク（実際に Claude を呼んだ結果）

- 条件: 2026-10-06、`claude-haiku-4-5`、SDK 0.3.289、claude.ai（max）でログイン済み、`ANTHROPIC_API_KEY` 未設定、3 人卓（Hero は Call / Check）、計測用に判断待ちの上限を 120 秒に延ばした（分布をそのまま取るため）。コマンドは `pnpm --filter @proj-poker/server smoke:claude 30 3`。
- 1 回目（cwd をリポジトリの外にする前）: 33 回、Valid 33（100%）、Latency 中央値 7159ms・p90 8668ms・最大 8819ms、起動〜初期化 中央値 727ms、API 中央値 6632ms。
- 2 回目（本 PR の最終の option）: 30 回、Valid 30（100%）、Latency 中央値 7204ms・p90 8445ms・最大 15493ms、起動〜初期化 中央値 699ms、API 中央値 6605ms・最大 15524ms。
- 合計 63 回、障害（例外）0 回、不正な出力 0 回。
- 未ログインの応答は、ログアウトせずに `CLAUDE_CONFIG_DIR` を空のディレクトリ（作業用の一時ディレクトリ）にして 1 回だけ再現し、`assistant.error = "authentication_failed"`・`is_error: true` の success result（"Not logged in · Please run /login"）が返ることを確かめた（テストの録画済み応答に使った）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）: 結果は PR の Test plan に記載。
- `pnpm test` は Claude を呼ばない（`claude-opponent.test.ts` は Fake の `query` だけ、ほかのテストは RuleBot / Fake Model）。

## 残課題

- Persona の中身（docs/05 §2）は #51。今は Prompt に差し込む口だけで、空なら節ごと入れない。
- 障害で止まった Hand の続け方（Retry / Emergency Bot / Session 終了）の UI は #52。
- 1 回の判断が中央値約 7 秒なので、6 人卓では CPU 5 人の手番が続くと 30 秒以上待つことがある。UX（思考中の表示・D65）は別途。
- SDK の peer dependency として `@anthropic-ai/sdk` が lockfile に入る（直接の依存・import はしない）。
