---
name: test-and-review
description: 実装後に差分確認・テスト実行・リスク確認・作業ログ更新を行うために使用する。コード変更をコミット/PRする前の動作確認フェーズで使う。「動作確認して」「テストして」「差分をレビューして」「リスクを確認して」「実装後のチェックをして」といったリクエストでトリガーする。テスト、動作確認、差分確認、リスク確認、test and review などのキーワードで使用すること。
when_to_use: 実装が一段落しコミット/PR前の動作確認をする時に自動で使う。差分確認→テスト/lint/型/format 実行→リスク確認→作業ログ更新の一連を回す。
---

# test-and-review Skill

## 目的

実装後に、変更が意図通りであるか確認し、未確認の範囲を明確にする。

## 手順

1. `git diff` で変更差分を確認する。
2. 変更範囲に応じて確認コマンドを選ぶ。
3. コード変更なら、ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check` を実行する（CI と同じ。一覧は `CLAUDE.md`「品質チェック」）。整形が崩れていたら `pnpm format` で直す。
4. Poker Engine（Rule / GameState / 合法アクション / Pot・Side Pot 等）の変更なら、`poker-engine-testing` skill を参照する。Chip 総量保存・合法アクション・Event Log からの再現を確認する。
5. LLM に渡すコンテキストや Review に触れる変更なら、`poker-invariant-review` skill の観点（他者 Hole Cards・Future Cards・他 CPU の Private Observation の漏えい、Hindsight Leak）で確認する。
6. テスト結果を作業ログ（`docs/taskLog/`・`task-log` skill）に記録する。
7. 未確認の範囲があれば明記する。
8. 最終報告では、変更内容・作業ログ・テスト結果・残課題を伝える。

自動テストは `pnpm test`（Vitest。`packages/engine`・`apps/server`・`apps/web` がそれぞれ vitest と `test` script を持つ。新しいパッケージにテストを足すときは、そのパッケージに vitest と `test` script を足す）。docs のみの変更では、`docs/` 内の相互参照・Decision ID（D01〜D133）・Open Item ID の整合を確認し、`git diff` で意図しない変更が無いことを確認する。動作確認が必要な場合は、確認した範囲と未確認の範囲を作業ログに明記する。

## Lintチェック（コミット前必須）

- コード変更時は `pnpm lint` を実行し、**エラー0件**を確認してからコミットへ進む（pre-commit hook は無いので手で通す・D69）。
- 意図的に未使用の引数・変数・catch句は `_` 始まりにする。将来使う拡張ポイントの引数を、lint回避のために実装側から削除しない。

## 注意点

- 実行していないテストを成功扱いしない。
- テスト不能な場合は理由を書く。
- 変更範囲外の問題を勝手に修正しすぎない。
