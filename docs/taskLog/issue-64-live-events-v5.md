# Issue #64: 宣言・物理操作・裁定を Event Log に残す（schema_version 5）

## 概要

Hero の宣言・物理的な Chip の操作・Dealer の裁定を `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` / `DEALER_RULING` として Event Log（正本）に残すようにした。Event の `schema_version` を 5 に上げ、版 1〜4 の行はそのまま読める（保存済みの行は書き換えない。D76）。server に Hero の PhysicalAction を受け付ける `POST /api/hands/:handId/physical-actions` を足し、#63 の Ruling Engine で裁定 → Canonical Action の適用 → Event の追記を行う。Out-of-Turn の「警告して保留 → Hero の手番で拘束 / 撤回」は Event の並びだけから復元できる。

## 初期調査

- 前提（main 187896c）: #63 で `packages/engine/src/ruling.ts`（`rulePhysicalActions` / `resolveOutOfTurn`）と `TableConfig.ruling`・Rule Profile `phase4_provisional_v1` があり、Event は発行していない。
- 前例 #48（版 4 で `AI_ACTION_INVALID` / `AI_FALLBACK_USED` を追加。Visibility `system`・State を変えない Event・版 3 以上を upcast しない）を読んだ。
- D90（3 種の Event と版 5。人間判断済み）・D91・D73・D76、docs/02 §4・§8、docs/03（Engine の入口・Orchestrator・API）、docs/04 §3〜§5 を読んだ。
- CPU の Claude Prompt は `KnowledgeState` を丸ごと JSON にする。AI Opponent Eval の録画は Prompt の指紋で再生するので、`KnowledgeState` に項目を常に足すと録画の再生（CI）が落ちる（取り直しは Claude を呼ぶ手動の Eval）。

## 変更内容

- `packages/engine/src/hand-events.ts`: 3 種の Event（`PLAYER_DECLARED`: `declaration` / `PHYSICAL_CHIP_ACTION`: `motion`・`chips` / `DEALER_RULING`: `basis`・`outcome`・`action`・`notes`。どれも `playerId`・`street`）と `RulingBasis` / `RulingOutcome`。Visibility は 3 種とも `public`。
- `packages/engine/src/hand-state.ts`: `HandState` に `operations`（同じ追記の裁定を待つ操作）と `pendingOutOfTurn`（`DEALER_RULING` の `out_of_turn` で入り、`pending_out_of_turn` の裁定で消える）。3 種の Event は Chip・手番を変えない。
- `packages/engine/src/hand-engine.ts`: `applyPhysicalActions`（裁定して操作ごとの Event・`DEALER_RULING`・決まった `ACTION_TAKEN` までを 1 つの結果で返す）・`resolvePendingOutOfTurn`（保留した OOT を手番で拘束 / 撤回）。保留中の 2 回目の操作と、その Player の `applyAction`（Canonical Action での上書き）は `not_actor`。
- `packages/engine/src/projection.ts`: `KnowledgeState.rulingHistory`（公開の 3 種の Event から組んだ裁定の履歴。裁定が無い Hand では項目ごと持たない）と `PublicRulingRecord`。Hero View は `log` に 3 種の Event が入る。
- `packages/engine/src/index.ts`・`ruling.ts`・`table-config.ts`: 公開とコメントの更新。
- `apps/server/src/sqlite-event-store.ts`・`event-upcast.ts`: `EVENT_SCHEMA_VERSION` を 5 に上げ、版 4 の型（`HandEventV4`）を足した。版 3 以上は変換せずに読む（DB のテーブル・列は変えていない）。
- `apps/server/src/hand-orchestrator.ts`: `heroPhysicalAction`（stale_view の判定は `heroAction` と共通化）。CPU の手番を進める `runCpuTurns` で、Hero の手番が来て保留があれば `resolvePendingOutOfTurn` で裁定して追記する。
- `apps/server/src/routes/hands.ts`: `POST /api/hands/:handId/physical-actions`（JSON Schema で形を検証。操作は 1〜20 個、Chip は 1 動作 1〜100 枚）。既存の `/actions` は残す。
- `apps/web/src/lib/view-model.ts`: 3 種の Event はログの行にしない（文言は #66）。
- テスト: `packages/engine/src/live-events.test.ts`（新規 11 件）、`ruling.property.test.ts` に Event 経路の Property（300 run）、server の orchestrator（4 件）・routes（2 件）・SQLite（版 4 の行の読み込み・版 5 の保存と再読込）。
- docs: docs/02 §4、docs/03（Engine の入口・Orchestrator・API 表・§5 の KnowledgeState）、docs/04 §3（Event 表・Orchestrator の追記・版 5）・§4・§5。

## 判断理由

- **Event の形**: 操作は 1 動作 1 Event（`PHYSICAL_CHIP_ACTION` の `motion` で String Bet の判定材料を残す）、宣言は 1 宣言 1 Event、裁定は 1 つの `DEALER_RULING` にまとめた。`basis` で「直前の操作への裁定」と「保留していた OOT への裁定」を区別し、保留の出入りを Event の並びだけで復元できるようにした（Replay #68 の前提）。保留の Street・最高額は Event に重複して持たず、畳み込みの State から取る。
- **Visibility は public**: 実卓で全員が見聞きする事実（D90 の Issue 文面どおり）。Persona・CPU の内部情報は含まない。
- **既存の `/actions`（Canonical Action）は残す**: web の操作の置き換えは #65 の担当で、この Issue で既存の web を壊さないため。Ruling を通さない互換の入口として `ACTION_TAKEN` だけを残す。#65 で移した後に残すかを決める（docs/03 に記載）。
- **保留中の 2 回目の操作は拒否（not_actor）**: 保留は 1 つにして、拘束 / 撤回の判定を単純に保つ。
- **`rulingHistory` は裁定がある Hand だけ持つ**: Hero が物理的な操作をしない Hand（CPU 同士の Eval の Spot を含む）で、CPU への入力（Prompt）を 1 文字も変えないため。録画の取り直しが要らない。
- **OOT で CPU の判断を捨てて求め直す**: CPU の判断を待つ間に Hero の操作で Log が進むと、既存の仕組み（Log が進んだら古い手番の判断を捨てる）で求め直しになる。保留は CPU にも見える公開の事実なので、保留を含む KnowledgeState で判断し直すのが TDA の扱い（手番の Player は OOT を知ったうえで行動する）とも合う。

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check` が通る（件数は PR の Test plan に記載）。
- 版 4 の行（`AI_ACTION_INVALID` を含む）を直接書いて、変換せずに読めること・行が版 4 のままであることを SQLite のテストで確認した。版 5 の Hand（Chip の操作と宣言で最後まで進めた）を保存し、開き直して同じ Event Log になることを確認した。
- Out-of-Turn の拘束 / 撤回を、Engine の Unit Test（Event の並び・畳み込みでの復元）と Orchestrator のテスト（CPU の判断待ちの間に Hero が操作する）で確認した。CPU の入力に他者の札・Deck・system の記録・Persona が入らないことを `forbiddenKeys` で確認した。

## 残課題

- web の操作を PhysicalAction の API へ移す（#65）。移した後に `/actions` を残すかは #65 で決める。
- 裁定の文言（Dealer Feedback）の表示は #66。現状の web は 3 種の Event をログの行にしない。
- Replay（#68）での 3 種の Event の再生。
