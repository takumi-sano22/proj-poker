# Issue #20: Event Log の SQLite 永続化（node:sqlite）と README 同期

## 概要

Phase 1 の最終 PR。#18 のメモリ内 Event Store と同じ Interface（`EventStore`）で SQLite 実装を足し、起動時（`apps/server/src/index.ts`）に差し替えた。保存の境界は Completed Hand（D62・docs/04 §10）。あわせて Issue コメントの追記 3 件（範囲表記の統一・harness の更新・Event の schema 進化方針）を扱い、README を Phase 1 の到達点に更新した。

## 初期調査

- 既存: `event-store.ts`（Interface `append` / `read`・`InMemoryEventStore`。seq の連番検査と保存時の複製・凍結）。Orchestrator は State を毎回 `store.read` から畳み込む（D37）。
- D72: `node:sqlite`・ORM なし・生 SQL・自前マイグレーション・Event は JSON 列で append-only。D62: Hand 間 Auto Save、Hand 途中の完全復帰は要求しない。
- Node 24.18.0 の `node:sqlite`（SQLite 3.53.1）は `ExperimentalWarning` を出さない（`node -e` と `node dist/index.js` の起動ログで確認。`grep -c ExperimentalWarning` が 0）。そのため警告の抑止（`--no-warnings` 等）は入れていない。抑止は他の警告まで消すため、出ない版で先回りしない。
- 最新の D 番号は origin/main の `decision_log.yaml` で D75。

## 設計方針

- **保存の境界**: `SqliteEventStore` は Hand 途中の Event をメモリに持ち、`HAND_FINISHED` を含む追記の時点で、その Hand の全 Event・`hands` の行・（最初の Hand なら）`sessions` の行を 1 トランザクションで書く（`BEGIN IMMEDIATE` … `COMMIT`、失敗時 `ROLLBACK`）。書き込みに失敗したらメモリ側も変えずに例外を返す。再起動すると途中の Hand は消える（D62）。
- **append-only**: Store に更新・削除の API は無い。終わった Hand への追記と、`HAND_FINISHED` の後ろに続く Event は `EventSeqConflictError` で拒否する（Interface の契約として両実装に共通の `assertAppendable` で検査する）。DB 側でも `events` の UPDATE を Trigger で拒否する。DELETE は Reset（docs/04 §11）の設計と一緒に扱うため塞いでいない。
- **スキーマ（マイグレーション v1）**: `sessions`（`session_id`・`started_at`）/ `hands`（`hand_id`・`session_id`・`started_at`・`finished_at`）/ `events`（`event_id`・`hand_id`・`seq`・`type`・`schema_version`・`recorded_at`・`payload`。`UNIQUE (hand_id, seq)`・`json_valid(payload)`）。すべて `STRICT`。外部キー有効。
- **マイグレーション**: `db/database.ts` の `MIGRATIONS`（SQL の配列）を `PRAGMA user_version` より新しい分だけ 1 版ずつトランザクションで当てる。アプリより新しい版の DB は `UnsupportedDatabaseVersionError` で開かない。
- **Event の schema 進化（暫定・人間確認待ち）**: Event 行に `schema_version` を持たせ、現時点では v1 だけを受け付ける。知らない版は `UnsupportedEventSchemaError` で読まずに失敗させる（旧形式を黙って新形式として扱わない）。互換の無い形の変更をするときは版を上げ、読み込み時の upcast を同じ PR で足す。docs/04 §3 に記述。
- **Session**: 起動ごとに 1 つ（Session の概念は後続 Issue）。Session Projection・Stack の持ち越しは Phase 1 では保存しない（毎 Hand 均等 Stack。D70）。
- **DB の場所**: 環境変数 `POKER_DB_PATH`（`:memory:` 可）。既定は `apps/server/data/poker.sqlite`（`.gitignore` に `apps/server/data/` を追加）。`config.ts` の位置から解決するので src（dev）と dist（start）で同じ場所になり、worktree ごとに別の DB になる。
- **共通処理の切り出し**: 追記の検査（`assertAppendable`。seq の連番・`HAND_FINISHED` の後ろへの追記の拒否）と保存形への変換（`toStoredEvents`）・`deepFreeze` を `event-store.ts` から export し、両実装で使う。

