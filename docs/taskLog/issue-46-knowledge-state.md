# Issue #46: CPU ごとの KnowledgeState と決定論 Math

## 概要

Phase 3（AI Opponents）の最初の子 Issue。暫定 CPU に渡していた `BotView`（`projectBotView`）を、docs/05 §1 の入力を満たす Player ごとの `KnowledgeState`（`projectKnowledgeState`）に置き換え、`OpponentAgent` の入力を `{ knowledge, legal }` にした。あわせて Phase 3 の人間判断 D82〜D86 を `docs/decision_log.yaml` に記録した。Event の形・永続化スキーマ・RuleBot の挙動は変えていない。

## 初期調査

- `packages/engine/src/projection.ts` の `projectBotView` は、見える Event（public と自分宛て private）だけを畳み込む whitelist 方式で、出力側でも他者の札を null にしていた（二重の whitelist）。卓の見え方 + Public Action の履歴を持つが、Position・Math は無かった。
- `BotView` を使っていたのは Engine の Projection テスト・Property Test、`apps/server` の `opponent-agent.ts`・`rule-bot.ts`・`hand-orchestrator.ts` とそのテスト。`apps/web` は使っていない。
- docs/05 §1 の入力のうち、Persona / State は #51、非同期化と出力の検証は #47 の範囲（Issue の境界）。

## 変更内容

- `KnowledgeState`（`BotView` を置き換え）: `TableView` に次を足した。
  - `holeCards`: 自分の Hole Cards（席の自分の値と同じ）
  - `position`: `{ buttonOffset, playerCount }`（Button から時計回りの席の距離。Heads-Up では 0 = Button = SB）
  - `actionHistory`: 自分が観察できた Public Action の履歴（従来どおり）
  - `math`: `{ callAmount, potOdds, effectiveStack, spr }`。公開情報だけから計算する。`callAmount` は Stack で頭打ち（Legal Action の call の額と一致）、`potOdds = callAmount / (pot + callAmount)`（Call 不要なら null）、`effectiveStack` は自分と「Fold していない他者の最大」の今の残り Stack の小さい方、`spr = effectiveStack / pot`（Pot 0 なら null）。
- `OpponentInput` を `{ knowledge: KnowledgeState; legal: LegalActionSet }` に変更。`decide` は同期のまま。RuleBot は `knowledge.holeCards` と `knowledge.board` を読むだけにした（値は従来の `seats` の自分の席と同じなので判断は変わらない）。
- テスト:
  - Property Test（`hand-engine.property.test.ts`）: 2〜8 人・全席・全手番で、`KnowledgeState` に知ってはいけない Card・`deck` / `seed` / `DECK_SHUFFLED` / `engine` の語が無いこと、見えない Event（Deck・他者の Hole Cards）の中身を差し替えても `KnowledgeState` が変わらないこと、Legal Action・Pot・Call 額が全情報の State と一致することを確かめる（INV-TEST-007）。
  - `projection.test.ts`: 開始直後の Position・Math、Call 額が Stack で頭打ちになる場合と有効 Stack の数え方の固定ケース。
  - テスト補助 `testing/view-leaks.ts` に `hiddenMarkers`・`tamperHiddenEvents` を足した。
- docs: decision_log に D82〜D86、範囲表記を D01〜D86 に（decision_log 先頭・docs/00・docs/10・README）、docs/10 の判断グループに D82〜D86、docs/11 の OI-001・OI-005 に「暫定値は D85（確定ではない）」、docs/03 §1・§5 と docs/04 §5 を実装に合わせた。

## 判断理由

- 名前を `BotView` から `KnowledgeState` に置き換えた（別名を残さない）。docs/02・docs/04 の用語と一致させ、同じものを二つの名前で持たないため。
- Math の比率は浮動小数のまま持つ。Chip の移動には使わない判断の目安なので D74（Chip は整数）に触れない。SPR は「今の」Pot と残り Stack で計算する（Street 開始時の SPR ではない）。Issue の「SPR 程度」に合わせた最小の定義。
- Position は呼び名（UTG・CO 等）を付けず、Button からの距離と人数だけにした。呼び名の付け方は人数ごとの流儀があり、ここで決める必要がない。
- Property Test の差し替え検査は、Reducer が見えない Event を読んでも出力側の whitelist で止まる場合は検出しない（出力に届く漏れだけを検出する）。Card の走査と語の検査と合わせて、出力に届く経路を見る。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）: すべて成功（engine 155 件・server 61 件・web 31 件）
- 既存の RuleBot・Orchestrator のテストの期待値は変えていない（入力の項目名 `view` → `knowledge` の参照だけ直した）

## 残課題

- 範囲表記 `D01〜D81` が統制面に残っている: `.claude/skills/sync-check/SKILL.md`・`.claude/skills/test-and-review/SKILL.md`（担当外のため親が更新する）。
- Persona / State の入力は #51、`decide` の非同期化・出力検証は #47。
