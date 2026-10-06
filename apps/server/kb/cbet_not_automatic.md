---
id: cbet_not_automatic
title: C-bet（Continuation Bet）は自動ではない
topic: cbet
label: HEURISTIC
formats: [cash]
streets: [flop]
spots: [postflop_aggressor]
actions: [call_open, call_three_bet]
keywords: [c-bet, cbet, continuation bet, コンベット, flop, aggressor, board texture, check back]
source:
  - docs/research/02_strategy_and_math.md §12 | PokerStars Learn — Continuation Betting
date: 2026-10-06
version: 1
---

# C-bet

Continuation Bet（C-bet）は、Preflop の最後の Raiser が、Flop で最初に Bet すること。

## 見るポイント

- 「Preflop の Aggressor だから常に C-bet」という固定のルールにしない。Board・両者の Range・Position・Player 数で変わる。
- 一般に C-bet が多い・少ないという教材の傾向は、Board や Range の前提つきの General Heuristic。Solver が対応する Spot では、Solver の結果のほうが特定の文脈に具体的。両者は必ずしも矛盾しない。
- Check（Check Back）を選ぶ理由（Range Advantage が小さい Board・Showdown Value を守る等）が当時の情報から説明できるかを見る。
- Multiway では Bluff が成功しにくくなるので、Heads-Up と同じ助言にしない（`multiway_adjustment`）。

## Review での使い方

C-bet した・しなかったこと自体ではなく、「何を狙った Bet / Check か（Value・Bluff・Protection）」と Bet Size（`bet_sizing_purpose`）を、判断時点の Range と Board から評価する。
