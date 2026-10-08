# Issue #136: Fixed CPU Identity / Pool / Guest を席 id と分離する（P7-1）

## 概要

席・player id（`cpu1` 等）と CPU の永続 Identity を分けた。マイグレーション v10 で追記型の `session_participants`（Session × 席 → Fixed CPU の `cpu_profile_id`、または Guest の Session 限りの `guest_id`）を足し、Fixed Pool（`cpuProfileId`・名前・Persona Preset）はコードの Version 付き Config（`phase7_pool_v1`）に置いた。人間判断 D118（親が記録済み）の具体。Observation の抽出（#137）以降はこの Identity を使う。

## 初期調査

- Session は Hand Orchestrator が持ち、`sessions` の行は Session の最初の Hand の保存で作られる（`docs/04` §10）。Persona の割り当ては Event に入れず、`AppendContext.personas` で最初の追記に渡して Session Projection に残している（Secret Persona。D28）。
- Resume は `latestSessionProjection` から Session を戻す。Persona の割り当ても Projection から戻す。
- E2E（`e2e/support/server.ts`）は `CPU_PERSONAS` を外し、`POKER_SEED` 固定・RuleBot で、席の表示名「CPU 1」「CPU 2」を UI から選ぶ。席の Persona が変わると RuleBot の判断が変わり、E2E の決定論が崩れる。
- Note / Tag の Subject は `session_player`（`notes/subject.ts`。D105）で、鍵は `JSON.stringify([kind, sessionId, playerId])`。

## 設計方針

- **Pool と編成（`apps/server/src/opponents/cpu-pool.ts`）**: `PHASE7_CPU_POOL`（`phase7_pool_v1`）に Fixed 8 人（TAG Regular 2・LAG 2・Nit・Calling Station・Weak-tight Recreational・Maniac）・`maxGuestSeats: 1`・`guestSeatChance: 0.5` を置いた（OI-005 の暫定値。コードコメントに「確定ではない」と明記）。`composeSessionParticipants` は seed で決定論に、Guest の有無と席 → 席順に席の Persona と同じ Persona の Fixed CPU（いなければまだ座っていない Fixed CPU 全体）を選ぶ。
- **席の Persona は変えない**: Pool の Persona を席へ当てると、既定の割り当て（D85）・`CPU_PERSONAS` の上書き・E2E の RuleBot の判断が変わる。そこで席の Persona は従来のまま、Identity の側を「席の Persona と同じ Preset を持つ Fixed CPU」から選ぶ形にした。既定の割り当てでは同じ Fixed CPU が毎回同じ Persona で打つ。`CPU_PERSONAS` で偏らせたときだけ、足りない席に Persona の違う Fixed CPU が座る（上書きを優先）。
- **seed**: 新しい Session の最初の Hand の seed から `deriveSeed(seed, MAX_PLAYERS)` で導く（CPU の seed の席番号 0〜7 と重ならない）。編成は乱数を消費しても山札・CPU の乱数に影響しない。
- **保存（v10）**: 列は `seq`・`session_id`（`sessions` 参照）・`player_id`・`kind`（`fixed` / `guest`）・`cpu_profile_id`・`guest_id`（一意）・`pool_version`。`kind` と ID の列の組を CHECK、`(session_id, player_id)` と `(session_id, cpu_profile_id)` を一意、UPDATE / DELETE を Trigger で拒否。#137 で Fixed CPU の Session を跨いだ参照に使う `(cpu_profile_id, seq)` の索引を足した。ID の一覧・人数・Persona は列に持たない（OI-005・D28）。
- **書き込みの時点**: Session の行と同じく、Session の最初の Hand の保存の 1 トランザクションで足す（`AppendContext.participants`。2 Hand 目以降の値は見ない）。Guest の id が重なれば一意制約で Hand ごと保存しない。Drill の専用の Session と v10 より前の Session には行が無い（推測で Identity を作らない。backfill しない）。
- **Guest の id**: `guest/<session_id>/<player_id>`。Session の id（UUID）から作るので別の Session と重ならず、DB の一意制約でも守る。次の Session では新しい編成になり、前の Guest の id は使わない。
- **Resume**: `resumeSession` が `EventStore.sessionParticipants(sessionId)` から戻す（`HandOrchestrator.sessionParticipants`）。
- **Subject**: `{ kind: "cpu_profile", cpuProfileId }` を足し、鍵は `["cpu_profile", cpuProfileId]`。`session_player` の鍵は今と同じ文字列（バイト単位）。`persistentSubjectOf(subject, participants)` で既存の `session_player` を永続の CPU へ引く（Fixed CPU なら `cpu_profile`、Guest・v10 より前は null）。Note / Tag の API の対象（`subjectOf`）は今も `session_player` のまま（UI の変更は範囲外）。
- **出さないもの**: `cpuProfileId`・Guest の id・Pool の名前は Event Log・Hero の View・`players` に入れない。席の表示名は「CPU n」のまま。LLM の Prompt・呼び出し・課金経路は変えていない。

