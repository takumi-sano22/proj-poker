# Issue #143: Opponent Memory Reset と Projection の再構築（P7-8）

## 概要

Opponent Memory Reset（全 CPU / 1 つの Fixed CPU）を、正本を消さない追記型の区切りの表（マイグレーション v11 の `opponent_memory_resets`）で実装した。CPU の Observation・Private Hypothesis・Memory の注入は、その CPU に効く最後の区切りより後に保存された Hand だけを入力にして、Event Log から都度作り直す。API は `POST /api/opponents/memory-resets`。人間判断 D64・D76・D106・D114・D117・D118・D120 の具体。Event の形・`schema_version`・既存のテーブル / 列 / 行・`ordinals` の `kind` の CHECK は変えていない。LLM の呼び出しの回数・経路も変えていない。

## 初期調査

- Learning Reset（#118。`learning/learning-reset.ts`）は `learning_resets` に区切りを足し、`ordinals` に `learning_reset` の行を足して番号で判定している。D120 は `ordinals` の `kind` の CHECK を変えないとしているので、Opponent Memory Reset は `ordinals` に行を足さず、追加した時点の `MAX(ordinals.ord)` を自分の表の列に持つ形にした。
- CPU の Memory は Hand Orchestrator が Hand の開始時に `buildOpponentMemoriesFromStore` → `buildOpponentHypothesesFromStore` → `extractObservedHandsFromStore` の順で都度作っている（保存しない）。入口の `ObservationQuery` に区切りを足せば、Observation・Hypothesis・注入の 3 つが同じ条件になる。
- `memory/` の非テストのモジュールは `learning/` を import しないことを `observation-isolation.test.ts` が検査しているので、新しいモジュールは `learning/learning-reset.ts` を import しない（`savedAfter` も使わず、同じ比較を自前で持つ）。
- Hero には Fixed CPU の名前・`cpuProfileId` を見せていない（`docs/04` §12「編成」）。

## 設計方針

- **区切り**: `opponent_memory_resets`（`seq`・`reset_id`・`created_at`〔表示用〕・`scope`〔`all` / `cpu_profile`〕・`cpu_profile_id`〔`cpu_profile` のときだけ〕・`ord`）。`ord` は `INSERT … SELECT COALESCE(MAX(ord), 0) FROM ordinals` で挿入と同じ文・同じトランザクション（`BEGIN IMMEDIATE`）で取る。挿入の Trigger `opponent_memory_resets_ord` で「その時点の最大」以外の値を拒否する。`UPDATE` / `DELETE` は Trigger で拒否。メモリ内の Store は、Memory を作る Event Store の最後の番号（今回足した `EventStore.lastOrdinal()`。メモリ内は `OrdinalCounter.current()`、SQLite は `MAX(ordinals.ord)`）を必須の引数で受け取る（Codex の指摘で、プロセスの既定のカウンタを既定値にする形から変えた。Event Store だけを独自のカウンタで差し替えると区切りがずれるため）。
- **判定**: Fixed CPU X に効くのは `scope = all` と `cpu_profile_id = X` の行のうち `ord` が大きい方（同じなら `seq` が大きい方）。Hand の保存の `ord` が区切りより**大きい** Hand だけを使う。`created_at` では比べない（D117）。
- **Subject 側は消さない**: Reset は Observer としての Memory を区切る。「X について他の CPU が持つ Memory」は D120 に書かれていないので消さない（範囲を広げない。親の指示どおり）。人間判断が要るほどの論点ではないと判断し、NEEDS_HUMAN にはしていない（消す必要が出たら、Subject の区切りを足す形で後から足せる。正本は残っている）。
- **Guest**: Guest は Session 限りで次の Session では読まないので、後始末は無し。`all` は「全 CPU」なので今の Session の Guest にも効かせた（Guest の Observer には `scope = all` の行だけが効く）。
- **進行中の Hand**: Learning Reset と同じく保存の順で切るので、Reset の時点で進行中だった Hand は Reset の後に保存され、Reset 後の Evidence に入る。今の Hand の Memory は Hand の開始時に作るので、Hand の途中の Reset は次の Hand から効く。
- **API**: Learning Reset に倣い、`POST /api/opponents/memory-resets`（`{ scope: "all" }` / `{ scope: "cpu_profile", cpuProfileId }`）。JSON Schema の `if / then / else` で `cpuProfileId` の有無を `scope` と合わせる。知らない `cpuProfileId`（Fixed Pool `PHASE7_CPU_POOL` に無い）は 404 `cpu_profile_not_found` で何も足さない（DB は Pool の一覧を知らないので API で拒否）。応答は `{ reset: { resetId, createdAt, scope, cpuProfileId } }` だけ（Persona・Pool の名前・Hypothesis の中身・区切りの `ord` は返さない）。
- **UI は足していない**: 既存の Learning Reset の入口（Session Review の Profile の下）に並べる案はあったが、1 つの Fixed CPU を選ぶ入口は Fixed CPU の名前・`cpuProfileId` を Hero に見せる判断（今は見せていない）を伴うため、この Issue の範囲を超える。全 CPU だけの入口にするかどうかも含め、画面の入口は別 Issue で扱うのがよい（#144 の Critical E2E の完了条件にも Reset の画面は無い）。

## 変更ファイル

