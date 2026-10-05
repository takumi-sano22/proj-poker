# Issue #23: Engine の Odd Chip Split（端数の配分）

## 概要

Split Pot で割り切れない端数が出ると `unsupported_state`（`odd_chip_split`）で Hand が止まっていたのを、Rule Profile の設定値 `oddChipRule` に従って配るように置き換えた。人間判断（2026-10-05 の AskUserQuestion）により D70 のうち「Split Pot の端数は Phase 2」の部分を D75 で変更する。Side Pot の `unsupported_state` は D70 のまま残す。

## 設計方針

- **配り方は Rule Profile の設定値**: `TableConfig.oddChipRule`（型 `OddChipRule`。現状は `first_left_of_button` のみ）。OI-008 の暫定値で、永久仕様にしない。分岐を Engine 内の定数や `if` に散らさず、`splitPot` の `switch` に閉じる（型が増えたら網羅性エラーで気付ける）。
- **Event Log だけで再現できるようにする**: `oddChipRule` を `HAND_STARTED` に残し、`HandState` へ畳み込む（`awardShowdown` は State だけを見る）。`POT_AWARDED.awards` は端数配分済みの額。
- **配分は純粋関数 `splitPot`**（`pot-split.ts`）: 勝者を「Button の左から時計回り」に並べて渡し、`floor(pot / n)` を全員へ、余り分を先頭から 1 Chip ずつ足す。Σ 配分 = Pot は構造的に成り立つ。Pot が負・非整数、勝者ゼロは例外（Chip を黙って失わない）。
- `awardShowdown` は失敗しなくなったので `EngineResult` をやめた。`EngineError.unsupported_state.reason` は `"side_pot"` だけになった。
- `startHand` は未対応の `oddChipRule`（JS 呼び出し側の誤り）を `invalid_input` で拒否する。

## テスト（poker-engine-testing）

- **Scenario**（`hand-scenarios.test.ts`。期待値はコメントに手計算を残した）:
  - `SCN-odd-chip-2way-001`: 2 人の同着・Pot 5 → Button の左に近い BB が 3、BTN が 2。
  - `SCN-odd-chip-3way-001`: 3 人の同着・Pot 14（余り 2）→ 先頭 2 人が 5、残りが 4。Fold した BB の dead money を含む。
  - `SCN-odd-chip-order-001`: 席番号が小さい勝者より、Button の左に近い勝者が先に受け取る（Button 起点の順序の確認）。
- **単体**（`pot-split.test.ts`）: 割り切れる／勝者 1 人／余り 1・2・n−1／Pot < 勝者数／不正入力。
- **Property**（`pot-split.property.test.ts`）: Σ 配分 = Pot、各配分は floor か +1 で +1 は先頭から連続。
- **Hand 進行の Property**（`hand-engine.property.test.ts`）: 均等 Stack では `unsupported_state` で止まらず、全 Hand が `complete` かつ Pot 0（端数込みで毎ステップ Chip 保存を確認）。

## 変更ファイル

- `packages/engine/src/pot-split.ts`（新規）・`pot-split.test.ts`（新規）・`pot-split.property.test.ts`（新規）
- `packages/engine/src/table-config.ts`・`hand-events.ts`・`hand-state.ts`・`hand-engine.ts`・`index.ts`
- `packages/engine/src/hand-engine.test.ts`・`hand-engine.property.test.ts`・`hand-scenarios.test.ts`
- `docs/decision_log.yaml`（D75 追記・D70 の status 更新・範囲表記）・`docs/00_DOCUMENTATION_INDEX.md`・`docs/10_DECISION_TRACEABILITY.md`（範囲表記）・`docs/03_SYSTEM_ARCHITECTURE.md`・`docs/04_DATA_AND_EVENTS.md`（実装との同期）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（Engine 11 ファイル・109 テスト）/ `pnpm format:check` をルートで実行（結果は PR の Test plan を参照）。

## 残課題

- #18 の Hand ループは `odd_chip_split` を考慮しなくてよくなった。`side_pot`（不均等 Stack）は引き続き Phase 2。
- Side Pot が入ると、端数は Pot ごとに配分することになる（Pot ごとの eligible な勝者に対して `splitPot` を呼ぶ形で拡張できる）。
- OI-008（Live Ruling 範囲）は未確定のまま。`oddChipRule` の値が増える場合は人間判断が要る。
