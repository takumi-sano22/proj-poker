---
name: issue-patrol
description: "プロジェクトのオープン issue を巡回し、優先度の整理・親 Issue #2 への sub-issue 紐付け確認・進捗コメント投稿・着手候補の選定を行うスキル。「issueを確認して」「issue巡回して」「未対応のissueある？」「今日やることある？」「issue確認して対応して」「タスク確認して」などのキーワードでトリガーすること。実装着手は /github-workflow にディスパッチする。ドキュメントの一括更新は /sync-check を使うこと。"
---

# Issue 巡回・対応

## 概要

オープンな GitHub Issue を巡回し、優先度を整理・親 Issue #2 への sub-issue 紐付けを確認・進捗コメントを投稿し、着手候補を選定する。本スキルの責務は **巡回・状況判定・優先度整理・選定・コメント・ディスパッチ**まで。
**実装そのものは `/github-workflow` が担当する**（worktree で隔離し、原則順次。並行は独立した作業のみ）。本スキルは着手候補を確認したうえで `/github-workflow` にディスパッチする。
docs/ 正本・`decision_log.yaml`・`11_OPEN_ITEMS` などの**一括最新化**は `/sync-check` が担当する。

## 使い方

```
/issue-patrol [--label ラベル名] [--limit N]
```

例: `/issue-patrol --label bug --limit 5`

---

## 実行内容

### 1. Issue 一覧の取得

```bash
# 自分にアサインされた issue（デフォルト）
gh issue list --assignee @me --state open --limit ${LIMIT:-20}

# 未アサイン含む全 issue（プロジェクト全体を巡回する場合）
gh issue list --state open --limit ${LIMIT:-20}

# --label が指定された場合は絞り込む
gh issue list --assignee @me --state open --label "${LABEL}" --limit ${LIMIT:-20}
```

`--label` / `--limit` が指定された場合は上記コマンドに反映する。指定なしの場合はデフォルト（全ラベル・上限20件）で実行する。
`--label` 指定時に結果が0件の場合は、ラベル名のタイポの可能性があるためユーザーに通知する（`gh label list` で利用可能なラベルを確認できる）。

取得した一覧が空（0件）の場合は「対応すべき issue はありません」と報告して終了する。

取得した一覧を以下の観点でソートして優先度を判断する：
- **Priority ラベル**（`priority:urgent` > `priority:high` > `priority:medium` > `priority:low`）。ラベルがない場合は、Phase 番号（`docs/08_MVP_AND_ROADMAP.md` の Phase 0〜8）と親 #2 の DoD の進み具合から優先度を判断する（proj-poker は GitHub Project を使わない）。
- **期限**（マイルストーンの期日が近いものを優先。proj-poker では期限は Phase 順序で管理する。マイルストーンが無ければ Phase 番号の若い順を優先する）
- **種別ラベル**（`blocker` > `bug` > `feature`）
- **最終更新日**（長期間更新なしのものは要確認）

### 2. 各 Issue の状況確認と sub-issue 紐付け確認

各 issue の本文・コメント履歴を読み込み、対応状況を判定する：
- **未着手**: 本文にのみ情報がある
- **進行中**: コメントで作業報告あり、または関連ブランチあり
- **レビュー待ち**: PR が作成されリンクあり
- **ブロック中**: 依存するタスクや情報待ちの記述あり

あわせて、巡回対象の各 open issue が **親 Issue #2（MVP Parent）の sub-issue になっているか**を確認する。Phase に属する issue（タイトルが `[PhaseN]`）は紐付け必須、`[横断]` は必要に応じて。

```bash
# 親 #2 の sub-issue 一覧を取得し、巡回対象の open issue と突合
gh api repos/takumi-sano22/proj-poker/issues/2/sub_issues --jq '.[] | "\(.number)\t\(.state)\t\(.title)"'
# 未紐付けだった場合は数値 id で紐付ける（node_id では 422 になる）
CHILD_ID=$(gh api repos/takumi-sano22/proj-poker/issues/<n> -q .id)
gh api -X POST repos/takumi-sano22/proj-poker/issues/2/sub_issues -F sub_issue_id="${CHILD_ID}"
```

