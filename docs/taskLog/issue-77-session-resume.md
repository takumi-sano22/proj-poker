# Issue #77: Session を永続化し再起動後に Resume できるようにする（schema_version 6）

## 概要

Phase 5 の最初の子 Issue。Session の開始・終了、Hand の打ち切り、Emergency Bot への切り替えを Event Log に残し（D88 の Event 化）、Event の `schema_version` を 6 に上げた。DB に Session Projection のテーブル（`session_projections`。マイグレーション v2）を足し、Hand の保存と同じトランザクションで書く。再起動後は、Hand の合間で止まった Session を Session Projection と最後の Hand の Event から戻して続ける（Resume。Hand 途中の完全復帰は求めない。D62）。あわせて Phase 5 冒頭の人間判断 D94〜D98 を `docs/decision_log.yaml` に記録した。

## 初期調査

- 前提（main b7c444a）: Event は版 5。`SqliteEventStore` は `HAND_FINISHED` の時点で `sessions` / `hands` / `events` を 1 トランザクションで書き、途中の Hand はメモリ（`pending`）。Stack の持ち越しは Orchestrator が最後の Hand の `HAND_STARTED`・`HAND_FINISHED` から毎回決める（D80）。AI 障害の後の Session 終了（`rt.abandoned`）と Emergency Bot の登録（`SessionPointer.emergencyBots`）はメモリだけ（D88）。
- `events` は `hand_id NOT NULL REFERENCES hands` の Hand ごとの表。Session の Event を別の表にすると D95 の「Event の版 6」と合わず、表も増える → Session の開始・終了も、その Session の最初・最後の Hand の Event Log に置く。
- Engine の `foldHandEvents` は先頭が `HAND_STARTED` であることを前提にし（`sessionAfter` 等も `events[0]`）、seq は Engine が `emit` で付ける → `SESSION_STARTED` は開始の Event（`startHand` の結果）の後ろに置く。Session の最初の Hand は全員が均等 Stack（Big Blind より多い）なので、開始の時点で終わることはない。
- `docs/03` は「Persona は Event・DB に入れない」（#51）。一方 Issue は Session Projection に Persona の割り当てを持たせる → Event には入れず、DB の Session Projection にだけ置く（server 内だけで読む）。docs/03 をそのとおりに更新した。
- HeroView・KnowledgeState は見える Event だけを畳み込む（whitelist）。4 種類とも system Visibility にすれば、Hero の View・CPU の入力・Replay の step は変わらない（Hero へは `SessionStatus` を API が返している）。

## 変更内容

### Engine（`packages/engine`）

- `hand-events.ts`: `SESSION_STARTED`（`sessionId`）/ `SESSION_ENDED`（`sessionId`・`reason`）/ `HAND_ABORTED`（`reason: ai_outage`）/ `EMERGENCY_BOT_ENGAGED`（`playerId`・`cause`）を足し、Visibility はすべて system。`OutageKind`・`SessionEndReason`・`HandAbortReason` を Engine に移した（server は型を共有する）。
- `hand-state.ts`: `HAND_ABORTED` は State を `complete`（手番なし）にし、Pot・Stack は動かさない。他の 3 種類は State を変えない。
- `hand-engine.ts`: `recordSessionEvent(state, body)`。置ける時点（`SESSION_STARTED` / `HAND_ABORTED` は Hand の途中、`EMERGENCY_BOT_ENGAGED` はその CPU の手番、`SESSION_ENDED` は Hand が終わった後）を検査し、外れていれば投げる。
- `session-events.test.ts`（新規）: Visibility・Projection に入らないこと・打ち切りの State・置けない時点。

### 永続化（`apps/server`）

- `db/database.ts`: マイグレーション v2 で `session_projections` を足した（既存のテーブル・行は変えない）。`state` と `end_reason` の組は CHECK で守る。
- `session-projection.ts`（新規）: `nextSessionProjection(previous, hand)`。前の Projection に終わった Hand の Event を畳み込む（Emergency Bot は `EMERGENCY_BOT_ENGAGED`、状態は `SESSION_ENDED`、Stack は `HAND_FINISHED`〔打ち切りは開始時の Stack〕）。Persona は Session の最初の Hand で渡された割り当てを引き継ぐ。
- `event-store.ts`: Hand の終わりを `HAND_FINISHED` / `HAND_ABORTED` に広げ、その後ろには同じ追記の `SESSION_ENDED` 1 つだけを受け付ける。`AppendContext.personas`、`listHands` の `aborted`、`latestSessionProjection()`。終わった Session に Hand を足す書き込みは拒否する（`endedSessionGuard`）。メモリ内の実装も同じ規則。
- `sqlite-event-store.ts`: `EVENT_SCHEMA_VERSION = 6`（版 5 の行は変換せずに読む）。Hand の終わりで Hand の全 Event と Session Projection（upsert）を 1 トランザクションで書く。`listHands` は `HAND_ABORTED` を Event の type で見分ける（`hands` の列は変えない）。
- `event-upcast.ts`: 型だけ（`HandEventV5`）。変換は足していない。

### Orchestrator（`apps/server/src/hand-orchestrator.ts`）

