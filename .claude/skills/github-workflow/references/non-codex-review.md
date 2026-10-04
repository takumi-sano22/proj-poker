# 非 Codex 経路の第 2 段レビュー（reviewer agent）

`github-workflow` skill「PR作成後のレビューフロー / Step 2-B」の詳細。Codex CLI が導入されていない環境（SKILL.md「Codex 導入判定」で `codex-mode.sh` が見つからない）で、**`reviewer` agent を第 2 段レビューとして使う**ときの手順。Codex 経路との違いは「レビュアーが誰か」と「マージ判定を機械化しない」の 2 点だけで、finding の処理規律は同じ。

> Codex を導入したい場合は [`../codex-sample/README.md`](../codex-sample/README.md)（`install.sh`）。導入後は Step 2-A へ切り替える。

---

## なぜ reviewer agent か

- 自己レビューと同じコンテキストで読み直しても、同じ見落とし方を再現する。**別コンテキスト（会話履歴を持たない subagent）** に差分だけを渡すことで独立視点を作る。
- `reviewer` は `tools: Read, Grep, Glob` のみで **Bash を持たない**（構造的に読み取り専用）。レビュー中に作業ツリーが変わる事故が起きない。
- モデルは Opus / effort high（`.claude/agents/reviewer.md`）。Codex の代替として妥当な精度を得るため、下位モデルにしない。

## 手順

### 1. 差分パッチを親が用意する

`reviewer` は Bash を持たないので、**差分は親が保存して絶対パスを渡す**。

```bash
BASE="$(gh pr view --json baseRefName -q .baseRefName)"    # PR の base ブランチ
PATCH="$(mktemp -d)/pr-$(gh pr view --json number -q .number).patch"
git diff "origin/${BASE}...HEAD" > "$PATCH"
wc -l "$PATCH"    # 0 行なら取得失敗。reviewer に渡さない
```

### 2. 必須入力を揃えて起動する

`code-review` skill「準備」で差分クラスを判定し、`.claude/agents/reviewer.md`「入力」が定める**必須入力をすべて**渡す（1 つでも欠けると reviewer は fail-closed で停止する）:

| 必須入力 | 内容 |
|---|---|
| ① パッチ | 手順 1 の絶対パス |
| ② 対象ルート | リポジトリまたは worktree の絶対パス |
| ③ 差分クラス | `code-review` skill「差分クラス」の語彙（複数可） |
| ④ 台帳・チェックリスト | `code-review/references/learned-checks.md` の絶対パス（常に）＋ 該当クラスのチェックリスト（ドメイン差分なら `poker-invariant-review` skill〔#4 で追加〕。未作成の間は `code-review` の H 節） |

任意: 「特に見てほしい観点」「base ブランチ」「設計書・Issue の絶対パス（整合確認用）」。

起動は `subagent-briefing` skill 準拠（会話履歴・ファイル本文を貼らない。パスだけ渡す）。`agentType: reviewer`。

### 3. findings を受け取り、Codex 経路と同じ規律で処理する

reviewer は `重大度タグ｜file:line｜内容｜根拠` の findings（または「指摘なし」）を返す。受け取ったら **[`codex-review.md`「finding の処理」](codex-review.md#finding-の処理4-状態same-root-sweepp2-accept) をそのまま適用する**:

1. 各 finding を 4 状態（`CONFIRMED` / `FALSE_POSITIVE` / `DESIGN_DISAGREEMENT` / `UNPROVEN`）に確定する。security・認証/認可・権限・課金・アーキテクチャ境界に関わる指摘は人間が確定。
2. `CONFIRMED` は same-root sweep してから直す。
3. `[P2]` は根拠付きで accept できる（`[P0]` / `[P1]` は不可）。
4. 修正 push 後の再レビュー要否は「条件付き再レビュー」の表で決める。**再レビューは手順 1〜2 をやり直す**（新しいパッチを保存して再起動。同じ reviewer インスタンスに追加で聞かない —— 前回の判断が文脈として残り、独立視点でなくなる）。

`UNPROVEN` で `[P0]` / `[P1]` 級のものは未検証のままマージしない（Codex 経路と同じ）。

### 4. 結果を PR コメントに投稿する

**指摘なしでも省略しない。** 見出しは `## 🤖 第 2 段レビュー結果（reviewer agent）`。含めるもの:

- レビュアー: `reviewer` agent（model / effort）
- 差分クラス・読ませた台帳/チェックリスト
- findings の一覧と各 finding の最終状態（4 状態）・採否・理由・修正コミット
- `### P2 accept`（該当があれば。書式は `codex-review.md`）
- 再レビューの要否と根拠（再実行しない判断も 1 行残す）
- マージ可否の判断

### 5. マージ判断（人間確認が既定）

非 Codex 経路には `codex-mode`（`stop` / `prereview` / `review-merge` / `autonomous`）に相当する機械的なゲートが無い。したがって:

| 状態 | 扱い |
|---|---|
| `[P0]` / `[P1]` が残る | マージ不可（解消して再レビュー） |
| `[P0]` / `[P1]` 無し・`[P2]` は修正 or accept 記録済み・CI 緑 | **merge-ready**。ただし**マージするかは人間に確認する**（`AskUserQuestion` で PR URL・要点・推奨を提示） |
| 「必ず人間確認で停止する条件」（SKILL.md）に該当 | `clean` でも停止し、要点をコメントに残す |
| ユーザーが**そのセッションで明示的に**「merge-ready なら自動マージしてよい」と指示済み | 上記 merge-ready かつ停止条件非該当なら `gh pr merge` してよい（完了報告は `gh pr view --json state,mergedAt,mergeCommit` を引用） |

`issue-worker` 経路では、Worker が status の `REVIEW2=` に `reviewer:clean` / `reviewer:findings` / `reviewer:skip:<理由>` を返し、マージ判断は親が上表で行う。

### 6. 学習 Capture

`review-learning` skill の呼び出し位置は Codex 経路と同じ（各ラウンドの finding 処理後とループの出口）。reviewer の指摘も Codex の指摘と同じ扱いで候補にする。

## 記録系 docs だけの差分

Codex 経路の「記録系 docs の Codex スキップ」と同じ条件で第 2 段を省略してよい（許可リストはプロジェクトが `codex-review.md` の節に沿って定める。無ければ省略しない）。省略した場合も `## 🤖 第 2 段レビュー結果（reviewer agent）` に「記録系差分のためスキップ」と対象ファイル一覧・自己レビュー結果・CI 結果を残す。

## Codex 経路との対応表

| 項目 | Codex 経路（2-A） | 非 Codex 経路（2-B） |
|---|---|---|
| レビュアー | `codex exec review`（`codex-review.sh`） | `reviewer` agent（Opus） |
| 差分の取得 | スクリプトが作業ツリーから取る | 親が `git diff` を保存して渡す |
| モード / 自動マージ | `codex-mode.sh get` で決まる | 無し。人間確認が既定（明示指示時のみ自動） |
| 結果の投稿 | `## 🤖 Codex レビュー結果` | `## 🤖 第 2 段レビュー結果（reviewer agent）` |
| finding の処理 | `codex-review.md`「finding の処理」 | 同じ |
| 再レビュー | 条件付き（同表） | 同じ。新しいパッチで再起動 |
| 学習 Capture | `review-learning` | 同じ |
| トークン制限 | sonnet フォールバック / halt | 該当なし（Claude 側の制限は通常のセッション運用） |