## 変更ファイル

- `apps/server/src/opponents/cpu-pool.ts`（新規）: Pool の Config・参加者の型・編成
- `apps/server/src/db/database.ts`: マイグレーション v10（`session_participants`）
- `apps/server/src/event-store.ts`: `AppendContext.participants`・`EventStore.sessionParticipants`・メモリ内の実装
- `apps/server/src/sqlite-event-store.ts`: Session の最初の Hand の保存で参加者を足す・読み出し
- `apps/server/src/hand-orchestrator.ts`: 新しい Session で編成・Session の参加者を持つ・Resume で戻す・`sessionParticipants`
- `apps/server/src/notes/subject.ts`: `cpu_profile` の kind・`persistentSubjectOf`
- テスト: `opponents/cpu-pool.test.ts`（新規）・`notes/subject.test.ts`（新規）・`db/database.test.ts`・`event-store.test.ts`・`sqlite-event-store.test.ts`・`hand-orchestrator.test.ts`
- docs: `docs/03`（`opponents/cpu-pool.ts`・Event Store の Interface・Resume）・`docs/04`（§6・§10 Resume・§12 の列と編成）・`docs/05`（§5 Identity の実装）・`docs/11`（OI-005 の #136 の暫定値）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 582 件・engine 363 件・web 141 件）
- 追加したテストの観点:
  - Fixed CPU は複数 Session で同じ `cpuProfileId`、Guest は Session ごとに別の id で持ち越さない（`cpu-pool.test.ts`・`hand-orchestrator.test.ts`。後者は Guest の座る編成で空振りしないことも確かめる）
  - 人数 2〜8 のどの卓でも席を埋め、Fixed CPU は重ならず Guest は最大 1 席。Pool の人数を変えても編成でき、DB は Pool に無い ID・20 席も受け付ける（Schema が人数に Couple しない）
  - マイグレーション v9 → v10 の適用で既存のテーブル定義・行が変わらず、参加者は backfill しない。Trigger で UPDATE / DELETE を拒否、CHECK・一意制約
  - 参加者は Session の最初の Hand の保存のときだけ残し、Resume で同じ参加者を戻す（メモリ内と SQLite の両方）
  - `session_player` の鍵がバイト単位で同じで、保存済みの行を書き換えずに `cpu_profile` へ引ける
  - Identity が Event Log・Hero の View・`players` に入らない
- E2E（`pnpm e2e`。Playwright・RuleBot・`POKER_SEED` 固定）: 5 件すべて通過（席の Persona・表示名・Event Log を変えていないので、既存の E2E の挙動は変わらない）

## 残課題

- Pool の名前・Avatar を画面に出すかは未定（UI の Issue が無い。OI-005）。
- Note / Tag の UI・API を `cpu_profile` の対象で読む・書くかは後続の判断（今は `session_player` のまま。`persistentSubjectOf` で引ける）。
- Observation の抽出（#137）は `session_participants` と `(cpu_profile_id, seq)` の索引を使う。
