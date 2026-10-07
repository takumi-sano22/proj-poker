# Issue #132: 意味上の順序を壁時計から永続的な論理順序へ移す（#129・#130 の同根修正）

## 概要

正しさに関わる「どちらが先か」（Learning Reset の前後・Replay の新しい順・Session 内の Hand の順・Recent の順・最新の Session Projection の選択・Resume）を、壁時計（OS の時刻）ではなく、マイグレーション v9 の追記型の `ordinals` の番号（論理順序）で決めるようにした。人間判断 D117（親が記録済み）の具体。壁時計の列は消さず、表示・監査の Metadata として残した。時刻を clamp する解決はしていない（#118 の `later()` の clamp は廃止）。

## 初期調査（same-root sweep）

壁時計を順序・境界・最新の選択に使っていた箇所（`grep` で `started_at|finished_at|recorded_at|created_at|updated_at|ORDER BY|sort|localeCompare|Date.parse` を server・web・engine に当てた）:

| 箇所 | 用途 | 対応 |
|---|---|---|
| `sqlite-event-store.ts` `selectRecentHands`（`ORDER BY started_at DESC`）と `listHands` の `sort(startedAt)` | Replay の一覧の新しい順 | 論理順序へ（#129 の原因） |
| `sqlite-event-store.ts` `selectSessionHands` / `selectFinishedHands`（`ORDER BY started_at`） | Session 内の Hand の順・Recent / Trend / Hypothesis の判断の順 | 論理順序へ |
| `sqlite-event-store.ts` `selectLatestProjection`（`ORDER BY updated_at DESC`） | 最新の Session Projection（Resume） | 論理順序へ |
| `learning/learning-reset.ts` `later()`・`endedAfter()`（時刻の比較と clamp） | Learning Reset の前後（Profile・Score・Hypothesis・Drill の系列の Score） | 論理順序へ（#130 の原因） |
| `event-store.ts`（メモリ内）の `listHands` / `finishedHandIds` | 同上（Map の追記の順＝開始の順） | 保存の順のカウンタへ |
| `learning/session-review.ts` の `durationMs` | 表示だけ | 変えない（逆行時は 0。注記を足した） |
| `notes`（seq）・`reviews`（version）・`drills`（rowid）・`hypothesis_snapshots`（rowid） | 既に記録の順 | 変えない |
| web（`lib/replay.ts`・`lib/learning.ts` の時刻の整形） | 表示だけ | 変えない |

Engine は時刻を持たない（Event の順は `seq`）。

### #129 の原因

Replay の一覧（`GET /api/replay/hands`）が `started_at`（Hand の最初の Event の壁時計の時刻）の新しい順だった。E2E の Resume の段は、再起動後に 3 Hand 目を始めてから一覧の `hands[0]` を 3 Hand 目として読む。WSL の壁時計は約 27 秒ごとに約 2 秒戻る（#119 で実測）ので、再起動後のメモリの 3 Hand 目の開始時刻が、保存済みの 2 Hand 目の開始時刻より前に記録されることがある。そのとき `hands[0]` は 2 Hand 目を指し、「3 Hand 目の開始の Stack ＝ 2 Hand 目の終わりの Stack」の検査が 2 Hand 目の開始の Stack と比べて失敗した（一度だけ失敗して再現しなかったのはこのため）。

### #130 の原因

Learning Reset の区切りを、Hand の終わりの Event の `recorded_at` と `learning_resets.created_at` の時刻の比較で決めていた。Reset の前に終わった Hand でも、Reset の時刻が時計の巻き戻りでその Hand の終わりより前に記録されると、Reset の後に数えられた。

## 設計方針（親が確定した設計に沿う）

