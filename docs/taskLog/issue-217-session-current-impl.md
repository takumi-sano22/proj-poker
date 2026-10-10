# Issue #217: UX-02 Home の読み取り専用の Session 照会の実装（D144）

## 目的

D144（UX02-1〜3=A と #217 のコメントの追加条件）に従い、Home の読み取り専用の照会 `GET /api/session/current` を実装する。Home の画面（UX-03 #218）、Session の Pause / End（#230）、Presentation Controller（#222）は作らない。#215 Gate 1 / Gate 2 は解除しない。

## 変更内容

- `apps/server/src/hand-orchestrator.ts`: `currentSession()`（状態と Session の種類だけ）と、開始の `unseenLatestHand` と共有する判定 `lastHandOf`（resumed / stalled / live）を追加した。照会は Session Projection を写さず、この共有の判定から作る。
- `apps/server/src/routes/hands.ts`: `GET /api/session/current` → `{ session: CurrentSession | null }`。
- `apps/web/src/lib/api.ts`・`view-model.ts`: `fetchCurrentSession` と受け側の whitelist の `parseCurrentSession` を追加した。知らない state・知らない Preset・形の合わない値は null として扱い、「続きから」を出さない。Home の画面はまだ無いので呼び出し元はない（UX-03 で使う）。
- テスト: `apps/server/src/session-current.test.ts`（検証の PR #236 の `session-readonly-verification.test.ts` を、private の読み出しから `currentSession()` へ置き換えて改名した。10 件）、`apps/server/src/routes/session.test.ts`（3 件: Session なし・返す項目・二重タブ / 連打と開始の冪等性・`stale_view`）、`apps/web/src/lib/view-model.test.ts`（`parseCurrentSession` 2 件）。
- docs: `docs/03` の §1 の API の表と Session の節、§2 の横断 UI/UX の段落、`docs/06` §16 の冒頭。

## 判断理由

- 内部エラーで止まった Hand は、Event だけを見ると `in_hand` だが、開始すると新しい Session になる。そのため照会は null にした（D144「照会できた状態と実際に続けられる状態を混同しない」）。
- `ended` はこのプロセスの指し先からしか作らないので、再起動後は null になる（D144。終わった Session の履歴は照会しない）。
- Hand ID を返さない（UX02-1=A）。「続きから遊ぶ」は既存の冪等な `POST /api/hands` に集約する。

## 実行した確認

結果は PR の Test plan に記載する。

## 残課題

- Home の画面と「続きから遊ぶ」（UX-03 #218）
- #230 の承認後に `paused` 等の state を追加する（client は今は null として扱う）。Q43=A に関わる判定の差は #230 で扱う
