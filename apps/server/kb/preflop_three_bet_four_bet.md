---
id: preflop_three_bet_four_bet
title: 3-bet / 4-bet に直面したときと、3-bet するときの考え方
topic: preflop_3bet
label: HEURISTIC
formats: [cash]
streets: [preflop]
spots: [preflop_facing_raise]
actions: [open, three_bet, call_three_bet, four_bet_plus]
keywords: [3bet, 3-bet, 4bet, 4-bet, squeeze, スリーベット, フォーベット, 再レイズ]
source:
  - docs/research/02_strategy_and_math.md §10 | PokerStars Learn — 3-Betting
date: 2026-10-06
version: 1
---

# 3-bet / 4-bet

Raise に Raise（3-bet）し、さらに Raise（4-bet）する場面。Squeeze は、Raise と Call の後ろからの 3-bet。

## 見るポイント

- 3-bet は Position・Open Size・Effective Stack で意味が変わる。Open した相手の Position が Late なほど Open の Range は広く、3-bet に対して Fold する割合も多くなりうる。
- 相手の 3-bet の Range は、その相手が観察できた 3-bet の頻度（Opponent Observation）に左右される。極端に Tight な 3-bet が観察できているなら、Opening / Defense の調整候補になる。ただし少数 Sample は確からしさを低く書く（`exploit_evidence_and_sample`）。
- Raise に Raise された後の Range は、その Action ごとに更新される。3-bet に Call した相手の Range は 4-bet / Fold を除いた部分なので、Range Evidence の Assumption に残している分類（`three_bet` / `call_three_bet` / `four_bet_plus`）に沿って読む。

## 注意

3-bet の頻度の目安や個別の Hand の数字は Format・Stack・Rake で変わる。Review では HEURISTIC として扱い、断定しない。