- `apps/server/src/db/database.ts`: マイグレーション v11（`opponent_memory_resets` と 3 つの Trigger）
- `apps/server/src/logical-order.ts`: `OrdinalCounter.current()`
- `apps/server/src/event-store.ts`・`apps/server/src/sqlite-event-store.ts`: `EventStore.lastOrdinal()`
- `apps/server/src/memory/memory-reset.ts`（新規）: `OpponentMemoryResetStore`（`InMemoryOpponentMemoryResetStore`・`SqliteOpponentMemoryResetStore`）・`boundaryFor(observer)`
- `apps/server/src/memory/observation.ts`: `ObservationQuery.afterOrd`（区切り以前の Hand を `loadObservationSources` で読まず、`extractObservedHands` でも外す）
- `apps/server/src/memory/memory-summary.ts`: `MemoryObserverSeat.afterOrd` を Observation の条件へ渡す
- `apps/server/src/hand-orchestrator.ts`: `memoryResets` の Option。Hand の開始時に CPU ごとの区切りを引いて Memory を作る
- `apps/server/src/routes/opponents.ts`（新規）・`apps/server/src/app.ts`・`apps/server/src/index.ts`: API と配線（起動時は SQLite の Store、省略時はメモリ内）
- テスト: `memory/memory-reset.test.ts`・`routes/opponents.test.ts`（新規）、`db/database.test.ts`（v11 の 2 件と、前の版のテストの「後の版のテーブルを除く」一覧に `opponent_memory_resets` を追加）
- docs: `docs/03` §1（API の表・`memory/` の説明）、`docs/04` §11（実装の節）・§12（v11 の列・Observation の観察しない Hand・意味上の順序）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 57 files / 726 tests、web 9 / 141、engine 32 / 363）
- マイグレーション: 版 10 の DB に版 11 を当てても既存のテーブルの定義・行（events・hands・sessions・session_participants・user_tags〔cpu_profile の Subject〕・learning_resets・ordinals）は変わらず、`ordinals` の CHECK は `('hand_saved', 'learning_reset')` のまま。区切りの表は追記だけで、`scope` と `cpu_profile_id` の組・空の id・知らない `scope`・その時点の最大でない `ord` を拒否
- Store（メモリ内・SQLite）: 区切りは追加した時点の最大の ord（Hand 0 件なら 0）。Fixed CPU には all と自分の cpu_profile のうち ord が大きい方、Guest には all だけ。Hand を挟まない次の区切りは追加の順で後の行
- Memory: 1 つの Fixed CPU の Reset でその CPU の Memory だけが空になり（初めての相手と同じ）、他の CPU の Memory（Reset した CPU についての Memory を含む）は同じ。Reset 後の Hand だけが Evidence になる。all で全員が空
- 時計の巻き戻り: Event の記録時刻と Reset の時刻が後ほど古くなる時計で、時刻では前後が逆に見える並びでも、保存の順で Reset 前後が決まる（メモリ内・SQLite）
- 作り直し: Reset 後の Hand が無ければ Hypothesis は空、あれば同じ入力から同じ結果で、区切りより後の Raw Evidence だけを入力にした計算と一致。区切りを外せば前の Hand を含めた Hypothesis も Event Log から作れる
- カテゴリの分離（SQLite）: Reset の前後で、`opponent_memory_resets` 以外の全テーブルの全行・削除拒否の Trigger・Learning Reset の区切り・Stats・Hero の Profile（Score / Hypothesis / 文）・Table Tendency・Tilt・Note / Tag（cpu_profile の Subject）が同じ
- Guest: 前の Session の Guest は Reset が無くても次の Session で読まれない。Fixed CPU の Reset は Guest の Memory を変えず、all は今の Session の Guest も区切る
- Hand Orchestrator: RuleBot の CPU の入力を記録し、Reset の後の最初の Hand ではどの CPU の Memory も前の Hand を含まず、次の Hand では Reset の後に保存した Hand だけを含む
- API: 全 CPU / 1 つの Fixed CPU の区切りを足し、応答は 4 つの項目だけ（Pool の名前・Persona・`forbiddenKeys` の語を含まない）。知らない CPU は 404、形の不正（7 通り）は 400 で、どちらも何も足さない
- 変異の確認（手元で入れて戻した）: Hand Orchestrator で区切りを渡さないようにすると、Orchestrator の Memory の注入のテストが落ちる
- App の配線（Codex の指摘の回帰）: Reset Store を省き、Event Store だけを独自のカウンタで渡した App で、API で Hand を進めて Reset すると、次の Hand の CPU の Memory は前の Hand を含まず、その次の Hand は Reset 後の Hand を含む。既定の Store がプロセスのカウンタを読むように戻すと落ちることを確認

## 残課題

- **Learning Reset の同根（範囲外）**: `buildApp` で Event Store だけを独自のカウンタで渡し `learningResetStore` を省くと、既定の `InMemoryLearningResetStore` はプロセスのカウンタで番号を振り、Hand の番号と比べられない（テスト用の経路だけ。起動時は同じ DB）。`learning/learning-reset.ts` はこの Issue で触らない範囲なので別 Issue にした。

- **画面の入口が無い**: API だけ。全 CPU だけの入口にするか、1 つの Fixed CPU を選ばせる（Fixed CPU の名前・`cpuProfileId` を Hero に見せる）かは別 Issue で決める。
- **Subject 側の Memory は消さない**: 「Reset した CPU について他の CPU が持つ Memory」も消したい場合は、Subject 側の区切りを足す別の変更になる（D120 の範囲外。正本は残っているので後から足せる）。
