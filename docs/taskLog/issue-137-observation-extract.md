# Issue #137: Observation を Event Log から決定論で抽出する（P7-2）

## 概要

CPU の Observation（Raw Evidence）を、正本の Event Log から決定論で抽出する純粋関数を `apps/server/src/memory/observation.ts` に足した。Observer が卓で見聞きした public の Event（Showdown で表にされた札を含む）だけを、provenance（Observer・Subject・`hand_id`・`events.seq`・`ordinals.ord`・Visibility・context）付きで返す。人間判断 D118（Observation は表にも Event にも書かず抽出する）・D106・D117 の具体。表・列・Event の形・`schema_version` は足していない。Hypothesis（#138）・KnowledgeState への注入（#139）はこの出力を使う。

## 初期調査

- Event の Visibility は Engine の `visibilityOf` が種類から決める（`HOLE_CARD_DEALT` / `USER_READ_RECORDED` は private、`DECK_SHUFFLED` は engine、運用の記録・Metadata は system、それ以外は public）。Showdown の札は `CARDS_TABLED`（public）。
- Learning-only Reveal は Event の Visibility を増やさず `projectLearningReveal`（`packages/engine/src/learning-reveal.ts`）の別 Projection で作る。
- 参加者（#136）は `EventStore.sessionParticipants(sessionId)`。Hero は行を持たない。v10 より前の Session・Drill の専用の Session は行が無い。
- Hand の順は `finishedHandIds()` / `savedOrder()`（`ordinals.ord`。D117）。Event Store には Hand → Session を引く公開の口が無かった（SQLite 実装の内部には `hands.session_id` を引く文がある）。
- `learning/learning-isolation.test.ts` は CPU の入口（`opponents/` 等）から相対 import をたどって `learning/` に届かないことを確かめる。

## 設計方針

- **置き場所**: Phase 7 の CPU の Memory 用に `apps/server/src/memory/` を新設（#138 の Hypothesis もここに置く想定）。`learning/` のファイルは触らず、同じ考え方の静的検査を `memory/observation-isolation.test.ts` に置いた。
- **入れるもの（whitelist）**: 保存された `visibility` と、Engine の `visibilityOf`（種類から決まる値）の両方が public の Event だけ。保存された値だけを信じず、Hole Cards・Deck・Hero の読みは種類で落ちる（保存値を public に偽装した入力でも入らないテストを置いた）。
- **参照**: Observer は `{ kind: "cpu_profile", cpuProfileId }`（Note / Tag の Subject と同じ形。`notes/subject.ts` の型を再利用）か `{ kind: "guest", guestId }`。Subject はそれに `{ kind: "hero" }` を足した参加者の参照。Hero の席は呼び出し側が `heroPlayerId` で渡す（推測で Identity を作らない）。
- **出力の形**: Hand ごとの `ObservedHand`（席 → 参加者、見た Event の列、各 Event の行為者の Subject。卓全体の Event は Subject が null）と、`observationsOf` で平らにした Subject ごとの `Observation`（Observer 自身・誰か引けない席の Event を除く）。Hypothesis が Pot・Board 等の文脈を使えるよう、Hand 単位の Event 列も返す。
- **観察しない Hand**: Observer が参加者にいない Session（v10 より前・Drill を含む）と、Observer が座っていない Hand（`HAND_STARTED.seats` に無い＝Bust 後）。
- **Guest**: Observer としては `currentSessionId` の Hand だけ。Subject としては今の Session の Hand でだけ引き、前の Session の Hand では Guest の席を null にする（次の Session では読まない。Event Log の行は消さない）。Guest の Event 自体は文脈（Pot 等）として Hand の Event 列に残るが、誰の行動かは引けない。
- **順序**: Hand は `ord` の小さい順、Hand の中は `seq` の小さい順。入力の並び・壁時計に依らない。`ord` が重複・不正な入力は RangeError。
- **context**: 今は `cash` だけ。`tournament` は Phase 8 で使う型の枠だけ置いた。
- **都度計算**: 保存しない（D111 と同じ）。Event Store からの読み出し（`loadObservationSources`）は、Observer が参加者にいない Session の Hand の Event を読まない。
- **Event Store**: Hand の Session を引く `sessionIdOfHand(handId)` を Interface に足した（メモリ内・SQLite の両方。SQLite は既存の文を使い、`sessionHandIds` もこれを使うように寄せた。挙動は不変）。

## 変更ファイル

- `apps/server/src/memory/observation.ts`（新規）: 抽出の型・`extractObservedHands`・`observationsOf`・`loadObservationSources`・`extractObservedHandsFromStore`・`participantKey`
- `apps/server/src/memory/observation.test.ts`（新規）: 情報境界・provenance・観察しない Hand・Guest・決定論・時計が戻った記録の回帰
- `apps/server/src/memory/observation-isolation.test.ts`（新規）: `learning/` に届かない・Learning-only Reveal を参照しない（陽性の対照つき）
- `apps/server/src/event-store.ts`: `EventStore.sessionIdOfHand` とメモリ内の実装
- `apps/server/src/sqlite-event-store.ts`: `sessionIdOfHand`（`sessionHandIds` から切り出し）
- docs: `docs/04`（§6 の Observation・§12 に「Observation（#137）」）・`docs/03`（`memory/` の節）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 602 件・engine 363 件・web 141 件）
- 追加したテスト（17 件）の観点:
  - 抽出した値に、Board と Showdown で表にされた札以外の Card が無い（値を丸ごと走査。Learning-only Reveal でだけ見える札が実際にあることも確かめて空振りしない）
  - public でない Event の中身（他者・自分の Hole Cards・Deck・system・Hero の読み）を差し替えても結果が同じ
  - Observer 自身の Event を Subject の Observation にしない
  - 同じ Fixed CPU が別の Session で別の席に座っても同じ Observer / Subject で引く
  - Bust 後の Hand・参加者にいない Session・v10 より前の Session を観察しない
  - Guest は次の Session で Observer としても Subject としても読まない
  - 同じ入力から同じ結果・入力の並びを崩しても同じ結果
  - 呼ぶたびに 1 時間戻る時計で保存しても、Hand の順は `ord`・Hand の中は `seq` のまま（メモリ内の Store と SQLite の Store の両方。#129・#130 の再発防止）
- 抽出の除外を外す変異（`isObservable` を engine 以外すべて通す形に変える／Guest の除外を外す）を手元で入れ、該当テストが落ちることを確かめてから戻した

## 残課題

- 抽出はまだどこからも呼ばない（Hypothesis は #138、KnowledgeState・Prompt への注入は #139）。
- 全 Hand を都度読むので、Hand が増えて遅くなったら Cache を別 Issue で足す（D111 と同じ方針）。
