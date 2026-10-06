---
id: bluff_and_semi_bluff
title: Bluff・Semi-bluff と Blocker
topic: bluffing
label: HEURISTIC
formats: [cash]
streets: [flop, turn, river]
spots: [postflop_aggressor, postflop_checked_to]
keywords: [bluff, ブラフ, semi-bluff, セミブラフ, blocker, unblocker, fold equity, break-even]
source:
  - docs/research/02_strategy_and_math.md §12 | Upswing Poker — Bluffing in Poker
  - docs/research/02_strategy_and_math.md §5
date: 2026-10-06
version: 1
---

# Bluff・Semi-bluff・Blocker

- Bluff: 自分の Hand では勝てないが、相手を Fold させて取る Bet。
- Semi-bluff: 今は負けていても、この先の Street で改善しうる Hand（Draw 等）での Bet。Fold させる以外に、Call されても改善して勝つ見込みがある。
- Blocker: 自分の持つ Card が、相手の強い Hand の組み合わせを減らす。Unblocker は、相手の Fold しやすい Hand を減らさない。

## 見るポイント

- Bluff が損をしない Fold 率は計算できる（`expected_value_break_even_fold`）。相手が実際に Fold する割合は推定で、別に書く。
- 相手が Fold しすぎる証拠があれば Bluff を広げる候補になる（EXPLOIT）。観察が少ないなら確からしさを低く書く。
- Multiway では Bluff が成功しにくくなる（`multiway_adjustment`）。

## Review での使い方

「Bluff は良くない」「Bluff すべきだった」のような断定は避ける。必要な Fold 率・相手の Range の Fold しやすさ・Hand 自体の Equity（Semi-bluff）を分けて書く。
