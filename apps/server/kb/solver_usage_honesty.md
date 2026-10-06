---
id: solver_usage_honesty
title: Solver は Evidence の 1 つ（Unsupported と Multiway の扱い）
topic: solver_usage
label: THEORY_BASELINE
formats: [cash]
spots: [postflop_facing_bet, postflop_aggressor, postflop_checked_to, preflop_facing_raise]
keywords: [solver, ソルバー, gto, capability, unsupported, fallback, 均衡, baseline, heads-up solver]
source:
  - docs/research/05_solver_and_analysis.md §1
  - docs/research/05_solver_and_analysis.md §2
  - docs/research/05_solver_and_analysis.md §4
date: 2026-10-06
version: 1
---

# Solver の位置づけ

Solver は Review Evidence の 1 つで、Baseline（指定した Range・Stack・Pot・Bet Tree での Strategy と EV）を示す。

## Solver だけでは分からないもの

- 実在の相手の本当の Range
- Hero が当時何を知っていたか
- Live の Tell・House Rule の違い
- Unsupported な Multiway の Spot

## 扱い方

- Solve の前に、必ず Solver が扱える Spot か（`supports`）を確認する。Unsupported はエラーではなく正常系で、Math・Range Model・KB・Review AI に Fallback する。
- Heads-Up Solver の結果を Multiway の Exact GTO として扱わない。途中まで Multiway だった Pot が Heads-Up に絞られた場合は、そこまでの Action・Card Removal・Range の推定が Assumption になる。Assumption を Review に表示する。
- Solver の結果は Input の Range・Tree の仮定に依存する。「GTO で X だから常に X が正しい」とは教えず、Practical な Baseline を先に、必要なら Theory、Evidence があれば Exploit の順で説明する。
