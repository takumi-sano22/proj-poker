# Issue #3: 汎用 Claude Code 資産を proj-poker 向けに移設する

## 概要

`ai-driven-assets`（`CLAUDE-assets/takumi-sano22/`）の skills / agents / hooks / CLAUDE.md 構成を、proj-poker（ローカル単一ユーザー・TypeScript・SQLite・Claude API・実装前）向けに改良して移設した。親 #2 の実装開始 Gate のうち「汎用 Claude Code Skills / Harness の追加」に対応する。

## 初期調査

- proj-poker: `README.md`、`docs/00`・`03`・`08`・`09`・`10`・`11`、親 Issue #2 を確認した。正本は `docs/`、採用済み判断は `decision_log.yaml`（D01〜D66）。
- 移設元: `apply-claude-assets` skill の手順（診断 → 選定 → 承認 → 適用 → 納品）に沿って棚卸しした。
- 環境: Codex は `~/bin/codex-mode.sh` / `codex-review.sh` が導入済み。グローバル既定のモードは `review-merge`。

## 人間判断（セッション冒頭の AskUserQuestion）

- 追加で移設するもの: `llm-quality-improvement`、`adr-log`（`decision-log` に改作）、`release-readme-sync`、`ui-design-recipes`（汎用版のまま移設し、改良は #5）。
- 新規 skill 4 つ（#4）: `poker-invariant-review` / `poker-engine-testing` / `phase-planning` / `solver-poc`。
- 運用: セッション冒頭で質問をまとめ、以降は完全自走。Codex モードは `autonomous`。
- settings.json / hooks を含む本 PR は事前承認済み。Codex のレビュー結果が clean なら自動マージしてよい。

## 設計方針

- 資産は新規に書き直さず、コピーしてから差分編集した。教訓・チェックリストは残している。
- スタックに該当しない資産は除外した: docker / gcp / iam / prisma / auth-security / tableau / r3f / ledger hook / .mcp.json。理由は `.claude/README.md` に記載。
- GitHub Project の代わりに、親 #2 への sub-issue 紐付けで進捗を管理する。タイトル規約は `[PhaseN]` / `[横断]`。
- npm / Prettier / husky など Phase 0 で確定するツールチェーンの記述は、「他 PJ の実績例」と注記して残した。確定後に読み替える。
- ユーザースコープの GitHub MCP は書き込みが可能なため、`settings.json` の deny に `mcp__github__merge_pull_request` 等を追加した。subagent-guard hook は Bash しか見ないので、その穴を塞ぐ目的。
- #4 で作る skill への参照には「#4 で追加」と注記した。

## 変更ファイル

- `CLAUDE.md`（新規）: kernel。不変条件 1〜7、自走ルール、タイトル規約、routing。
- `AGENTS.md`（新規）: Codex 用のプロジェクト観点。情報境界、決定論、Event Log、Solver、非目標、テスト。
- `.gitignore`（新規）: `.claude/worktrees/`、`.claude/codex-mode`、`.claude/settings.local.json`、`.env*`。
- `.claude/README.md`、`.claude/settings.json`。
- `.claude/hooks/`: session-start-context（proj-poker 向けの注意を注入）、worktree-kernel、stop-git-check、pre-tool-use-subagent-guard。
- `.claude/agents/`: chore、impl、reviewer、issue-worker。
- `.claude/skills/`: 17 個（一覧は `.claude/README.md`）。
- `docs/taskLog/issue-3-claude-assets.md`（本ファイル）。

## 実行した確認

- hooks の実測:
  - `pre-tool-use-subagent-guard.py`: subagent 由来の `gh pr merge` が deny になり、親セッション由来では何も出力されないことを確認した。
  - `stop-git-check.sh`: 未コミットの変更があると systemMessage が出ることを確認した。
  - `worktree-kernel.sh`: worktree の中では CLAUDE.md を注入し、本体の作業ツリーでは何も出力しないことを確認した。
  - `session-start-context.sh`: 注入される本文を確認した。
- `.claude/settings.json` を `python3 -m json.tool` で検証した。
- `~/bin/codex-mode.sh set-repo autonomous .` を実行し、`get` の結果が `autonomous` になることを確認した（本体の作業ツリー側。gitignore 対象）。
- プレースホルダの取り残しを grep で確認した。結果は PR に記載する。

## 残課題

- #4: 新規 skill 4 つ。
- #5: `ui-design-recipes` を卓 UI 向けに改良する。
- Phase 0 でツールチェーンが確定したら、`CLAUDE.md`「品質チェック」、`github-workflow` の Node 例の節、`test-and-review`、`code-review` の差分クラスのパスを実値に更新する。
- 親 #2 の Gate「追加された Skills / Harness をこの PJ の開発規約として確認する」は人間の確認項目なので残す。
