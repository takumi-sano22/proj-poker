# codex-sample — Codex オートレビュー導入サンプル

`github-workflow` skill の第 2 段レビューは、**Codex CLI（`codex`）導入環境では Codex レビュー（Step 2-A）**、未導入環境では `reviewer` agent（Step 2-B・`references/non-codex-review.md`）で動く。このディレクトリは、Codex 経路を他プロジェクトで再現するためのスクリプトと導入手順の一式。

## 同梱物

| ファイル | 役割 |
| --- | --- |
| `install.sh` | `codex-review.sh` / `codex-mode.sh` を `~/bin`（`CODEX_TOOLS_DEST` で変更可）へ配置する。冪等。既存と中身が違えば `*.bak-<日時>` に退避してから上書き |
| `codex-review.sh` | `codex exec --sandbox read-only review --base <base>` を実行し、結果を `gh pr comment` で PR に投稿。`[P0]`/`[P1]` の有無でマージ可否を判定。トークン/レート制限時は `codex-mode` の設定に従い sonnet フォールバックまたは停止。標準出力末尾に `REVIEWER=` / `STATUS=` / `POST=` / `SCRIPT_VERSION=` を出す |
| `codex-mode.sh` | レビューモードの状態管理ライブラリ兼 CLI。`stop` / `prereview` / `review-merge` / `autonomous` を解決（解決順: repo 上書き > グローバル既定 > 安全側 `stop`）。`source` して関数利用も、直接実行して `get` 等のサブコマンド利用も可 |
| `AGENTS.global.md` | `~/.codex/AGENTS.md` に置く**全リポジトリ共通**のレビュー指針（日本語・重大度タグ `[P0]`〜`[P3]`・重点観点・`[codex]` タグ付与）。`codex-review.sh` はこの重大度タグで機械判定する |
| `config.toml.example` | `~/.codex/config.toml` の例。レビュー専用プロファイル `[profiles.review]`（`sandbox_mode = "read-only"` / `approval_policy = "never"`）。**`codex-review.sh` は `--profile` を渡さず、代わりに `--sandbox read-only` を毎回明示する**（プロファイルの有無や利用者のトップレベル設定に依存しない）。このプロファイルは手動で `codex --profile review exec review` を叩くとき向け |

> プロジェクト固有のレビュー観点（不変要件・Phase 認識・環境の位置づけ）は、リポジトリ直下の `AGENTS.md` に書く。テンプレートは `CLAUDE-assets/<user>/CLAUDEmd/AGENTS.md`。

> スクリプト本体の**正（canonical）は別リポジトリ（sano-rag の `.claude/tools/`）**にあり、ここはその配布コピー。スクリプト冒頭のコメントに正の所在が書かれているのはそのため。共通の改善はそちらで行い、このサンプルへ手で反映する（自動同期は無い）。**本サンプルの `codex-review.sh` 1.0.2 は正（1.0.1）に `--sandbox read-only` の明示を先行して入れている**（正への反映は申し送り）。

## 前提

- **Codex CLI**（`codex`）がインストール済みで、`codex exec review --base <branch>` が使えること（`codex exec review --help` で現行フラグを確認。位置引数からフラグへ仕様変更された実績があり、`codex-review.sh` は未対応版を検出して止まる）。
- **GitHub CLI**（`gh`）が認証済みで、PR にコメント投稿できること。
- `claude` CLI（sonnet フォールバックを使う場合）。

## 導入手順

1. **スクリプト配置**:
   ```bash
   bash codex-sample/install.sh                       # ~/bin へ配置
   CODEX_TOOLS_DEST=/path/to/bin bash codex-sample/install.sh   # 配置先を変える
   ```
   `codex-review.sh` は同ディレクトリの `codex-mode.sh` を優先的に `source` するため、2 つは同じ場所に置く。**配置先は非対話シェルの PATH に無いのが普通**。skill 内からは常にフルパス（`<codex-tools-dir>/codex-review.sh`）で呼ぶ。`CODEX_TOOLS_DIR` 環境変数を設定しておくと `github-workflow` の「Codex 導入判定」が最初にそこを見る。
2. **レビュー指針配置**:
   ```bash
   cp codex-sample/AGENTS.global.md ~/.codex/AGENTS.md
   cp codex-sample/config.toml.example ~/.codex/config.toml   # 既存があればマージ
   ```
   プロジェクト固有の観点は対象リポジトリ直下の `AGENTS.md` へ。
3. **モード設定**（任意・既定は安全側 `stop`）:
   ```bash
   ~/bin/codex-mode.sh set-global review-merge       # グローバル既定モード
   ~/bin/codex-mode.sh set-repo   autonomous .       # このリポジトリだけ上書き（.claude/codex-mode に保存。.gitignore 済み。proj-poker の既定は autonomous）
   ~/bin/codex-mode.sh tokenlimit-set sonnet         # トークン制限時に sonnet で代替レビュー（既定）／stop なら人間確認
   ~/bin/codex-mode.sh get                            # 有効モードの解決結果を確認
   ```
   - `stop`: レビューしない / `prereview`: レビューのみ（マージしない） / `review-merge`: clean かつ人間確認不要ならマージ / `autonomous`: findings を修正→再レビュー最大3回。
4. **レビュー実行**（PR 作成後・`github-workflow` skill のフローから呼ばれる想定）:
   ```bash
   ~/bin/codex-review.sh --base main            # base ブランチを明示（省略時は gh から自動解決）
   ~/bin/codex-review.sh --pr 123 --dry-run     # 投稿せず本文だけ確認
   ```
   終了コード: `0`=clean（マージ可） / `10`=findings（要修正） / `20`=halt-tokenlimit（人間確認） / `1`=error。

## 配置済みの版が古くないか確かめる

`codex-review.sh` は実行のたびに出力の末尾へ版を出す（`SCRIPT_VERSION=x.y.z`）。出ない、またはこのサンプルの版（`grep -m1 '^CODEX_REVIEW_VERSION=' codex-sample/codex-review.sh`）と違えば `install.sh` を再実行する。

`STATUS` と `POST` は独立している。レビュー自体は成功しても投稿だけ失敗しうるため、`STATUS=clean/findings` でも `POST=failed` なら `POST_BODY_FILE` を読んで自分で投稿し直す。

## 自動マージ・自走の停止条件（必ず人間確認）

`review-merge` / `autonomous` でも、以下は自動マージ・自走修正せず停止する（`github-workflow` skill「必ず人間確認で停止する条件」と共通）:

- 破壊的/不可逆な操作（force push・履歴破壊・本番相当データ削除）
- スキーマ変更・マイグレーション
- セキュリティ・認証/認可・権限・課金に関わる変更
- 設計判断・アーキテクチャ上のトレードオフ
- 要件の曖昧さ・前提の不確実性

> 注: スクリプトは環境依存の前提（`gh` 認証・`codex` CLI のフラグ仕様・`~/.ai-workspace/` への状態保存パス）を含む。導入先の環境に合わせてパス・フラグを調整すること。
