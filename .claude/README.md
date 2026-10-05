# `.claude/` — エージェント運用ディレクトリ

このディレクトリは、Claude Code（エージェント）がこのリポジトリで作業するための **skill・設定・作業領域** を束ねる。新規参加者・エージェントが「何がどこにあるか」「どの skill をいつ使うか」「開発フロー全体像」を辿れるようにするための導線。

> 一次情報はプロジェクト方針＝ルート [`CLAUDE.md`](../CLAUDE.md)。手順の詳細は各 skill。本 README は**目次・使い分け**を担う。

---

## ディレクトリ構成

| パス | 役割 |
| --- | --- |
| `skills/` | skill 群（`<skill-name>/SKILL.md`）。トリガー時に読み込まれる手順・チェックリスト。下記「skill 一覧」参照 |
| `agents/` | 名前付き subagent（`issue-worker` = 1 Issue を merge-ready まで所有〔マージはしない〕/ `impl` = 確定した実装単位 / `chore` = 機械的作業 / `reviewer` = 読み取り専用の差分レビュー）。共通契約（マージ禁止・範囲外に書かない・統制面と共有台帳を触らない・他 subagent を起動しない・未コミットで終わらない）は各定義の「共通契約」節。同名の global `~/.claude/agents/` があってもプロジェクト版が優先される |
| `hooks/` | `session-start-context.sh`（環境注意の注入 + worktree 内で起動したときの CLAUDE.md 補完）/ `worktree-kernel.sh`（起動位置が worktree のときだけ、その worktree の CLAUDE.md を SessionStart〔親〕と SubagentStart〔カスタム subagent〕へ注入。`claudeMdExcludes` で読まれなくなる分の補完）/ `stop-git-check.sh`（未コミット・未 push の非ブロッキング注意）/ `pre-tool-use-subagent-guard.py`（subagent のコマンドに `gh` と `merge` が共起する形と REST `pulls/<n>/merge` を deny。親には無影響。**matcher は Bash のみ**で MCP 経由の書き込みは見ない。ユーザースコープの GitHub MCP は書き込み可能なため、`settings.json` の `deny` で `mcp__github__merge_pull_request` を塞いでいる） |
| `rules/` | `paths:` 付きの rule（対象パスに触れたときだけ読まれる）。常駐しない規範の置き場（現時点では未作成。コード構成が決まった Phase 0 / 1 以降に必要な領域だけ作る） |
| `settings.json` | Claude Code 設定（`language` / `permissions` / `defaultMode` / `env` / hooks 登録 / `enabledMcpjsonServers` / `claudeMdExcludes`）。権限は 2 段で、**`ask` は使わない**（個人開発・個人利用のため「deny で明確に禁止するもの以外は承認不要」。#28）: **`deny`**（`.env`・鍵・`curl \| sh`・CLAUDE.md 不変条件 6・7 の禁止操作 = force push・main 直 push・`filter-branch` / `filter-repo`・`gh repo delete/archive`・`rm -rf /` / `~` / `$HOME`。無音で止まる）/ **`allow`**（git / gh の通常操作、`reset --hard`・`gh api -X` / `--method`・`gh issue delete`・`gh repo edit`・`rm -r(f) <path>` を含む。`~/bin/codex-*.sh`）。マシン固有の追加 allow / deny は gitignore 対象の `settings.local.json`（#15・#27）に置く。評価順は deny → allow で最初の一致が効く。**パターンは先頭一致の列挙なので `cd x && git push --force` や `bash -lc` 経由は素通りする** —— 機械的な保証ではなく、最終防衛は agents の契約文と「必ず人間確認で停止する条件」 |
| `codex-mode` | このリポジトリの **Codex オートレビューモード上書き**（`autonomous`。`.gitignore` 対象のため本体作業ツリーで `~/bin/codex-mode.sh set-repo autonomous .` を設定。**worktree 内からは `~/bin/codex-mode.sh get /home/ai/project/proj-poker` と本体パスを渡して解決する**〔引数なしだと worktree のトップを見てグローバル既定になる〕）。解決順は repo 上書き > グローバル既定 > `stop`（`codex-mode.sh get` で解決） |
| `worktrees/` | 実装用の一時 `git worktree` 置き場（`.gitignore` 対象）。1 Issue = 1 worktree で隔離作業し、マージ後に後始末する（`github-workflow` skill「作業ツリーの分離」） |

> skill の品質基準（frontmatter `name`/`description`・500行目安・WHY・段階的開示など）は `add-skill` SKILL.md「skill 品質チェックリスト」が一次情報。**GitHub の読み書きは gh CLI を既定**とする（マージは親セッションの `gh pr merge` のみ）。

---

## 開発ワークフロー全体像

