# Issue #32: Short All-in の Reopen（累積 Short All-in を含む）

## 概要

Short All-in による Action の再開（Reopen）規則を Rule Profile の設定値 `reopenRule` にし、暫定値 `cumulative_full_raise`（TDA 準拠の累積 Full Raise。D79・OI-008 の暫定値で永久仕様ではない）を実装した。Phase 1 は「行動の後に Full Raise が 1 回でもあったか」（`fullRaiseCount`）だけで判定しており、Short All-in が複数重なって Full Raise 幅に達するケース（累積 Short All-in）を再開させていなかった。

## 設計方針

- **判定に使う State を「回数」から「額」に変えた**: `PlayerState.actedAtRaiseCount`（最後に行動した時点の Full Raise 回数）を `actedAtBet`（最後に行動した直後の最高額 `currentBet`）に置き換え、`HandState.fullRaiseCount` を削除した。再開の判定は `currentBet − actedAtBet >= lastRaiseSize`（直近の Full Raise 幅）。Full Raise が 1 回でもあればその増分（= 新しい Raise 幅）だけで満たすので、Phase 1 の判定（Full Raise があれば再開・Short All-in 1 回では再開しない）を包含し、Short All-in の合計で達するケースが加わる。累積は Player ごとに「その Player の最後の行動」から数える（途中で Call した Player は、そこからの上乗せだけを見る）。
- **規則は Rule Profile の設定値**: `TableConfig.reopenRule`（型 `ReopenRule = "cumulative_full_raise"`）。`oddChipRule` と同じ作法で、`startHand` の入力検証が未知の値を `invalid_input` で拒否し、`HAND_STARTED` に残して State（`HandState.reopenRule`）へ畳み込む。`canRaise` は `reopenRule` で分岐する（`switch` の網羅で、値を足したら分岐を書かない限り型エラーになる）。
- **`HAND_STARTED` に入れた理由**: Legal Action は Server の全体 State だけでなく、Projection（`projectHeroView` / `projectBotView`）からも `getLegalActions` で計算する。Projection は Event しか見ないので、規則は Event に無いと再現できない。`ruleProfile` の ID から導出する案は、`oddChipRule`（D75）が設定値を Event に直接残している作法と食い違い、ID と設定値の対応表を別に持つことになるので採らなかった。
- **Event の版を 3 に上げた（D76）**: `HAND_STARTED` に必須項目を足すので互換の無い変更。版 1・2 の行は読み込み時に `upcastV2ToV3`（`apps/server/src/event-upcast.ts`。版 1 は `upcastV1ToV2` の後）で `reopenRule: "cumulative_full_raise"` を補う。補う値が過去の挙動と食い違わない根拠: (1) `reopenRule` は Reducer の State 遷移に使わず Legal Action の計算だけに使う。(2) 版 2 までの Server は全員同じ Stack で Hand を始める（`PHASE1_TABLE_SETUP`）ので、Fold していない Player の「この Street で出せる上限」は全員同じになり、最高額を上げる All-in は 1 Street に 1 回まで。累積と単発の判定が一致する。保存済みの行は書き換えない。テーブル（マイグレーション）は変えていない。
- **`ruleProfile` の ID（`phase1_provisional_v0`）は変えていない**: 判定に使う設定値は `HAND_STARTED` に個別に残るので、Event Log から規則を一意に読める。Preset の改名は範囲外。

## テスト（poker-engine-testing）

- **Scenario**（`hand-scenarios.test.ts`。期待値の手計算はコメント）:
  - `SCN-cumulative-short-allin-reopen-001`: UTG の Raise 100（幅 98）に Short All-in が 2 つ（+50・+50）。UTG から見た上乗せ 100 >= 98 で再開し、最小 Raise は 200 + 98 = 298。Main / Side Pot を組み合わせた（Side Pot は 2 人目の Short All-in の KK が取る）。
  - `SCN-cumulative-short-allin-no-reopen-001`: Short All-in 2 つの合計が 80 < 98 で再開しない（Raise・All-in は拒否、Call / Fold だけ）。
  - `SCN-cumulative-reopen-per-player-001`: 1 つ目の Short All-in の後で Call した Player には、その後の Short All-in（+50）だけでは再開せず、先に行動した UTG には合計（+100）で再開する。
  - 既存 `SCN-short-allin-no-reopen-001` / `SCN-full-allin-reopens-001` はそのまま通る（source の「累積は Phase 2」を D79 に更新）。
- **入力検証**（`hand-engine.test.ts`）: 未知の `oddChipRule`・未知の `reopenRule` を `invalid_input` で拒否する。既存の Config リテラルに `reopenRule` を足した。
- **upcast**（`apps/server/src/sqlite-event-store.test.ts`）: 版 2 の形（`HAND_STARTED` に `reopenRule` なし）で行を書き、読み出すと現在の Engine が発行した Event と一致し、行は版 2 のまま（payload も書き換えない）。版 1 の既存テストは版 1 の形から `reopenRule` も外して書き、版 1 → 2 → 3 の連鎖を確かめる。

## 変更ファイル

- `packages/engine/src/table-config.ts`・`hand-events.ts`・`hand-state.ts`・`legal-actions.ts`・`hand-engine.ts`・`index.ts`
- `packages/engine/src/hand-engine.test.ts`・`hand-scenarios.test.ts`
- `apps/server/src/event-upcast.ts`・`sqlite-event-store.ts`・`sqlite-event-store.test.ts`
- `docs/03_SYSTEM_ARCHITECTURE.md`（Betting 範囲・Engine の入口）・`docs/04_DATA_AND_EVENTS.md`（§3 の Event 表・schema_version の版 3）

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan を参照）。
- UI は変えていない。現状の Orchestrator は全 Hand を均等 Stack で始めるため累積 Short All-in は起きず、画面の挙動は変わらない。dev サーバーでの実測は行っていない。

## 残課題

- `docs/02` §3 の Rule Profile 一覧には現在の設定値（`oddChipRule`・`reopenRule`）を書いていない（実装の一次情報は `docs/03`）。D75 と同じ扱い。
