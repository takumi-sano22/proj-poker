# #219 UX-04 人間承認の正本同期（D146）

## 目的

PR #242（MERGED・19ebe80。下書きの寿命の先行技術検証と検証テスト 9 件）に対する人間判断 UX04-1〜3=A を、`decision_log.yaml` の D146 と正本 docs に記録する。機能は実装しない。

## 人間決定（#219 の 2026-10-11 の人間判断のコメント）

- UX04-1=A: 同じ Hand・Street・Hero の裁定の数のまま CPU の Bet / Raise で状況（`currentBet`・Hero の `streetCommitted` 等）が変わっても下書きは保持する。送る前に D143 のとおり displayed を authoritative に同期し、錨の `operationKey` と状況を再検証し、変わっていれば変化を示して Hero にもう一度確定させる。自動送信・補正はしない。Street / Hand の変化・Hero への新しい裁定・Fold / All-in 等の失効条件では破棄して通知する。
- UX04-2=A: `TurnDraft` と錨を画面の切り替えより上の App の層に Session ごとのメモリで持つ。パネルの開閉・Home / Learn / Replay / Review・Outage の Dialog の間も有効なら保持。再読み込み・再起動の復元は不要。Event / DB / API に書かない。
- UX04-3=A: 中身のあった下書きを失効で破棄したときだけ、操作パネルの近くに短い非モーダルの通知。空の下書きでは出さない。

## 変更内容

- `docs/decision_log.yaml`: D146 を追加（既存 D は編集しない）。
- `docs/03` §横断 UI/UX・`docs/04`「表示の状態は Event Log に入れない」・`docs/06` §3 / §16.3 / §16.4 / §16.8・`docs/10`（D146 の行・Q12・Q24）・`docs/11`（OI-012 の確定 / 未確定の一覧・UX-04 を解消済みへ）。
- 範囲表記 D01〜D146: `decision_log.yaml`・`docs/00`・`docs/10`・README・`sync-check` / `test-and-review` skill。
- Issue #219 の本文の「人間判断待ち」・旧 Gate 0 の説明を現在の状態へ更新。

## 判断理由

- D146 は D139（下書きの保持と無効化の通知）・D143（送る前の同期と再検証）・D145（Ack 待ちは送れない）の具体化で、どれとも矛盾しない。Game Engine・Event・API・DB は変えない。
- 「Fold / All-in で破棄」には、PR #242 の自己レビューで見つけた「Blind / Ante の支払いでの All-in は裁定を伴わない」場合を含めた（key だけでなく状態でも判定する）。
- PR #242 の作業ログ（`issue-219-draft-lifecycle-design.md`）は検証当時の記録として書き換えない。

## 実行した確認

- `git show origin/main:docs/decision_log.yaml | grep -o "id: D[0-9]*" | tail -1` → `id: D145`（D146 が次）
- YAML の読み込み（146 件・最後が D146）
- `grep -rn "D01〜D14"`（taskLog を除き D01〜D146 にそろう）
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`

## 残課題

- #219 の本実装（#215 Gate 1 の解除と #218 の後）。検証テスト T2（状況の変化を key が検知しない）は、本実装で `anchorContext` の比較と再確認のテストへ置き換える。
- 通知の文言・表示時間は OI-012 の暫定値。
