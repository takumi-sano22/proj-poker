# Issue #183: Tournament Mode / Session Model / Preset を作る（P8-1）

## 概要

Session に mode（`cash` / `tournament`）の境界を足し、`TournamentSession` の型と Tournament の設定の Versioned Config・標準 Preset（6-max STT の hand-count と time-base）を置いた。Tournament の設定は Session の開始の Event（`SESSION_STARTED`）に Snapshot として残し、同じ Session の Hand と Resume はその Snapshot で続ける。開始の API（`POST /api/hands`）は任意の `session` で mode / Preset を受け取る。mode を指定しない開始は既存の Cash の経路のままで、既存のテストは変更なしで通る。

## 初期調査

- 前提（main 0b419e6）: 判断の正本は D108・D109・D127〜D130、docs/02 §7、docs/04 §12（「Phase 8 の Tournament」）。
- Session は Hand Orchestrator が持ち、新しい Session の最初の Hand に `SESSION_STARTED`（`sessionId` だけ）を置く。Session 専用の開始 API は無く、`POST /api/hands` が新しい Session を始める。
- Engine で Blind を使うのは `startHand` だけ（`HAND_STARTED` に残る）。`applyPhysicalActions`・`resolvePendingOutOfTurn`・`nextHandSeating` は Rule Profile の規則・Button の規則だけを使う。
- Resume は `session_projections` の最後の Hand から戻す。Session の最初の Hand は `sessionHandIds` で引ける。
- 既存のテスト `sqlite-event-store.test.ts` の 1 件が「版 8 で保存する」を値 8 で確かめている。

## 設計方針

- **置き場所**: 型・Preset・検証・Snapshot の読み方は Engine の `packages/engine/src/tournament.ts`（純粋。Cash の Preset `PHASE1_CASH_PRESET` と同じ層）。Level の進行・Ante（#184）、Elimination・順位（#185）、Payout の計算（#186）は入れない。
- **Preset**: `stt6_hand_count`（D127: Starting Stack 1,500・10/20 から 12 Level・10 Hand ごと・BBA の額は BB・50/30/20・参加費 100pt）と `stt6_time_base`（D128: 同じ値で 1 Level 10 分＝600,000ms）。版は `phase8_provisional_v1`。どちらも OI-007 の暫定値とコメントに書いた。
- **Snapshot**: `SESSION_STARTED` に任意項目 `tournament`（設定一式）を足した。cash の Session は項目ごと持たない（既存の Cash の Event を変えない）。項目の無い `SESSION_STARTED` は cash として読む（`sessionSettingsOf`）。`recordSessionEvent` が Snapshot を検証してから置き、読むときも検証して壊れた Snapshot を cash として扱わない。
- **版**: 任意項目の追加で、旧版の行（項目の無い行）を cash と読む意味が変わらないので、docs/04 §3 の規則どおり `schema_version` は 8 のままにした（親の指示「任意項目の追加なら版を上げない」。版を上げると既存のテスト 1 件が落ちる＝「既存テストは修正なしで通す」に反する）。`HAND_STARTED` に必須の項目を足す #184 で版を上げる（#184 の本文の「9 に上げる」はそのまま当てはまる）。
- **Hand の卓の設定**: Rule Profile は Cash と共有し（D108。Hand Engine を複製しない）、Blind だけを Level の額にする（`tableConfigForLevel`）。Level の進行は #184 なので、それまでは 1 Level 目の Blind で続ける。Ante も #184 まで Hand に入れない。
- **続く Session と違う設定**: Hero が Hand の合間に Session を終える経路が無い（Session の終了は Bust・勝ち残り・障害の後の選択だけ）ので、続く Session に違う mode / Preset を求めた開始は `session_mode_mismatch`（409）で拒否する（黙って無視しない・今の Session を捨てない）。開始の再送で、まだ結果を見ていない Hand を返す場合は比べない。
- **Resume**: 最後の Hand の Session の最初の保存済みの Hand の `SESSION_STARTED` から設定を戻す。Snapshot が壊れていれば Resume しない（新しい Session。warn を残す）。DB のテーブル・列・マイグレーションは足していない（D129）。
- **D117**: 意味上の順序に壁時計を使っていない（Session の最初の Hand は `sessionHandIds`＝`ordinals.ord` の順）。

## 変更内容

- Engine（`packages/engine`）
  - `src/tournament.ts`（新規）: `SessionMode`・`AnteKind`・`BlindLevel`・`BlindSchedule`・`PayoutStructure`・`TournamentConfig`・`SessionSettings`・`TournamentSession`・`TOURNAMENT_PRESETS`・`validateTournamentConfig`・`tableConfigForLevel`・`sessionSettingsOf`。
  - `src/hand-events.ts`: `SESSION_STARTED` に任意項目 `tournament`。
  - `src/hand-engine.ts`: `recordSessionEvent` が Snapshot を検証する。
  - `src/index.ts`: export。
  - テスト: `src/tournament.test.ts`（新規 24 件）。
- Server（`apps/server`）
  - `src/hand-orchestrator.ts`: `SessionRequest`・`StartHandError`、`startHand(afterHandId, request?)`、Session の設定の保持（`SessionPointer.settings`・`HandPlan.settings`）・Resume での復元・不一致の拒否・Tournament の Hand の卓の設定。
  - `src/routes/hands.ts`: `POST /api/hands` の任意の `session`（JSON Schema で `cash` か `tournament` + 既知の Preset）と 409 `session_mode_mismatch`。
  - `src/sqlite-event-store.ts`: 版 8 のまま任意項目を足したことのコメント。
  - テスト: `src/tournament-session.test.ts`（新規 13 件。Cash の経路が変わらないこと・Tournament の開始と Snapshot・同じ Session の継続・不一致の拒否・再送・SQLite の再起動後の Resume〔Tournament / Cash〕・API の 201 / 400 / 409）。
- Docs: `docs/03_SYSTEM_ARCHITECTURE.md` §1（Session の mode・`POST /api/hands` の表）、`docs/04_DATA_AND_EVENTS.md` §3（`SESSION_STARTED` の項目・版の節）と §12（Phase 8 の Tournament）。

## 実行した確認

- `pnpm lint`: 成功
- `pnpm typecheck`: 成功（e2e / engine / web / server）
- `pnpm test`: 成功（engine 33 files / 393 tests、web 9 files / 147 tests、server 62 files / 789 tests）。既存のテストは変更していない
- `pnpm format:check`: 成功
- 1 回目の `pnpm test` で `ruling.property.test.ts` の Property Test が 5.6 秒で失敗し、単体の再実行・全体の再実行では成功した（負荷による時間切れ。今回の変更は Ruling に触れていない）。
- UI は変えていないので画面の実測はしていない（UI は #190）。e2e は実行していない（Cash の画面の経路は変えていない）。

## 残課題

- Level の進行・Ante（#184）、Elimination・順位（#185）、Payout の計算（#186）、UI（#190）。それまで Tournament の Session は 1 Level 目の Blind・Ante なしで進む（API からだけ始められる）。
- CPU の Observation の `context` は Tournament の Session でも `cash` のまま（#188 で扱う）。
- 続く Cash の Session（Resume を含む）から Tournament を始めるには、今の Session を終える経路が要る。Session の終了理由（`session_projections` の CHECK）に触れうるので、#190 で UI の流れを決めるときに人間判断が要るかを確かめる。
