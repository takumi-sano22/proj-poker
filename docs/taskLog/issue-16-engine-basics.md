# Issue #16: Engine 基礎（Card / Deck・seed 付き RNG・Hand Evaluator）と Phase 1 判断 D70〜D73 の記録

## 概要

Phase 1 の土台として `packages/engine` に Card / Deck、seed を注入できる RNG とシャッフル、Hand Evaluator を実装した。あわせてセッション冒頭の人間判断 4 項目を D70〜D73 として `decision_log.yaml` に記録し、関連 docs を同期した。Hand の進行（Betting・Street）は #17 の担当のため作っていない。

## 設計方針

- **Card**: Rank は数値（2〜14、Ace=14）、Suit は 1 文字（c/d/h/s）。"As" 形式の文字列表記と相互変換できる（ログ・テスト用）。
- **RNG**: mulberry32。`createRng(seed)` は `() => number`（[0,1)）を返す。Fisher-Yates で新しい配列を返す `shuffle`。`Math.random` / `Date` は使わない（テストで spy して未呼び出しを assert）。seed 空間が 2^32 なので、同じ seed でしか再現しない best-effort の再現性（docs/02 §10）。
- **Hand Evaluator**: 外部ライブラリを使わず自作。5〜7 枚の全 5 枚組（最大 21 通り）を評価して最大を取る。性能より正しさと読みやすさを優先した。結果は `{ category, tiebreakers(5 要素), score, bestFive }`。`score` は category と tiebreakers を 15 進数で畳んだ整数で、比較・ソート用。Wheel は 5-high Straight、Royal Flush は Ace-high の Straight Flush。
- **入力検証**: 5〜7 枚以外・重複カードは `RangeError`（黙って丸めない）。
- **Chip の表現は決めていない**: 本 Issue は Chip を扱わない。最初に Chip を扱う #17 で決め、decision-log に記録する（`implementation-guidance/references/poker-engine.md` 項目 6）。

## テスト（poker-engine-testing）

- カテゴリごとの固定ケース（9 カテゴリ + Wheel / Steel Wheel / Royal / Wrap-around）。期待値は手で決めたもの。
- 弱い順に並べた 27 手の全ペア比較（Kicker・Trips ランク優先・Wheel < 6-high など）。
- 6〜7 枚の選択（Three Pair、Trips 2 組、Flush 6 枚、Straight と Flush が別々、Wheel + 6 など）。
- 独立した正解として、52 枚から 5 枚の全 2,598,960 通りを評価し、カテゴリ別の出現数が組合せ論の既知値（Straight Flush 40 / Quads 624 / Full House 3,744 / Flush 5,108 / Straight 10,200 / Trips 54,912 / Two Pair 123,552 / Pair 1,098,240 / High Card 1,302,540）と一致することを確認する。
- Property（fast-check）: 反対称性・反射性・推移律・score と辞書式比較の一致・並び順不変・カード追加での単調性・bestFive の妥当性。
- seed: 同じ seed なら同じ乱数列・同じ Deck、任意の seed で 52 枚の置換。seed 42 の先頭 5 枚は回帰ピン（現行出力の固定。アルゴリズムを意図して変えたときだけ更新）。

## 変更ファイル

- 新規: `packages/engine/src/{card,rng,hand-evaluator}.ts`、同 `*.test.ts`、`hand-evaluator.property.test.ts`
- 変更: `packages/engine/src/index.ts`（公開 API の export。`ENGINE_PACKAGE_NAME` は維持）
- 削除: `packages/engine/src/index.property.test.ts`（Phase 0 のプレースホルダ。実際の Property テストに置き換え）
- 変更: `docs/decision_log.yaml`（D70〜D73 追記・範囲表記）、`docs/10_DECISION_TRACEABILITY.md`、`docs/00_DOCUMENTATION_INDEX.md`、`docs/03_SYSTEM_ARCHITECTURE.md`（Phase 1 の実装方針を追記）
- 触っていない: `apps/**`・`.claude/**`・`CLAUDE.md`・`AGENTS.md`・`README.md`

## 残課題

- 範囲表記 `D01〜D69` が統制面と README に残っている: `README.md`、`.claude/skills/{test-and-review,sync-check,decision-log}/SKILL.md`。担当外のため親が別途更新する。
- Chip の数値表現の決定は #17。
