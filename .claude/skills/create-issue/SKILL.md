---
name: create-issue
description: "プロジェクトリポジトリに GitHub Issue を作成するスキル。会議・チャット・コードレビューで発見したタスクや課題を即座に issue 化する。「issueを作って」「issueを切って」「タスクをissueにして」「これをissueにして」「issue作成して」「バグをissueにして」「対応が必要なことをissueにして」「issueに起票して」などのキーワードでトリガーすること。"
---

# Issue 作成

## 概要

会議・チャット・コードレビューで発見したタスクや課題を GitHub Issue として作成する。
情報が断片的でも、コンテキストから WHY・WHAT を補完して issue 化することで、タスクの抜け漏れを防ぐ。

## 使い方

```
/create-issue [タイトル] [--repo オーナー/リポジトリ名]
```

例: `/create-issue "[Phase0] 開発基盤の確定" --repo takumi-sano22/proj-poker`

---

## 実行内容

### 1. Issue の内容を整理

ユーザーから提供された情報をもとに以下のフォーマットで整理する。
情報が不足している場合は文脈（会話履歴・コードベース・直近の PR）から補完し、不明な点のみ確認する。

```markdown
# WHY

（なぜこの Issue が必要か。背景・問題の概要を 2〜3 文で）

# WHAT

- [ ] （具体的にやること 1）
- [ ] （具体的にやること 2）
- [ ] （テスト・確認事項）

# 参考

- 関連 PR / Issue: （あれば）
- 関連ファイル: （あれば）
```

WHY には「何が困っているか」「なぜ今やる必要があるか」を書く。WHAT はチェックリスト形式で、完了の定義が明確になるよう具体的に記述する。

### 2. リポジトリの判定とタイトル規約

- `--repo` で明示指定された場合はそれを使う。指定が無ければ `takumi-sano22/proj-poker`（`git remote get-url origin` で確認）。
- 判断できない場合のみユーザーに確認する。

**タイトル規約の一次情報は CLAUDE.md**。要点は以下。**prefix 無しで issue を作成しない**こと。判定に迷う場合のみユーザーに確認する。

- Phase 作業: `[PhaseN] {title}`（N は `docs/08_MVP_AND_ROADMAP.md` の Phase 0〜8）
- Phase に属さない横断作業: `[横断] {title}`

### 3. ラベル・Priority・Effort の設定

リポジトリの既存ラベルを確認し、内容に応じて設定する。

```bash
# 既存ラベルの確認
gh label list --repo takumi-sano22/proj-poker
```

- バグ系 → `bug`
- 機能追加・改善 → `feature`
- ドキュメント → `documentation`
- 汎用タスク → `task`

> 上記の名前が存在しない場合は `gh label list` の出力から最も近いラベルを使う（例: `feature` がなければ `enhancement`）。それでも見つからなければラベルなしで作成し、ユーザーに通知する。ラベルの新規作成は行わないこと。
> リポジトリによっては `role:` / `business:` / `priority:` / `common:` のような名前空間ラベルで運用されている場合がある。その場合は単純な種別ラベルではなく、`gh label list` の出力から該当する名前空間ラベルを選んで付与すること。


> **Priority / Effort について**: proj-poker は GitHub Project を使わない。`gh label list` の出力に `priority:` / `effort:` 系のラベルがあればラベルで設定する。なければ Issue 本文の `# 参考` セクションに記載するにとどめ（例: `Priority: high, Effort: M`）、**ラベルで設定できなかった場合は必ずユーザーに通知すること**。

### 4. Issue テンプレートの確認

`.github/ISSUE_TEMPLATE/` にテンプレートがある場合は、そのフォーマットを手順1の本文に反映する。

```bash
ls .github/ISSUE_TEMPLATE/ 2>/dev/null
```

> `--repo` で別リポジトリを指定した場合は、現在のディレクトリのテンプレートではなく対象リポジトリの設定に合わせること（`gh api repos/takumi-sano22/proj-poker/contents/.github/ISSUE_TEMPLATE 2>/dev/null` で確認可能）。

テンプレートがない場合でも、WHY/WHAT/参考 の構造は必ず維持する。

### 5. 重複・関連チェック

```bash
gh issue list --repo takumi-sano22/proj-poker --search "{title}" --state all
```