```
phase-planning（Phase 着手時に子 Issue へ分解・親 #2 へ紐付け）
issue-patrol（オープン issue 巡回・優先度整理・sub-issue 紐付け確認・着手候補選定）
      │  ← 新規タスク発見時は create-issue で起票
      ▼
github-workflow（標準フロー・手順の一次情報）
  Step 0: 実装計画 → 人間判断はセッション冒頭の AskUserQuestion 1 回にまとめ、以降は自走
      ▼  ブランチ作成（worktree 既定で隔離）
   実装 ──▶ test-and-review（差分確認・テスト・リスク）
      ▼  task-log（作業ログ）
   コミット（prefix 一覧は github-workflow）
      ▼  PR 作成（Summary/Test plan 必須）
   ClaudeCode 自己レビュー（Opus・台帳必読 → code-review 観点）──▶ Codex レビュー（codex-mode = autonomous。`STATUS=error` / `halt-tokenlimit` なら停止。reviewer agent 経路はマージ人間確認が既定）
      ▼  指摘は 4 状態に確定 → same-root sweep → 修正 or P2 accept → 条件付き再レビュー
      ▼  clean（P2 は記録済み）かつ人間確認不要ならマージ
   マージ後: worktree 後始末／Phase 完了時は release-readme-sync
```

- **横断的に効く skill**: `model-selection`（作業種別でモデル選択）・`subagent-briefing`（サブエージェント起動時の入出力最小化）。
- **学習資産は 2 つ**: レビュー時に読む **学習台帳**（`skills/code-review/references/learned-checks.md`）と、書く前に読む **実装前ガイダンス**（`skills/implementation-guidance/references/`）。**同じ項目は片方だけに置く**（差分を見ないと判定できないものは台帳、書く前に判定できるものはガイダンス）。書き込むのは `review-distillation` skill だけ。候補の記録は `review-learning`（PR コメント）で行い、feature PR では資産を書き換えない。
- **整合確認**: `sync-check`（実装・設計書・Issue の三者整合と実装計画）。
- **一次情報の所在**: 手順系（コミット prefix・PR説明文・Step0・自己レビュー・第 2 段レビュー）は **`github-workflow`**、タイトル規約は **`CLAUDE.md`**。

---

## skill 一覧（カテゴリ別）

各 skill の詳細トリガーは `skills/<name>/SKILL.md` の frontmatter `description` を参照。移設元は `ai-driven-assets`（`CLAUDE-assets/takumi-sano22/`。#3 で proj-poker 向けに改良）。

### 開発フロー

| skill | 用途・トリガー |
| --- | --- |
| `github-workflow` | Issue/ブランチ/コミット/PR の標準フロー。**手順系の一次情報**。コード/ドキュメント変更を伴う作業で既定起動 |
| `task-log` | 作業ログの作成・更新（`docs/taskLog/`）。「作業ログを書いて」 |
| `test-and-review` | 実装後の差分確認・テスト・リスク確認。「動作確認して」 |
| `sync-check` | 実装・docs 正本・Issue の三者整合確認と実装計画立案。「整合性を確認して」 |
| `model-selection` | 作業種別に応じたモデル選択。着手時・作業の性質が変わるたびに適用 |
| `subagent-briefing` | サブエージェント起動時の入力・出力を最小化する規律 |

### Issue・Phase 管理

| skill | 用途・トリガー |
| --- | --- |
| `issue-patrol` | オープン issue 巡回・優先度整理・親 #2 への sub-issue 紐付け確認・着手候補選定。**実装着手は `github-workflow` にディスパッチ** |
| `create-issue` | 発見したタスク/課題を GitHub Issue 化し親 Issue へ紐付ける。「issue を作って」 |
| `release-readme-sync` | Phase 完了時にルート `README.md`（現在のフェーズ・MVP 進捗）を更新 |

### 品質・レビュー

| skill | 用途・トリガー |
| --- | --- |
| `code-review` | コミット/PR 前のレビュー・自己レビュー。**手順 1 で学習台帳を必ず読む** |
| `review-learning` | Codex / 自己レビュー / 人間の指摘を PR コメントへ学習候補として記録（Capture） |
| `review-distillation` | 複数 PR の学習候補を台帳・ガイダンスへ変換（Distill）。独立 Issue / harness PR でだけ実行 |
| `implementation-guidance` | **コードを書く前**に読む判定基準への導線。触る領域の `references/<領域>.md` だけを読む |
| `llm-quality-improvement` | AI Opponent / Review の品質を測定駆動で改善（評価ハーネス・Judge・改善ループ） |

### docs・判断・UI・メタ

| skill | 用途・トリガー |
| --- | --- |
| `decision-log` | 人間判断を `docs/decision_log.yaml` へ記録、Open Items（`docs/11_OPEN_ITEMS.md`）の暫定値・確定の扱い |
| `ui-design-recipes` | UI の実装値レシピ集。**現状は汎用版**（卓 UI 向けの改良は #5） |
| `add-skill` | skill の新規追加・管理。**skill 品質チェックリストの一次情報** |

