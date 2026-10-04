# docs-harness — 記録・設計書・skill・ハーネス資産を書く前の判定基準

**本書が一次情報である範囲**: 実装時の確認動作。**一次情報が別にある範囲**: 標準フロー・worktree・コミット・PR・レビュー順序は `github-workflow` skill、Issue 起票は `create-issue` skill、判断の記録は `decision-log` skill、skill の品質基準は `add-skill` skill、三者整合は `sync-check` skill、作業ログは `task-log` skill。

## 書く前に決めること

1. **同じ事実は複数系統に散る前提で動く**: ①設計書（`docs/`） ②`docs/decision_log.yaml`（D 番号） ③`docs/11_OPEN_ITEMS.md` ④GitHub Issue 本文 ⑤作業ログ（`docs/taskLog/`）。**状態を変えたら特徴的な語句で repo 全体を `grep -rn` し、GitHub 側も `gh issue view <n> --json body` で走査し、直した後に再 grep して未解消 0 件を確認する**。委譲して作らせた文書ほど同期対象から抜ける。解決済みにするときは記述を消さず「〜だった → #NNN で解消」と残す。
2. **仕様値（保持期間・集計粒度・日付基準）を変えるときは、値そのものと「同じ事実の別の言い回し」の両方で grep し、ヒット行を全文読む**（1 行に 2 つの値がある）。`grep -v` で自分の変更行を除外しない。不変条件は値が入ってくる経路ごとに掛ける。
3. **`decision_log.yaml` の D 番号は、記録の直前に最大使用番号を grep で確認してから採る**（`grep -o "id: D[0-9]*" docs/decision_log.yaml | sort | tail`）。採用済み判断は AI が上書きしない。採番を伴う PR は push 直前とマージ直前に `git fetch` して再確認する（レビュー中に他 PR が消費する）。ローカル Issue 記録は使わない（Issue は GitHub のみ）。
   - **記録の docs PR を委譲した場合、親が累積差分（`git diff origin/main...HEAD`）で既存行の削除が無いかを直読する**。`gh pr diff --patch` は使わない（コミットごとの patch 連結で削除が大量に見えて誤診する）。
4. **着手前だけでなく push 直前にも `git fetch origin && git log --oneline origin/main -5`** を見る。本体作業ツリーの main は `fetch` では進まないので、「無い」を結論する前に `git show origin/main:<path>` か origin/main 基点の worktree で確認する。
5. **worktree で commit させる委譲 prompt には、`pnpm install --frozen-lockfile` と、push 前に `pnpm lint` / `typecheck` / `test` / `format:check` を通すことを書く**。pre-commit hook は無い（D69）ので、書かないと整形漏れがそのまま push され、CI の `format:check` で赤になる。`node_modules` の symlink は不要（`github-workflow`「worktree の依存」）。
6. **CI の確認とマージを同じコマンドに書かない**。`gh pr checks` を単独で読んでから、別の呼び出しでマージする。CI が pending のうちはマージしない（docs のみの PR でも例外にしない）。
7. **長い待ち（デプロイ・CI・バッチ）は Monitor ツールで**。bash のバックグラウンドループは OOM で `killed` され、待っていた処理は動き続けるので「止まった」と誤読して二重 dispatch しかねない。`killed` を受けたら実体を API で読む。
8. **skill を書く・直すとき**: description は短く（300 字前後・英語トリガー不要・例の羅列不要）。frontmatter は `claude plugin validate <skills dir>` で検証する（YAML が壊れると無言で全フィールドが捨てられる。修正は `>-` の折りたたみブロックスカラー）。**書いた基準を自分の成果物に当ててから PR を出す**（チェックリスト skill が自分の基準を満たしていないと第 2 段レビューに何巡も指摘される）。
9. **global と同名の skill / agent はプロジェクト版を優先する**。同名は global 版が読まれるため、固有版は `.claude/skills/<name>/SKILL.md` を Read で読む。両方に置く資産は `diff -rq` で差分が固有分だけであることを確認する。
10. **Prettier は表セルの `*` や `|` で無関係な行を壊す**。表は行番号で編集し、`git diff --word-diff` で意図しない変更を確認する。コンフリクトマーカーが残った状態で Prettier を掛けない（復旧は `git checkout -m`）。

## 確認動作（実装後・自己レビュー前）

- 状態変更を含む差分は、特徴語で `grep -rn` した結果（0 件）を PR 本文に書く
- `decision_log.yaml` を触る PR は、採番した D 番号と根拠の docs 節を PR 本文に載せる
- skill / agent を足した・直した PR は `claude plugin validate` の結果を書く
