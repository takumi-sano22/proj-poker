---
id: multiway_adjustment
title: Multiway は Heads-Up と同じ助言を流用しない
topic: multiway
label: HEURISTIC
formats: [cash]
players: [multiway]
spots: [postflop_aggressor, postflop_checked_to, postflop_facing_bet, preflop_facing_raise]
keywords: [multiway, マルチウェイ, 3way, 3-way, 複数人, player count, bluff, heads-up]
source:
  - docs/research/02_strategy_and_math.md §14
  - docs/research/05_solver_and_analysis.md §4
date: 2026-10-06
version: 1
---

# Multiway

3 人以上が残る Pot は、Heads-Up と同じ助言をそのまま流用できない。一般に次のように変わる。

- Bluff が成功しにくくなる（誰か 1 人が Call すれば失敗する）。
- Range 同士の相互作用が増える。
- Equity Realization が変わる。
- Effective Stack が複数あり、相手ごとに違いうる。
- Solver が扱いにくくなる。

Player 数は、Review の入力の最初から持つ値（First-class Parameter）として扱う。

## 注意

- Heads-Up の Solver の結果を、Multiway の Exact GTO として扱わない（`solver_usage_honesty`）。
- Engine の Multiway の Equity は Monte Carlo（seed 固定）で、相手同士の Range の重なりで求められないことがある。その場合は Equity なしと Assumption が付く。Review はその前提を引き継ぐ。
