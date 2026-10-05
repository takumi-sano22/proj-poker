# Issue #48: AI_ACTION_INVALID / AI_FALLBACK_USED を Event Log に残す（schema_version 4）

## 概要

Phase 3 の子 Issue。#47 で Orchestrator の運用 Metadata（`InvalidOutputRecord` / `BotFallbackRecord`）として持っていた CPU の不正な出力と Fallback の利用を、`AI_ACTION_INVALID` / `AI_FALLBACK_USED` として Event Log（正本）に残すよう置き換え、Event の `schema_version` を 4 に上げた（D83）。DB の列・マイグレーション・既存 Event の形は変えていない。

## 初期調査

- Engine の Reducer は `nextSeq = event.seq + 1` で seq を進める。Event Store は Hand 内で連番の seq しか受け付けない。そのため Hand の Log に入れる Event は Engine の `HandEvent` に含め、Engine が seq を数えられる必要がある。
- Projection（`projectHeroView` / `projectKnowledgeState`）は `isVisibleTo` の whitelist（public と自分宛て private）で畳み込むので、新しい Visibility の Event は自動で外れる。
- `HAND_FINISHED` の後ろへは追記できず、SQLite は `HAND_FINISHED` の追記で Hand を保存する。記録は手番の Action より前に置く必要がある。
- `checkOpponentOutput` の理由には CPU の出力の値（不正な action 名・amount・知らない項目名）が入る。
- `sqlite-event-store.ts` は「現在の版以外」を版 2 → 3 の変換に通していた。版を 4 に上げると版 3 の行も変換に通り、保存した `reopenRule` を補う値で上書きしてしまう。

## 変更内容

- `packages/engine/src/hand-events.ts`: `AI_ACTION_INVALID`（`playerId`・`attempt`・`stage`・`reason`）と `AI_FALLBACK_USED`（`playerId`・`fallbackKind`: `automatic` / `emergency_bot`・`reason`）を足した。Visibility に `system` を足し、2 つの Event は `system`（どの Player の Projection にも入らない）。`InvalidOutputStage` と `FallbackKind` を Engine の型にした。
- `packages/engine/src/hand-state.ts`: 2 つの Event は State を変えない（seq だけ進む）。
- `packages/engine/src/hand-engine.ts`: `recordAiEvent(state, body)`。手番の Player の記録だけを受け付け（それ以外・終わった Hand は RangeError）、seq と Visibility を付けて `HandProgress` を返す。
- `apps/server/src/hand-orchestrator.ts`: 不正な出力ごとに `AI_ACTION_INVALID` を追記（Hero の View は変わらないので配信しない）。2 回続けて不正なら `AI_FALLBACK_USED`（`automatic`）と RuleBot の Action を 1 回の追記で置く。`BotFallbackRecord` / `InvalidOutputRecord` と `fallbacksOf` / `invalidOutputsOf` を削除。記録で Log が進むので、手番が古くなったかの判定と障害の seq は今の State の `nextSeq` で見る。
- `apps/server/src/opponents/opponent-agent.ts`: `InvalidOutputStage` を Engine の型の再 export にした。
- `apps/server/src/event-upcast.ts` / `sqlite-event-store.ts`: `EVENT_SCHEMA_VERSION = 4`。`HandEventV3`（版 3 の Event＝AI の 2 種類が無い形）を足し、版 3 以上の行は変換せずに読む（版 2 → 3 の変換は版 3 未満の行にだけ）。
- `apps/web/src/lib/view-model.ts`: `describeEvent` に 2 種類を足した（Hero に届かないので null）。
- テスト用の漏れ検査（`packages/engine/src/testing/view-leaks.ts`・`apps/server/src/testing/leaks.ts`）: 禁止語に `AI_ACTION_INVALID` / `AI_FALLBACK_USED` / `"system"` を足し、見えない Event の差し替えに 2 種類を足した。
- テスト:
  - Engine（`projection.test.ts`）: 記録は system で seq だけを進め State と Legal Action を変えない／Fallback の Action が記録の直後の seq に入る／全員（記録された CPU 本人を含む）の HeroView・KnowledgeState に入らず、中身を変えても Projection が同じ／手番でない Player・終わった Hand の記録は投げる。
  - Server（`hand-orchestrator.test.ts`）: 不正 → 正常で `AI_ACTION_INVALID` の直後に Action／不正 → 不正（3 段）で `INVALID(1)` → `INVALID(2)` → `FALLBACK_USED(automatic)` → `ACTION_TAKEN` の順／常に不正でも system を除けば RuleBot と同じ Event 列／CPU ごとに違う生の出力を返させ、Hero の応答・SSE と他の CPU の入力（KnowledgeState は本人も含めて）に出ないこと。既存の Fallback 無しの確認は Event Log から見る形に置き換えた。
  - Server（`sqlite-event-store.test.ts`）: 版 3 の行は変換せずに読む（保存した `reopenRule` を上書きしない）／AI の記録を含む Hand を版 4 で保存し、開き直しても同じ Event Log。
- docs: docs/04 §3（Event 表・`recordAiEvent`・版 4）・§4（`system`）・§5、docs/03 §5。

## 判断理由

- **Engine の `HandEvent` に含めた**: Hand の Log の seq は Engine の Reducer が数える。Server 側だけの型にすると、Engine に渡す前に除く必要があり seq がずれる。Reducer は State を変えないので、卓の進行は変わらない。
- **新しい Visibility `system` にした**: `engine` は「Engine 内部専用（Deck）」で意味が違う。`reason` は CPU の出力の値を含みうるので、記録された CPU 本人も含めてどの Projection にも入れない（本人への理由は従来どおり `correction` で再要求にだけ渡す。D41）。
- **seq は Event 自身の seq**: 記録を手番の Action より前に置くので、`AI_ACTION_INVALID` の時点ではその手番の Action の seq は決まらない。`AI_FALLBACK_USED` は Fallback の Action と同じ追記で直前に置き、「直後の ACTION_TAKEN が Fallback の Action」を Flag の引き方にした（別項目の参照 seq は持たない）。
- **`attempt` は number**: 再要求の回数（D41 の 1 回）を Event の形に固定しない。
- **`AI_ACTION_INVALID` は判定のたびに追記**: 再要求の後に障害で止まっても、それまでの不正は Log に残る（Hand 途中で終われば D62 のとおり保存されない）。
- 版 3 → 4 は種類を足しただけで既存の形は変えていないので、変換関数は置かない（D76 の upcast は「版 3 の Event はそのまま版 4」）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）: すべて成功（engine 158 件・server 90 件・web 31 件）
- 版 3 の行の読み込みテストは、変換の条件を元の `=== EVENT_SCHEMA_VERSION` に戻すと失敗することを確認した（上書きのバグを捕まえる）
- server を `POKER_DB_PATH=:memory:` で起動し、`POST /api/hands` が Hand を返すことを確認した（起動したプロセスは `timeout` で終了）

## 残課題

- `AI_FALLBACK_USED`（`emergency_bot`）の発行と、障害の続け方の API / UI は #52。
- Review / 統計で Fallback の Hand・Action を区別する集計は、それを作る Issue で `system` の Event を読む（Hero の View には出していない）。
- 障害（`outageOf`）は引き続き Orchestrator のメモリだけに持つ（Event 化は本 Issue の範囲外）。
