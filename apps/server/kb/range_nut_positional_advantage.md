---
id: range_nut_positional_advantage
title: Range Advantage・Nut Advantage・Positional Advantage
topic: range_advantage
label: HEURISTIC
formats: [cash]
streets: [flop, turn, river]
spots: [postflop_aggressor, postflop_checked_to, postflop_facing_bet]
keywords: [range advantage, nut advantage, positional advantage, ナッツアドバンテージ, レンジ優位, board texture]
source:
  - docs/research/02_strategy_and_math.md §12 | Upswing Poker — Positional, Range, and Nut Advantage
date: 2026-10-06
version: 1
---

# 3 つの Advantage

- Range Advantage: Range 全体の Equity が相手より高い。
- Nut Advantage: 最も強い Hand（ナッツ級）を持つ割合が相手より多い。
- Positional Advantage: 後に動ける。

## Review での使い方

- どちらが有利かは Board と、両者の Range（Preflop の Action 列）で決まる。Hero の Hand 単体の強さだけでは決まらない。
- Advantage の大小は Bet の頻度・Size の議論の材料。ただし「Preflop の Aggressor だから常に有利」と決めつけない。
- どの Range を仮定したか（Range Evidence の Assumption）を併記する。これは経験則（HEURISTIC）で、断定しない。
