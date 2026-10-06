---
id: spr_and_effective_stack
title: Effective Stack と SPR
topic: spr
label: FACT
formats: [cash, tournament]
streets: [flop, turn, river]
spots: [postflop_facing_bet, postflop_aggressor, postflop_checked_to]
keywords: [spr, stack to pot ratio, effective stack, 有効スタック, コミット]
source:
  - docs/research/02_strategy_and_math.md §7 | PokerStars Learn — Stack-to-Pot Ratio
date: 2026-10-06
version: 1
---

# Effective Stack と SPR

Effective Stack は、その相手との間で実際に Risk できる小さい側の Stack です。

```text
SPR = Effective Stack / Pot
```

## Review での使い方

- Multiway では、相手ごとに Effective Stack が違いうる。誰との間の Effective Stack かを書く。
- SPR が小さいほど、この先の Street で動かせる額が Pot に対して小さく、Commit しやすい。大きいほど、後の Street の判断（Bet Size・Fold）が結果を左右する。SPR の大小を理由にした「必ず Commit する」「必ず降りる」といった断定はしない。
- SPR の値は Engine の Math Evidence（`spr`・`effectiveStack`）から取る。

## 注意

実額は常時示し、BB は補助にする（D49）。