- **v9 `ordinals`**: `ord INTEGER PRIMARY KEY AUTOINCREMENT`・`kind`（`hand_saved` / `learning_reset`。CHECK）・`ref_id`・`UNIQUE(kind, ref_id)`・STRICT。Trigger: 挿入時に参照先（`hands` / `learning_resets`）の実在を確かめる（`ordinals_target`）、UPDATE / DELETE を拒否する。既存のテーブル・列・行は変えない（D76）。
- **書き込み**: `SqliteEventStore.persist` と `SqliteLearningResetStore.add` の同じトランザクションで 1 行足す（Reset は 1 回に 1 行。`ref_id = reset_id`）。
- **順序の表現**: Event は Hand ごとの `events.seq` のまま。Hand の順は保存の `ord`。`listHands` はメモリの終わっていない Hand（プロセス内で始めた順の逆）→ 保存済みを `ord DESC`。`sessionHandIds`・`finishedHandIds` は `ord ASC`。`latestSessionProjection` は `last_hand_id` の `ord` が最大の行。Learning Reset はカテゴリごとに `learning_resets.seq` が最大の行を最後の Reset とし、Hand は `hand.ord > reset.ord` なら Reset の後。
- **Interface**: `EventStore.savedOrder(handId)` を足した。`LearningResetStore.boundaries()` は `{ ord, createdAt }`（区切りの判定は `ord`、`createdAt` は表示用）を返し、API の応答（`resets`・`score.since`）は `resetTimes()` で従来どおり時刻だけを返す（API の形は変えない）。`endedAfter` / `handEndedAt` を `savedAfter(savedOrder, boundary)` に置き換えた。`DrillService` の `scoreSince` を `scoreBoundary` にした。
- **メモリ内の実装**: `logical-order.ts` のプロセスで 1 つのカウンタ（`processOrdinals`）を既定で Event Store と Reset Store が共有する（Store ごとに分けると番号どうしを比べられない）。注入もできる。
- **欠けの検出**: `ordinals` は LEFT JOIN で引き、欠けた行（`ord IS NULL`）は `ORDER BY ord IS NULL DESC` で先頭に並べて読み出しで `MissingOrdinalError` にする（LIMIT で落とさない）。
- **backfill（v9 の中で INSERT のみ）**: Hand は `hands` の rowid の順、Reset は `learning_resets.seq`（reset_id ごとの最小）の順を保ち、両方の先頭を `julianday(finished_at)` と `julianday(created_at)` で比べて早い方を先に並べる併合（同じ時刻なら Hand を先に。v8 までの判定と同じ）。再帰 CTE で併合の手順の番号 `n` を作り、`ord` に明示して入れる。
- **意味の変化**: Hand の順を「開始の順」から「保存（終わり）の順」で表す。保存済みの Hand では開始の順と一致し、ずれうるのは Drill の Hand と通常の Hand を並行したときの Replay の一覧の並びだけ（`docs/04` §10 と PR の Review Required に書いた）。
- 変えないもの: Event の形・既存マイグレーション v1〜v8・既存の行・Score / Hypothesis / Profile / Drill の計算の意味（Hand の終わりで切る・Review の時刻では切らない）・D114・User Read / Note / Tag を Reset で消さないこと・本番の `index.ts`（時計をずらす仕組みは足さない）。

## 変更内容

- 追加: `apps/server/src/logical-order.ts`
- server: `db/database.ts`（v9）・`event-store.ts`・`sqlite-event-store.ts`・`learning/learning-reset.ts`・`learning/learning-service.ts`・`drill/drill-service.ts`・`app.ts`・`learning/session-review.ts`・`replay.ts`・`routes/replay.ts`（コメント）
- web: `lib/api.ts`（コメントだけ）
- テスト: `event-store.test.ts`（2 件追加）・`sqlite-event-store.test.ts`（1 件追加・1 件の期待値を新しい並びに更新）・`learning/learning-reset.test.ts`（Store の契約を `{ ord, createdAt }` に・巻き戻りの 3 件追加）・`routes/drills.test.ts`（1 件追加）・`db/database.test.ts`（v9 の 1 件追加・既存の schema 比較の除外に `ordinals` / `sqlite_sequence` を足した）
- E2E: `e2e/tests/session.spec.ts`（`hands[0]` をやめ、前の段階の handId の集合との差分で 2・3 Hand 目を特定）・`e2e/tests/learning.spec.ts`（`hands[0]` をやめ、辞書順で選んで Session Review が一覧の全 Hand を数えることを確かめる。外していた「Reset 後の Drill の系列の Score が 0 件」の検査を戻した）
- docs: `docs/04` §10（論理順序）・§11（区切りの判定）・§12（D117 の具体の参照・API の時刻は表示用）、`docs/03`（Event Store・SQLite 実装・API 表）、`docs/07`（Reset 後の範囲・Duration の注記・Drill の系列）、`docs/06`（Replay の一覧の順）、`docs/09` §10（巻き戻りのテスト）、`README.md`（Replay の順・Learning Reset）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 363・web 141・server 562〔追加分を含む〕 passed）/ `pnpm format:check`: すべて通過
- `pnpm e2e`: 5 passed
- `pnpm e2e --repeat-each=10`: 1 回目 49 passed / 1 failed（`learning.spec.ts` の Play のループで「次の Hand へ」を押した直後に前の Hand の終了表示を見て二重に押そうとし、5 分待ち続けた。順序と無関係のテストの手順の競合と判断し、出力の要点を添えて #133 に起票・#104 に紐付けた）、2 回目 50 passed
- v9 の backfill の所要時間（手元・`node:sqlite`・Reset 20 件）: Hand 2,000 件で 5ms、20,000 件で 53ms（線形）

## 判断理由

- backfill の併合を再帰 CTE にしたのは、Hand どうし・Reset どうしの順を保ったまま時刻で併合する手順を SQL だけで（マイグレーションの仕組みを変えずに）表すため。件数はローカル単一ユーザーの Hand 数で、1 回だけ流れる。
- API の `resets` / `score.since` の形を変えなかったのは、web の表示（区切りの時刻の注記）がそのまま使えるため。番号は API に出さない。

## 残課題

- #133: `e2e/tests/learning.spec.ts` の Play のループの待ち方（一度だけの失敗。この PR の範囲外）
