---
id: bet_sizing_purpose
title: Bet Size は目的で決まる
topic: bet_sizing
label: HEURISTIC
formats: [cash]
streets: [flop, turn, river]
spots: [postflop_aggressor, postflop_checked_to]
keywords: [bet size, ベットサイズ, sizing, 大きい bet, 小さい bet, pot の何 %, 目的]
source:
  - docs/research/02_strategy_and_math.md §12
  - docs/research/03_review_and_learning.md §3
date: 2026-10-06
version: 1
---

# Bet Size

Bet Size は「何を狙った Bet か」で決まる。

- Value: Call してくる Hand の幅と、取れる額のバランス。
- Bluff: 必要な Fold 率は Size が大きいほど高くなる（`expected_value_break_even_fold`）。
- Protection: 相手の Draw に払わせる価格。

## 見るポイント

- Size を変えると、相手の必要 Equity（Pot Odds）も変わる。
- Review で Size の評価に迷うときは、ユーザーに「Bet Size の目的は何だったか」を聞く（Review Interview）。回答は UserDecisionContext として扱う。
- 「Pot の何 % が正解」のように Size を 1 つに決めない。Engine の Alternative Action が示す Size（Pot の半分・Pot 等）は比較のための候補で、推奨値ではない。