- 類似タイトルの issue が見つかった場合はユーザーに提示し、重複かどうか確認する。**重複と確認された場合は issue 作成を中止し、既存 issue の URL を報告して終了する。**
- 関連する親 issue や PR があれば本文に記載する

### 6. Issue の作成

```bash
ISSUE_BODY=$(mktemp /tmp/issue-body-XXXXXX.md)
# ... 本文を ${ISSUE_BODY} に書き出す ...
gh issue create \
  --repo takumi-sano22/proj-poker \
  --title "[PhaseN] {title}" \
  --label "{type-label}" \
  --assignee @me \
  --body-file "${ISSUE_BODY}"
rm "${ISSUE_BODY}"
```

> **タイトルには必ず手順2のタイトル規約（`[PhaseN]` または `[横断]`）を付ける**。prefix 無しで作成しないこと。
> 本文（WHY/WHAT 構造）は `mktemp` で生成した一時ファイルに書き出してから `--body-file` で渡すこと。固定パス (`/tmp/issue-body.md`) は並列実行時に衝突する。`--body "..."` は改行・引用符で壊れるため使わない。
> `--label` は複数回指定できる。
> **`--assignee` は必ず付与する**（ラベル（手順3）・親 sub-issue 紐付け（手順7）と並ぶ必須の 3 点セット）。担当者が確定していれば `--assignee {github-username}`、未定なら作成者自身（`--assignee @me`）を暫定担当として割り当てる。`@me` で失敗する場合は `gh api user --jq .login` で取得したユーザー名を使う。

作成された Issue の URL・番号を捕捉しておく（次ステップで使う）。

```bash
ISSUE_URL=$(gh issue create --repo takumi-sano22/proj-poker --title "[PhaseN] {title}" --assignee @me ... )  # gh issue create は作成した issue の URL を標準出力に返す
GH_NUM=$(echo "$ISSUE_URL" | grep -oE '[0-9]+$')
```

### 7. 親 Issue への sub-issue 紐付け

**proj-poker は GitHub Project を使わない**。進捗管理は親 Issue への **sub-issue 紐付け**で行う。親は MVP（Phase 0〜5）が #2（Close 済み）、Post-MVP は Phase 6 が #105・Phase 7 が #106・Phase 8 が #107（その上に Post-MVP Parent #104。Phase に属さない Post-MVP の横断 Issue は #104。D102）。ラベル（手順3）・アサイン（手順6）と並ぶ**必須の 3 点セット**として扱い、放置しない。**`sub_issues` API は Issue の数値 database id を要求する**（`gh issue view` が返す `node_id`（`I_kwDO…`）を渡すと `422 not of type integer` で失敗する）。

```bash
# 子 issue の数値 dbid を取得（node_id では 422 になる）
CHILD_ID=$(gh api repos/takumi-sano22/proj-poker/issues/${GH_NUM} -q .id)
# 親 Issue（例: Phase 6 なら 105）配下に sub-issue として紐づける（-F で整数として渡す）
PARENT=105
gh api -X POST repos/takumi-sano22/proj-poker/issues/${PARENT}/sub_issues -F sub_issue_id="${CHILD_ID}"
```

> 新たな Phase の親ができたら、その番号を使う。親が不明な単発 issue は紐付けをスキップし、その旨を通知する（issue 作成自体は継続）。

**依存/ブロック（本文参照）**: 依存・ブロック関係がある場合は、issue 本文の `# 参考` セクションに `Depends on #NNN` / `Blocked by #NNN` / `Refs #NNN` を明記する（GitHub がリンク化する）。

### 8. ローカル Issue 記録台帳（proj-poker では使わない）

他プロジェクトでは `docs/issues/` と `wbs.md` にローカル記録を残す運用があるが、**proj-poker では使わない**。Issue の正本は GitHub Issue と親 Issue の sub-issue / DoD チェックであり、docs/ 変更を伴う作業ログは `docs/taskLog/`（`task-log` skill）に残す。したがって docs 変更の PR 作成も本スキルでは行わない（実装・docs の PR は `github-workflow` skill に従う）。

## 出力

以下を報告する：
- 作成した Issue の URL・タイトル・本文プレビュー
- 紐付けた親 Issue（`#105` など。スキップした場合はその理由）
- 付与したラベル・アサイン（担当者 or `@me`）
- 本文に記載した依存・ブロック参照（なければその旨）