### proj-poker 固有

| skill | 用途・トリガー |
| --- | --- |
| `poker-invariant-review` | 情報境界・Hindsight Leak・チップ保存などドメイン不変条件のレビュー観点 |
| `poker-engine-testing` | 決定論エンジンのテスト規約（Invariant / Scenario Regression / property） |
| `phase-planning` | Phase を子 Issue へ分解し親 #2 の DoD と同期 |
| `solver-poc` | OI-002 Primary Solver 選定の PoC 手順 |

### 移設しなかった資産（理由）

`docker-dev` / `gcp-*` / `iam-preflight`（クラウド・コンテナ非採用）、`prisma-migration`（ORM 未確定）、`auth-security-review`（D61: Auth なし）、`tableau-analysis` / `r3f-*` / `3d-web-experience`（対象外・3D は非目標）、hook `pre-tool-use-ledger-freshness`（表形式のローカル台帳なし）、`.mcp.json`（ユーザースコープの GitHub MCP を使う）。必要になったら `ai-driven-assets` から改めて移設する。

## global / project 重複 skill の優先規則（本節が一次情報）

global（`~/.claude/skills`）と project（`.claude/skills`）の両方に同名 skill がある場合（`comm -12 <(ls -1 ~/.claude/skills/) <(ls -1 .claude/skills/)` で実測）、**常にプロジェクト固有版（`.claude/skills`）を一次情報として優先**し、global 版は固有版が無い他プロジェクト用の汎用フォールバックとして扱う（固有版と矛盾したら固有版を採る）。

> 同名 skill は global 版が読まれることがあるため、固有版は `.claude/skills/<name>/SKILL.md` をリポジトリのパスで Read する。SKILL.md と `references/` を両方に同一内容で置き、**固有補強だけを project 版に置く**運用（例: `ui-design-recipes/references/proj-poker.md`〔#5 で予定〕）では、変更は両方に当てる（`diff -rq` の差分が固有分だけであることを確認する）。

## 常駐コンテキストの予算

毎セッション常駐するのはルート `CLAUDE.md` と `.claude/rules/*.md`（`paths:` 付きの rule は対象パスに触れたときだけ）。**目安は `wc -m CLAUDE.md .claude/rules/*.md` の合計 9,000 字**（CLAUDE.md 単体 7,000 字以下）。超えたら手順・事実を skill / docs へ降格する（機械検査は置かない）。

### worktree の CLAUDE.md を二重に常駐させない

- **起きること**: サブディレクトリの CLAUDE.md は、そのディレクトリのファイルを読んだときに読み込まれる。worktree はリポジトリ直下の `.claude/worktrees/` にあるため、**本体で起動したセッション（と subagent）が worktree 内のファイルを読むと、その worktree の CLAUDE.md が本体の CLAUDE.md に加えて常駐する**。
- **対策**: `settings.json` の `claudeMdExcludes` で worktree 配下の CLAUDE.md を除外する。この除外は worktree の中で起動したセッションにも当たり、**プロジェクトの CLAUDE.md が 1 つも読まれなくなる**。そこで `hooks/worktree-kernel.sh` が、**起動位置（`CLAUDE_PROJECT_DIR`）が `.claude/worktrees/` 配下のときだけ**、その worktree の CLAUDE.md を 2 経路で補う（SessionStart: 親へ／SubagentStart: カスタム subagent へ。組み込みの Explore / Plan はもともと CLAUDE.md を読まない設計なので注入しない）。

  ```json
  "claudeMdExcludes": ["**/.claude/worktrees/**/CLAUDE.md"]
  ```

- **local 設定に置かない理由**: `settings.local.json` は worktree でも本体チェックアウトのものが使われる。hook での補完を前提に全員へ効く `settings.json` に置く。
- **注意**: hook を壊すと、worktree 内で起動したセッションとその subagent で kernel が黙って消える。`worktree-kernel.sh`・`session-start-context.sh`・`settings.json` の hooks を変えたら、worktree 内起動＋subagent で CLAUDE.md が届くことを実測する。**本体で起動したセッションが従う CLAUDE.md は、常に本体作業ツリーの CLAUDE.md**（未マージの下書きを暗黙に規範にしない割り切り。本体が古いと古い CLAUDE.md で作業するので `git pull` で最新に保つ）。Explore / Plan に守らせたい規則は委譲の prompt に書く。

## 関連ドキュメント

- ルート方針: [`CLAUDE.md`](../CLAUDE.md)
- 全体設計: [`docs/`](../docs/00_DOCUMENTATION_INDEX.md)（採用済み判断は `docs/decision_log.yaml`）
- Codex 用レビュー観点: [`AGENTS.md`](../AGENTS.md)
- 作業ログ: `docs/taskLog/`
