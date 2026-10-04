# Issue #11: ハーネスのツールチェーン記述を実値に更新し README を同期する

## 概要

Phase 0 の最終 PR。#9（PR #12）・#10（PR #13）で決まったツールチェーンとディレクトリ構成（D67〜D69）を、harness（`CLAUDE.md`・skills・agents）の「Phase 0 で確定する」と書いた暫定箇所に反映した。あわせて `release-readme-sync` skill の手順で README を Phase 0 の到達点に更新した。

## 初期調査

- main 上の実ファイルで確定値を確認した: ルート `package.json`（`packageManager: pnpm@12.9.1`・`engines.node >=24 <25`・scripts `dev` / `lint` / `typecheck` / `test` / `format` / `format:check`）、`.nvmrc`（24）、`.github/workflows/ci.yml`（install --frozen-lockfile → lint → typecheck → test → format:check）、`.prettierignore`、`eslint.config.mjs`（Engine の `no-restricted-imports`）、`packages/engine/src/index.test.ts`・`index.property.test.ts`、`apps/server/src/index.ts`（`127.0.0.1:3001`）、`apps/web/vite.config.ts`（`/api` を 3001 へ proxy）。
- `grep -rn "Phase 0 で確定" CLAUDE.md AGENTS.md .claude README.md` で暫定箇所を洗い出した。言い回し違い（「Phase 0 で決める」「Phase 0 確定後」）と npm / husky の例示も別に grep した。

## 変更内容

- `CLAUDE.md`「品質チェック」: `pnpm lint` / `typecheck` / `test` / `format:check`（適用は `pnpm format`）、pre-commit hook なし、worktree は `pnpm install --frozen-lockfile`。1 項目のまま収めた。
- `code-review`: 差分クラス表を `packages/engine` / `apps/server` / `apps/web` に書き換え、暫定注記を外した。サブディレクトリはまだ無いので、パスで決まらないクラスは import と呼び出し先で判定する旨を残した。F（SSR hydration）は「SPA のため現状は対象外」とし、乱数を UI で生成しない点だけは SPA でも守ると明記した。
- `poker-engine-testing`: ランナー（Vitest / fast-check）・配置（`packages/engine/src/**/*.test.ts`・`*.property.test.ts`）・実行コマンドを実値にした。
- `github-workflow`: 「共有物の symlink」節を「worktree の依存」に置き換え（worktree ごとに `pnpm install --frozen-lockfile`、husky と `.husky/_` は不採用）。「マージ前のローカル品質チェック」を CI と同じ 4 コマンド・pre-commit なしの運用に簡潔化。dev サーバー節に proj-poker の現状（`pnpm dev`・ポート）を追記。
- `test-and-review` / `issue-worker` / `release-readme-sync` / `phase-planning` / `implementation-guidance`（SKILL.md・`docs-harness.md`）/ `codex-review.md` / `chore` / `review-distillation`: npm・husky の例と「Phase 0 で確定」を実値に置き換えた。
- 範囲表記: `README.md`・`sync-check`・`test-and-review` の `D01〜D66` を `D01〜D69` に。`decision-log` の例示も同様に更新。
- README: 現在の状態・技術構成・セットアップ（corepack enable → pnpm install → pnpm dev）・開発コマンド・現在のフェーズ（できていること / 制約 / 次の Phase）を更新。

## Phase 1 以降へ持ち越したもの（理由）

| 箇所 | 持ち越す内容 | 理由 |
|---|---|---|
| `github-workflow` dev サーバー節・`issue-worker` | worktree ごとのポート採番と dev サーバー管理スクリプト | Phase 0 には画面が無く不要だった。UI を実測する Issue が並ぶようになった時点で作る |
| `llm-quality-improvement` | Eval の置き場と実行コマンド | Phase 0 に LLM 呼び出しが無い。最初の Eval を作る Issue（Phase 3 の見込み）で決める |
| `poker-engine-testing` §4 | Scenario ファイルの形式と置き場 | Phase 0 はランナーを作っていない。最初の Scenario ランナーの Issue で決める |
| `implementation-guidance/references/db.md` | ORM / マイグレーションツール | Phase 0 は永続化を実装していない。SQLite へ最初に保存する Issue で決める |
| `implementation-guidance/references/poker-engine.md` | Chip の数値表現 | Engine のロジックが無かった。Engine で Chip を最初に扱う Issue（Phase 1）で決め、decision-log へ記録する |

## 判断理由

- worktree の依存は symlink ではなく worktree ごとの install にした。pnpm は store 共有で速く、パッケージごとの `node_modules` を本体と共有すると隔離が壊れるため（親の指示どおり）。
- 本 PR はドキュメント・harness だけで、コード（`apps/**`・`packages/**`・`.github/**`）と `.claude/settings*.json`・`.claude/hooks/**`・`docs/decision_log.yaml` には触れていない。
- 学習台帳 `code-review/references/learned-checks.md` に npm / husky の記述は無かった（grep で確認）。

## 実行した確認

- `grep -rn "Phase 0 で確定" CLAUDE.md AGENTS.md .claude README.md` → 0 件（exit=1）
- `grep -rn "D01〜D66" README.md .claude CLAUDE.md AGENTS.md` → 0 件
- `grep -rnE "npm (ci|run)|npx (prettier|tsc)|husky|Phase 0 で決め|Phase 0 確定" ...` → `github-workflow` の 2 行だけ（「npx prettier で判定しない」「husky は不採用」と書いた意図的な残り）
- worktree で `pnpm install --frozen-lockfile` → `pnpm lint` / `pnpm typecheck` / `pnpm test`（2 passed）/ `pnpm format:check` すべて exit 0
- `pnpm dev` を起動し、`curl http://127.0.0.1:5173/api/health` が `{"status":"ok"}` を返すことを確認（README のセットアップ手順の裏付け）
- `pnpm --filter @proj-poker/engine test` が動くことを確認（`poker-engine-testing` に書いたコマンド）
- `claude plugin validate .claude/skills` → Validation passed

## 残課題

- 上表の持ち越し 5 件（各 Phase の Issue で決める）。
- 親 #2 の MVP DoD は Phase 0 に対応する項目が無く、更新なし。
