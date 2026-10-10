# #217 UX-02 人間承認の正本同期（D144）

## 背景と人間決定

PR #236（MERGED。検証テスト 10 件）の結果に対し、人間が UX02-1=A / UX02-2=A / UX02-3=A を採用し、#217 のコメントにある追加の検証条件も適用すると指示した。#215 Gate 1 / Gate 2 は未解除。

- UX02-1=A: `GET /api/session/current` が `{session: null}` か state（`in_hand` / `ready_for_next_hand` / `ended`）と Session の種類（cash / Tournament の Preset）だけを返す。Session ID・Hand ID・Stack・札・Persona は返さない。「続きから遊ぶ」は Hero の操作で既存の `POST /api/hands` を呼ぶ。
- UX02-2=A: このプロセスで終わった Session は `ended` を返す。終わった Session の履歴の永続的な照会は作らない（再起動後は `null`）。
- UX02-3=A: 今の状態の列で #217 を先に実装し、#230 の承認後に `paused` 等を追加する。

追加の検証条件: 照会は Projection を写さず開始と同じ読み取り専用の判定を共通化して作る。起動・CPU の思考中・再起動・Drill の除外・卓の設定の変更・内部エラー・二重タブをテストする。照会で Hand / Session の作成・Event の追記・CPU の推論・課金をしない。`POST /api/hands` の冪等性と `stale_view` を変えない。`ended` / `null` の意味と未知の state の安全な扱いを docs とテストに固定する。

## 変更範囲

D144 を追加し、既存 D は編集しない。docs/03・06・10・11・README・docs/00・開発 skill の D 番号範囲を同期。照会 API の実装は別 PR（#217）。

## 残課題

- 照会 API の実装と docs/03・04 の API 記述（#217 の実装 PR）
- Home の画面（UX-03 #218）、Session の Pause / End（#230）
