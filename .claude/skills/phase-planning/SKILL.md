---
name: phase-planning
description: proj-poker の Phase 着手時に docs/08 の Phase と親 Issue #2 の DoD を突き合わせて子 Issue に分解し、起票・sub-issue 紐付け・完了判定まで行う skill。「Phase を始める」「Phase N に着手」「Phase を分解して」「子 Issue に分けて」「ロードマップを Issue 化」「Phase 完了判定」「DoD を更新」「Scope Creep」で起動する。
---

# phase-planning — Phase の子 Issue 分解と完了判定

`docs/08_MVP_AND_ROADMAP.md` の Phase（0〜8）を、親 Issue #2（MVP Parent）の DoD と突き合わせて**1 Issue = 1 PR で順次マージできる粒度**の子 Issue へ分解する。Issue 作成そのものは `create-issue`、人間判断の記録は `decision-log` に委ねる。**Phase の中身（何をやるか）は docs/08 §3 が正本で、本 skill には写さない。**

## 前提ゲート（最初に確認する）

- **実装開始ゲート**（`CLAUDE.md`「自走ルール」・`docs/00` §7・`docs/08` §5）: 親 #2 の Gate「追加された Skills / Harness をこの PJ の開発規約として確認する」に人間がチェックを入れるまで、Phase 0 / 1 のプロダクト実装は始めない。`gh issue view 2` でチェック状態を確認する。
- **未解除の場合**: **Phase 0 のうち実装を伴う項目（TypeScript Project Skeleton / Lint / Typecheck / Test 等）と Phase 1 以降**は「**起票まで可・着手不可**」。子 Issue は作ってよいが、worktree 作成・実装・PR 作成には進まない。Issue 本文にも「実装開始ゲート未解除のため着手不可」と明記する。ゲートが解除されたら、着手時にこの注記を本文から消し、解除を確認した旨をコメントする。**AI がゲートを自己判断で解除しない。**
- harness・docs の整備（Phase 0 のうち実装を伴わない部分）はゲート対象外。

## 手順

### 1. 対象 Phase と DoD を突き合わせる

1. `docs/08` §3 の対象 Phase の項目と、`gh issue view 2` の「MVP Definition of Done」を並べ、**どの DoD 項目をどの Phase が満たすか**を対応づける（DoD の分類は `docs/08` §2 と同じ）。
2. 既存の子 Issue を確認する（`gh issue view 2` の sub-issues と `gh issue list --search "[PhaseN]"`）。重複起票しない。
3. Phase 5 の Solver Adapter 関連は `solver-poc` skill（OI-002）の結果に依存する。Poker の不変条件に触れる分解は `poker-invariant-review`の観点も参照する。

### 2. Scope Creep を除外する

`docs/08` §4 の「MVP を Block しない項目」（Full Multiway Solver・Tournament・高度 Persistent CPU Memory 等）が分解結果に紛れていたら、**MVP の Phase（0〜5）の子 Issue には入れず**、後続 Phase（6〜8）か別 Issue に回す。迷ったら「MVP の DoD のどれを満たすか」で判定し、どれも満たさなければ入れない。

### 3. 子 Issue に分解する

- **粒度**: 1 Issue = 1 PR で、他の未マージ Issue がなくても単独でレビュー・マージできる大きさ。大きすぎれば縦（機能単位）で割り、横（レイヤ単位）に割って中間状態のまま放置しない。
- **依存順**: 先にマージすべき Issue を先に置く。各 Issue 本文の `# 参考` に `Depends on #NNN` を書く（`create-issue` 手順 7「依存/ブロック」）。
- **タイトル**: `[PhaseN] <やること>`（N は docs/08 の Phase 番号。規約の一次情報は `CLAUDE.md`）。Phase に属さない横断作業は `[横断]`。
- **本文**: WHY（満たす DoD 項目・参照する docs 節番号）/ WHAT（完了条件）。docs の内容は写さず節番号で参照する。
- 決まっていない論点は `docs/11_OPEN_ITEMS.md` の OI を確認する。可逆な暫定値で進められるものは Issue 本文に OI 番号を明記し、不可逆なものは次節の AskUserQuestion に回す。

### 4. 人間確認はセッション冒頭の 1 回に集約する

分解案（Issue 一覧・依存順・除外した項目）と未決の論点を**セッション冒頭の `AskUserQuestion` 1 回にまとめる**。Issue ごとに細切れで聞かない。回答のうち仕様・方針に関わるものは `decision-log` skill で D 番号に記録する。承認後は自走で起票する。

### 5. 起票と親 #2 への紐付け

承認された分解案を依存順に `create-issue` skill で起票する。ラベル・アサイン・親 #2 への sub-issue 紐付けは必須の 3 点セット。紐付けコマンドは `create-issue` 手順 7 が一次情報（`sub_issues` API は node_id ではなく数値 id を要求する）。ここに写さない。

起票後、`gh issue view 2` の sub-issues に全件並んだことを確認する。

## Phase 完了判定

1. 親 #2 の DoD チェックボックスを更新してよいのは、**対応する PR がマージされた後だけ**。マージ前・レビュー中にチェックを入れない。
2. チェック更新の前に、実出力を引用して根拠を示す（例: `gh pr view <n> --json state,mergedAt,url` の出力、Phase 完了時の `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check` の実出力）。引用できなければ完了と言わない。
3. DoD の項目が Phase の途中で部分的にしか満たされていない場合はチェックしない。
4. 子 Issue がすべてクローズされ、対応する DoD 項目が更新されたら Phase 完了。その時点で **`release-readme-sync` skill** に進み、README 等との同期を行う。
5. 実装開始ゲートの Gate 項目（親 #2 の「開始条件」）のチェックは**人間だけ**が行う。AI は更新しない。

## やってはいけないこと

- ゲート未解除のまま Phase 0 / 1 のプロダクト実装に着手する。
- `docs/08` §4 の非ブロック項目を MVP Phase の子 Issue に入れる。
- マージ前に DoD にチェックを入れる／実出力なしに「完了」と書く。
- docs/08 の Phase 内容や DoD を本 skill や Issue 本文に丸写しする（正本は docs と #2）。
- 分解結果を Issue ごとにバラバラに人間へ質問する。

## 完了条件

- 全子 Issue が `[PhaseN]` タイトル・ラベル・assignee・親 #2 sub-issue 紐付け・（依存がある Issue は）`Depends on` を持つ。
- 人間確認が冒頭の AskUserQuestion 1 回で済んでいる。
- ゲート未解除なら、Issue 本文に「着手不可」が明記されている。
