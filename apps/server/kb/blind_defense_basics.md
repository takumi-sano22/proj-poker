---
id: blind_defense_basics
title: Blind Defense（SB / BB で Raise に直面したとき）
topic: blind_defense
label: HEURISTIC
formats: [cash]
streets: [preflop]
positions: [SB, BB]
spots: [preflop_facing_raise]
actions: [open, call_open]
keywords: [blind defense, ブラインドディフェンス, bb, sb, cold call, 守る, pot odds]
source:
  - docs/research/02_strategy_and_math.md §10
  - docs/research/02_strategy_and_math.md §2 | PokerStars Learn — Pot Odds
date: 2026-10-06
version: 1
---

# Blind Defense

SB / BB は、すでに Blind を払っているので、Open Raise に対して Call の価格が安い。一方で、Postflop で先に動く（Out of Position）不利がある。

## 見るポイント

- Pot Odds（必要 Equity）は Blind を払った分だけ下がる。数値は Engine の Math Evidence から取る。
- 先に動く不利のぶん、Equity をそのまま勝ちに変えにくい。Pot Odds を満たしても、常に Call が良いとは限らない。
- Open の Position が Late なほど Open の Range は広い。
- Cash の Rake が高いほど、Marginal な Call の EV は悪化する（`rake_effect`）。
- Open Size・Effective Stack・相手の傾向（観察できた Evidence）で変わる。

## 注意

Defense の頻度や個別の Hand の数字は、Format・Stack・Rake で変わる。KB は方向を示すだけで、数字を断定しない。
