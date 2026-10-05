# Issue #34: Position Engine（次 Hand の Button・Blind・Heads-Up 転換）

## 概要

前 Hand の結果から次 Hand の席と Button を決める純粋関数 `nextHandSeating` を Engine に追加した（`packages/engine/src/position.ts`）。Bust（Stack 0）した Player を外し、Button は Rule Profile の設定値 `buttonRule`（暫定値 `simple_moving`。D80・OI-008）で進める。Event の形（`HandEvent`・`schema_version`）は変えていない。Server（Session）への組み込みは #35。

## 設計方針

- **入力**: 前 Hand の席順（`HAND_STARTED` の `seats` の順）・`HAND_FINISHED` の `stacks`・前 Hand の `buttonPlayerId`（`PreviousHandResult`）と `Pick<TableConfig, "buttonRule">`。
- **出力**: `EngineResult<NextHandSeating>`。`next_hand`（席順を保った `seats` と `buttonPlayerId`。`startHand` にそのまま渡せる）か、残りが 1 人以下なら `no_next_hand`（残った Player）。入力の不整合（人数・重複・Button 不在・stacks と席の不一致・Chip が整数でない・未知の buttonRule）は `startHand` と同じく `invalid_input` で返す。
- **Button の規則（simple_moving）**: 前 Button の次の席から時計回りに見て、次 Hand に座っている最初の Player。前 Button 本人が Bust しても同じ規則（Dead Button なし）。
- **buttonRule の置き場所**: `TableConfig` に必須項目として追加し、`PHASE1_CASH_PRESET` は `simple_moving`。Hand の中では使わず、結果が次 Hand の `HAND_STARTED` の席順・`buttonPlayerId` に残るので Event には項目を足さない（schema_version は据え置き）。
- **SB・BB**: 決めるのは既存の `startHand`（Heads-Up は Button = SB、3 人以上は Button の左が SB）。Position Engine は Button だけを決める。

## テスト

- 単体（`position.test.ts`）: 1 席進む・末尾から先頭へ戻る・Bust を除いて席順を保つ・次の席の Bust を飛ばす・前 Button 本人の Bust・前 Button と次の席の連続 Bust・残り 1 人 / 0 人は `no_next_hand`・不正入力 8 種と未知の buttonRule の拒否。
- Scenario（実際に `startHand` → `applyAction` で Bust させ、Event Log から次 Hand の入力を作る。各 Step で Invariant と Event の畳み込みを確認）:
  - `SCN-position-3to2-001`: 3 人→Heads-Up 移行。次 Hand は Button = SB、Preflop は Button が先手・Postflop は Button が後手（docs/02 §5・§7）。
  - `SCN-position-button-bust-001`: Button 本人の Bust。次の生存席が Button、その左が SB・BB。
  - `SCN-position-consecutive-bust-001`: 同じ Hand で 2 人が Bust → Heads-Up → 次の Hand でもう 1 人 Bust して `no_next_hand`。
- Property（`position.property.test.ts`）: Bust なしなら人数分の Hand で全員が 1 回ずつ Button になり元へ戻る。Bust ありでも席順を保って Stack 0 だけを外し、Button は前 Button から時計回りで最初の生存席、結果は `startHand` に渡せて Heads-Up なら Button = SB。
- 変異確認: Button の探索開始を 1 席ずらすと 8 本が失敗することを確認して戻した。
- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 150・web 27・server 51）/ `pnpm format:check` が通過。

## 変更ファイル

- `packages/engine/src/position.ts`（新規）・`position.test.ts`（新規）・`position.property.test.ts`（新規）
- `packages/engine/src/table-config.ts`（`ButtonRule`・`TableConfig.buttonRule`・Preset）・`index.ts`（公開）・`hand-engine.test.ts`（Config リテラルに `buttonRule`）
- `docs/03_SYSTEM_ARCHITECTURE.md`（Engine の入口に Position Engine）・`docs/02_DOMAIN_RULES_AND_POLICIES.md`（Rule Profile の対象に Button Movement）

## 残課題

- Server（Session）での利用（Hero の Bust・CPU だけ残ったときの Session 終了を含む）は #35。
- `docs/03` の Server 節「Button は Hand ごとに時計回りに 1 席ずつ動かします（Session での決め方は後続 Issue）」は Server の現状の記述なので、#35 で `nextHandSeating` に置き換えるときに更新する。
