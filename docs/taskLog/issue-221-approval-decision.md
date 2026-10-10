# #221 UX-06 人間承認の正本同期（D143）

## 背景と人間決定

PR #229（MERGED。技術検証テスト13件）の結果に対し、人間が #215 Gate 0 の解除と UX06-1=A / UX06-2=A / UX06-3=A を明示承認した。#215 の Gate 0 は解除済み、Gate 1 / Gate 2 は未解除。

- UX06-1=A: 可視 seq の飛び番を既存の間接的な運用情報推測リスクとして受容。UI は seq と欠番の意味を表示しない。
- UX06-2=A: 演出中の操作下書きは保持。送信前に残りの演出を自動加速して最新公開状態へ追いつき、下書き・手番・可視 lastSeq を検証する。Out-of-Turn も同じ鮮度条件。最新 seq を先取りしない。
- UX06-3=A: 新 API / Event / 永続化の拡張なし。HeroView.log（見える Event 全量）を client が順序化し、projectHeroView(prefix) で表示 Step を作る。裁定 action と ACTION_TAKEN の grouping は Replay と共通。

## 変更範囲

D143 を追加し、既存 D は編集しない。docs/03・04・06・10・11・README・docs/00・開発スキルの D 番号範囲を同期。UX-06 で承認されていない #217 / #219 / #226 の API・Ack・下書き寿命の具体値は採用しない。

## 残課題

- #221 の先行技術検証で未確認だった Tournament Ante / BBA と途中 Side Pot 派生表示は #222・#224 でテストする。
- #215 Gate 1 は未解除（Home Readonly / ETIQUETTE Ack / 下書き仕様 / アセット納品など）。
- 製品コードは変更せず、統合テスト・E2E の新規実行はこのドキュメント PR の範囲外。既存 PR #229 のテスト結果を参照する。
