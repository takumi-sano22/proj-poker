# Phase 6 の分解（phase-planning）

## 概要

#104 の Documentation Gate の解除（PR #109 のマージと人間のチェック）を受けて、`phase-planning` で Phase 6（#105）を子 Issue に分解した。人間判断（2026-10-07・AskUserQuestion）を D110〜D112 として記録する。

## 起票した Issue（#105 の sub-issue・依存順・各本文に `Depends on`）

| ID | Issue |
|---|---|
| P6-1 | #112 Analytics Projection / Detailed Stats |
| P6-2 | #113 Ability Evidence / ScoringPolicy |
| P6-3 | #114 Hypothesis / Recent・Long-term Profile |
| P6-4 | #115 User Read（Event）/ Note・Tag |
| P6-5 | #116 Session Review / Learning UI |
| P6-6 | #117 Targeted Drill（決定論の変形だけ） |
| P6-7 | #118 Reset / Rebuild |
| P6-8 | #119 Eval / Critical E2E / README |

## 人間判断（AskUserQuestion の回答。すべて推奨案）

- 分解は #105 の推奨どおり 8 Issue（D110）
- Phase 6 の Projection は都度計算・保存しない（D111）
- User Read は `USER_READ_RECORDED`（schema_version 8）、Note / Tag はマイグレーション v5 の追記型テーブル（D112）
- Drill は決定論の変形だけ。LLM での Spot 生成は Phase 6 の範囲外（D110）

## 変更内容

- `docs/decision_log.yaml`: D110〜D112 を追記（既存の D は変えていない）
- `docs/08` §3.1: 子 Issue の表に番号を付けた
- `docs/04` §12: Projection を保存しないこと・User Read / Note / Tag の保存の形
- `docs/07` §7: Phase 6 の Drill は決定論の変形だけ
- `docs/10`: 判断グループ表。範囲表記を D01〜D112 に（docs/00・docs/10・README・skill 2 つ）

## 調べた現状（起票の前提）

- `USER_READ_RECORDED`・`HINT_OPENED`・Note / Tag・Reset は未実装。Event は版 7、DB は v4。
- `events`・`reviews` 等は Trigger で UPDATE / DELETE を拒否している。正本を消す Reset の経路は #118 の範囲外とし、要るなら人間判断に返すと本文に書いた。
- Session 終了後の画面は「新しい Session を始める」Button だけ（#116 で作る）。

## 実行した確認

- `decision_log.yaml` が YAML として読め、末尾が D112（112 件）
- 範囲表記が D01〜D112 にそろっている（`grep -rn "D01〜D1"`）
- 品質チェック 4 つ（結果は PR に記載）
- 品質チェック: lint / typecheck / format:check は exit 0。`pnpm test` は 1 回目だけ exit 1（出力を残しておらず、落ちたテストは特定できていない）、その後 3 回続けて全件 passed（engine 333・web 122・server 445）。docs だけの差分なので、既存テストの不安定さとみて記録する。
