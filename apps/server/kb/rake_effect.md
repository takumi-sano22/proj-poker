---
id: rake_effect
title: Cash の Rake が戦略に与える影響
topic: rake
label: HOUSE_RULE
formats: [cash]
spots: [preflop_facing_raise, preflop_open]
streets: [preflop]
keywords: [rake, レーキ, 手数料, marginal, cold call, blind defense]
source:
  - docs/research/02_strategy_and_math.md §11 | PokerStars Learn — Rake
date: 2026-10-06
version: 1
---

# Rake の影響

Cash の Rake が高いほど、Marginal な Pot 参加の EV は悪化する。特に影響を受けるのは次の場面。

- Cold Call
- Blind Defense
- Small-edge Spot（わずかな優位しかない場面）

## 注意

- Rake の取り方（割合・上限・Pot が Flop を見たときだけ、等）は会場・Profile に依存する（HOUSE_RULE）。
- Cash Preset は Rake の前提（Rake Context）を持たせる方針。現在の Engine の Math / Equity には Rake を含めない。Review では、Rake を含めない前提を Assumption に残し、Marginal な判断では「Rake を考えるとさらに厳しくなる」方向だけを書く。
