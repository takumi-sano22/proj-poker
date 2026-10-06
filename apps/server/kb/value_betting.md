---
id: value_betting
title: Value Bet（より弱い Hand に Call してもらう Bet）
topic: value_betting
label: HEURISTIC
formats: [cash]
streets: [flop, turn, river]
spots: [postflop_aggressor, postflop_checked_to]
keywords: [value bet, バリューベット, thin value, 薄い value, 弱い hand に call, 相手 range]
source:
  - docs/research/02_strategy_and_math.md §12 | PokerStars Learn — Value Betting
date: 2026-10-06
version: 1
---

# Value Bet

Value Bet は、自分より弱い Hand に Call してもらうことで、期待値を増やす Bet。

## 見るポイント

- 「Bet に Call する相手の Range の中に、自分より弱い Hand がどれだけあるか」で考える。Hero の Hand が強いかどうか単体では決まらない。
- 相手が Call しすぎる（観察できた Evidence がある）なら、Value を広げ Bluff を減らす候補になる（EXPLOIT。`exploit_evidence_and_sample`）。
- Bet Size で、Call してもらえる Range の広さが変わる（`bet_sizing_purpose`）。

## Review での使い方

Hand が強いから Bet、という理由だけで評価しない。判断時点の相手の Range（Range Evidence）に対する Equity と、Call してくる Hand を比べて書く。Check を選んだ判断も、同じ観点で評価する。