**学習候補の蓄積も見る**（`review-distillation` skill を採用している場合）: 本文検索で拾ったマージ済み PR（直近 N 件に絞らない）の `## Review learning` 節（ラウンドごとの「候補 N 件（area severity …）— URL」）を読み、①候補の合計が概ね 5 件以上 ②同じ `area` の候補が 3 件前後 ③`P0` / `P1` の候補がある、のいずれかなら **`review-distillation` の起動（独立 Issue）を着手候補に含めて提案する**。候補の中身（root failure class・destination）を読んで判定するのは Distill の仕事なので、ここでは本文の行から拾える件数・領域・重大度だけを見る。**行末に `（distilled: #N）` が付いた行は全候補が処理済みなので数えない**（一部処理の候補は Distill 側が候補ブロックの `distilled:` 行で識別する。巡回は本文の行だけで足りる）。本節はプロジェクト固有版にだけある場合がある（global 版と同名のため、巡回時はプロジェクト固有版があればそちらを優先して Read で読む）。

```bash
# 候補を持つマージ済み PR を拾い、本文の `## Review learning` 節だけを読む
gh pr list --state merged --limit 200 --search '"Review learning" in:body' --json number,mergedAt --jq '.[] | "\(.number)\t\(.mergedAt)"'
# 上限到達の判定はフィルタ前の取得件数（`--json number --jq length`）で行う。200 と同数なら上限到達。最古の mergedAt の日付を `merged:<=YYYY-MM-DD` に足して続きを取り、200 未満になるまで繰り返す（review-distillation と同じ期間カーソル。境界日を含めるので重複は PR 番号で除く）
gh pr view <PR> --json body --jq .body | sed -n '/^## Review learning/,/^## /p'
```


### 3. 着手候補の選定とバッチ確認

**ブロック中・レビュー待ちの issue は着手候補に含めない。**
- **ブロック中**: ブロック理由を整理してユーザーに報告し、解消策（依存 issue の優先度変更・情報収集依頼等）を提案する。
- **レビュー待ち**: 関連 PR を提示し、ユーザーにレビュー依頼を促す。

以下の種類の issue を着手候補として提示する：
- バグ修正（再現手順が明確なもの）
- ドキュメント更新・誤記修正
- 小規模な機能追加・リファクタリング

`phase-planning`（#4 で追加）で分解済みの Phase Issue は規模によらず候補に含めてよい。分解されていない大規模な機能追加・アーキテクチャ変更、`decision_log.yaml` の既存判断の上書きや Open Item の確定を要するもの、docs の停止ゲート（親 #2 の実装開始 Gate 等）が未解除の実装は候補に含めず、セッション冒頭の質問か Issue コメントで人間に返す。

着手候補群について「対象 issue・想定作業内容・影響範囲」をまとめる。proj-poker は自走が既定のため、**確認はセッション冒頭の `AskUserQuestion` に含める**（冒頭で承認済みなら確認せず着手する。作業途中で追加確認しない）。
未アサインの issue を含む場合は `gh issue edit {number} --add-assignee @me` で割り当てる。

### 4. github-workflow へのディスパッチ

確認が取れた着手候補群を `/github-workflow` に渡して実装させる。`/github-workflow` が worktree による並列実装・テスト/lint・品質ゲート・PR 作成までを担う。


戻り値として各タスクの PR URL・テスト結果を受け取り、次のコメント投稿・最終報告に反映する。本スキルではブランチ作成・実装・PR 作成を直接行わない（`/github-workflow` の責務）。

### 5. 進捗コメントの投稿

ディスパッチして対応した issue にのみコメントを投稿する（ステータス変化なしの issue にはコメント不要）。ユーザー確認後に実行する。

コメントの形式:
```markdown
## 対応状況

- ステータス: 進行中 / 完了 / ブロック中
- 実施内容: （何をしたか）
- 次のアクション: （次に何をするか）
- 関連 PR: （`/github-workflow` が作成した PR の URL）
```

PR は github-workflow が `Closes #xxx` 付きで作成済みのため、コメントにはその PR URL を反映する。

## 出力

以下をまとめて報告する：

- **巡回した issue 一覧**（件数・優先度ソート後の順序）
- **sub-issue 紐付け状況（親 #2）**（未紐付けだった issue / 追加した issue）
- **ブロック中の issue**（ブロック理由・解消策の提案）
- **レビュー待ちの issue**（関連 PR の URL）
- **ディスパッチした着手候補**
- **投稿したコメントの一覧**

docs/ 正本・`decision_log.yaml`・`11_OPEN_ITEMS` などの一括最新化が必要な場合は `/sync-check` の実行を提案する。
