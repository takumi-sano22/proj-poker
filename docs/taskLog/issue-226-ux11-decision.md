# #226 UX-11 人間承認の正本同期（D145）

## 目的

PR #240（MERGED。ETIQUETTE の Ack 待ちの先行技術設計と検証テスト）に対する人間判断を、`decision_log.yaml` の D145 と正本 docs に記録する。機能は実装しない。

## 人間決定

- UX11-1〜5（#226 issuecomment-6100090335）: Ack の位置は `HandRuntime` のメモリ（Event / DB は不変）、`POST /api/hands/:handId/etiquette-ack {rulingSeq}` と REST / SSE の `{revision, pendingRulingSeq}`（二重は 200・古い seq は 409 `stale_etiquette`）、Ack 待ちの Hero の操作は 409 `etiquette_ack_required`（User Read は可）、Hand の完了後も待ちを残して確認まで次の Hand を始めない、Outage のダイアログが先で Retry / Emergency Bot の後も Ack まで止める、再起動での消失は D62 の範囲。
- T1=A（#226 issuecomment-6100549843）: UX11-5 の具体化。Tournament のプレイ時間（D128）に入れる Ack 待ちは Hand の進行中だけで、`HAND_FINISHED` の後から Ack までは Hand の間として除外する。

## 変更内容

- `docs/decision_log.yaml`: D145 を追加（既存 D は編集しない）。
- `docs/02`: time-base のプレイ時間に T1=A を、§8 ETIQUETTE に Ack で進行を止めることを追記。
- `docs/03` / `04` / `06` / `11`: UX-11 の「人間の承認待ち」を D145 の採用済み・未実装の記述に置き換え。
- `docs/10`: D145 の行と Q28・Q29 の対応。
- 範囲表記 D01〜D145: `decision_log.yaml`・`docs/00`・`docs/10`・README・`sync-check` / `test-and-review` skill。

## 判断理由

- T1=A は今の実装のままで成り立つ: `HandOrchestrator` は `HAND_FINISHED` を追記した時点で `playFinishedAt` を固定し、`elapsedPlayMs` / `handPlayTimeMs` はその値までしか数えない（`apps/server/src/hand-orchestrator.ts`）。Hand の完了後の Ack 待ちは何もしなくても数えられない。
- PR #240 の作業ログ（`issue-226-etiquette-ack-design.md`）は検証当時の記録なので書き換えない。その中の「実装時の検証テスト」の「Session 終了で Ack 待ちが消える」は、同じ資料の §5・§7（`HAND_ABORTED` の後も待ちを残す）と食い違う。D145 は人間が採用した §5・§7 / UX11-4 の側で記録した。本実装のテストは D145 に合わせる。
- #230 の Session の終了 / 一時中断の予約と、Hand の完了後に残る Ack 待ちの関係は #230 が未承認なので確定させず、D145 に「#230 の設計で再確認」と書いた。

## 実行した確認

- `git show origin/main:docs/decision_log.yaml | grep -o "id: D[0-9]*" | tail -1` → `id: D144`（D145 が次）
- YAML の読み込み（145 件・最後が D145）
- `grep -rn "D01〜D14"`（taskLog を除き D01〜D145 にそろう）
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`

## 残課題

- #226 の本実装（#215 Gate 1 の解除の後）。PR #240 の検証テストを新しい成功条件へ置き換える。
- #230 の設計で、Session の終了 / 一時中断と Hand の完了後の Ack 待ちを再確認する。
- RULING を自動で閉じる「数秒」は OI-012 の暫定値のまま。