## 変更ファイル

- `apps/server/src/db/database.ts`（新規）・`db/database.test.ts`（新規）
- `apps/server/src/sqlite-event-store.ts`（新規）・`sqlite-event-store.test.ts`（新規）
- `apps/server/src/event-store.ts`（ヘルパの切り出し・コメント）・`event-store.test.ts`（契約テストを両実装で実行）
- `apps/server/src/config.ts`・`config.test.ts`（`DEFAULT_DB_PATH`・`resolveDbPath`）
- `apps/server/src/index.ts`（SQLite Store を渡し、終了時に閉じる）・`app.ts`（コメント）
- `.gitignore`（`apps/server/data/`）
- `docs/03_SYSTEM_ARCHITECTURE.md`・`docs/04_DATA_AND_EVENTS.md`（§3 の Event Store・schema_version、§10 の Phase 1 の保存）
- `README.md`（release-readme-sync: Phase 1 の到達点・環境変数・テスト対象・範囲表記 D01〜D75）
- harness: `.claude/skills/poker-engine-testing/SKILL.md`（§2・§4 を #17 の Scenario 形式とテスト補助に合わせた・Chip 表現 D74）、`.claude/skills/implementation-guidance/references/poker-engine.md`（項目 6 を D74 で確定に）、`.claude/skills/{sync-check,test-and-review}/SKILL.md`（範囲表記 D01〜D75。test-and-review はテストのあるパッケージの記述も更新）、`.claude/skills/decision-log/SKILL.md`（追記手順 4 に docs/00・docs/10 と README・skill の確認を明記）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 109・web 17・server 39 件すべて成功）/ `pnpm format:check`（成功）
- マイグレーションを一時ディレクトリの新しいファイルへ最初から適用するテスト（`db/database.test.ts`）
- Event の順序と内容・`event_id`・記録時刻が、DB を開き直しても一致する往復テスト。Orchestrator で 1 Hand を最後まで進め、開き直して同じ Event Log を読めるテスト（`sqlite-event-store.test.ts`）
- 実機: `pnpm --filter @proj-poker/engine build` → `pnpm --filter @proj-poker/server build` → `BOT_THINK_DELAY_MS=0 node dist/index.js`（`POKER_DB_PATH` 未設定）で起動し、API で 1 Hand を完走。既定の `apps/server/data/poker.sqlite` に `events` 43 行（seq 0〜42・schema_version 1）・`hands` 1 行・`user_version` 1 を確認。起動ログに ExperimentalWarning は 0 件。`git status` に DB ファイルは出ない。確認後にサーバーは停止した。
- ブラウザでの UI 操作は今回の変更対象外（`apps/web` は未変更）のため行っていない。

## 残課題

- **Event の schema 進化方針は人間確認待ち**（PR の Review Required）。現状は「行ごとの `schema_version`・v1 のみ受け付け・互換の無い変更時に版を上げて upcast」。
- 保存した Hand を一覧・再生する API と UI（Replay）は Phase 3 以降。
- Session Projection・Stack の持ち越し・Memory Update の保存は、Session を扱う Issue で足す（docs/04 §10）。
- `implementation-guidance/references/db.md` の「ORM / マイグレーションツールは未確定」「コマンドはツール確定後に追記」は D72 と本 PR で古くなった（共有ガイダンスのため本 PR では編集していない。親へ内容を返す）。
- 親 #2 の DoD のうち Phase 1 で実装した項目（Hand Event Log・Visibility Metadata・Completed Hand 単位の Auto Save など）のチェックは親 #2 側で更新する。