- 新しい Session の最初の Hand に `SESSION_STARTED`、Session が終わる Hand に `SESSION_ENDED` を同じ追記で置く（`withSessionEnd`。開始直後に終わる Hand も同じ）。`SessionStatus` は Event から作る。
- 障害の続け方: Emergency Bot は `EMERGENCY_BOT_ENGAGED` を残してから Session の Map に足す。Session 終了は `HAND_ABORTED` + `SESSION_ENDED` を追記し（ここで Hand が保存される）、`rt.abandoned` を消した（打ち切った Hand は State が `complete` なので進まない）。選んだ結果は障害の状態を解く前に残す（追記に失敗したら障害のまま）。
- Resume（`resumeSession`。起動時）: `latestSessionProjection()` が `ready_for_next_hand` で、最後の Hand の席の Player が今の卓の設定にそろっていれば、その Session を戻す（Emergency Bot・Persona の割り当ても）。そろわない・読めないときは warn を残して新しい Session。
- Persona は Session ごとの割り当て（`SessionPointer.personas`）から引く（新しい Session は設定から）。

### Replay・web

- `replay.ts`: 一覧と再生の応答に `aborted`。打ち切りの Event は system なので step には入らない。
- web: `ReplayHandSummary` / `ReplayHand` に `aborted`、一覧と再生の印を「打ち切り」/「未完了」に分けた（`unfinishedLabel`）。進行ログの switch に新しい 4 種類を足した（表示しない）。

### docs

- `docs/decision_log.yaml`: D94〜D98 を指定の文言のまま追記し、先頭の範囲を D01〜D98 に。
- `docs/00`・`docs/10`（冒頭・判断グループ表に D94〜D98）・README の範囲表記を D01〜D98 に。`docs/11` の OI-001 に D97、OI-002 に D96 の注記（節は残す）。
- `docs/04` §3（Event の構成表・版 6・`recordSessionEvent`）・§9（Replay の一覧の `aborted`）・§10（保存の境界・Session Projection・Resume）・§11（Hand History Delete で Projection も消す）。`docs/03`（Session・Event Store・Persona の置き場所・障害の続け方・Replay）、`docs/06`（Replay の一覧の印）、README の制約（再起動後の Session・打ち切りの Hand）。

## 判断理由

- **Session の Event は Hand の Event Log に置く**: `events` は Hand ごとの表で、Session 用の表を足すと D95（Session Projection のテーブルを足す）の範囲を超える。Session の開始・終了は最初・最後の Hand の出来事として置けば、Event の形の変更は種類の追加だけで済む。
- **4 種類とも system Visibility**: 卓の外の運用の記録（D83 と同じ）で、Hero の View・CPU の KnowledgeState・Replay の step を変えない（情報境界 INV-TEST-007/008 の対象が増えない）。Hero への Session の状態は従来どおり `SessionStatus` で返す。Replay の「打ち切り」だけは Hero が自分で選んだことなので `aborted` で返す。
- **`HAND_ABORTED` は State を `complete` にする**: 打ち切った Hand に Action を適用できない（`hand_complete`）・CPU が手番を持たないことを Event の畳み込みだけで表し、メモリの `abandoned` を無くした。
- **`SESSION_ENDED` は Hand の終わりと同じ追記**: Session の終わりは Hand の Event だけで決まり、Hand の保存（Completed Hand が保存境界）と同じトランザクションに入れたい。終わった Hand の後ろには追記させない規則は保ち、例外は同じ追記の `SESSION_ENDED` 1 つだけ。
- **Persona は Event に入れず Session Projection に置く**: Event Log は Replay・Review で読む正本で、Secret Persona（#51）を混ぜない。Resume で同じ割り当てに戻すために DB の Projection にだけ置き、Hero・CPU には出さない。
- **Resume は卓の設定がそろうときだけ**: 人数・Player を変えて起動したら、席の Player に Opponent を割り当てられないので新しい Session にする。起動は止めない（warn を残す）。
- **内部エラーで止まった Hand は従来どおり**（Event を足さず保存しない）: 範囲外。再起動するとその Session は最後に終わった Hand から続く（D62 の Resume の定義どおり）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 237・web 109・server 195）/ `pnpm format:check` をルートで実行し、すべて通過。
- マイグレーション: 使い捨ての DB に最初から当てる（`database.test.ts`）、版 1 だけの DB に行を入れてから版 2 を当て既存の行が変わらないこと、CHECK の組。
- Projection を Event Log から作り直した値が保存した値と一致すること（`sqlite-event-store.test.ts`）。Projection を書けなければ Hand も保存しないこと（Trigger で失敗させる）。
- 実機（`POKER_DB_PATH` に一時ファイル・`BOT_THINK_DELAY_MS=0`・RuleBot・6 人卓）: サーバーを起動して 1 Hand を終える → 止めて起動し直す → `POST /api/hands`（`afterHandId: null`）で同じ Session の次の Hand が 201 で始まり、Stack（hero 217 / cpu1 199 / cpu2 196 / cpu3 200 / cpu4 194 / cpu5 194）を持ち越し、Button が hero → cpu1 に進んだ。DB は `user_version` 2・`schema_version` 6・`session_projections` 1 行（`ready_for_next_hand`・Persona の割り当て・`emergency_bots: []`）。
- UI は画面での目視をしていない（変更は Replay の印の文言だけ。`unfinishedLabel` の単体テストで確認）。

## 残課題

- 内部エラーで止まった Hand は Event を足さず保存しない（再起動の前後で次の Session の扱いが変わる: 再起動しなければ新しい Session、再起動すると最後に終わった Hand から Resume）。必要なら別 Issue で打ち切りの理由を足す。
- 版 5 までに保存した Session は Projection が無く、Resume の対象にならない（作り直さない）。
- Hand History Delete（docs/04 §11）の実装時に `session_projections` も消す。
- reviews のテーブル（D95）は #82。
