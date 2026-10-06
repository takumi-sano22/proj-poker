---
id: outs_rule_of_4_and_2
title: Outs と Rule of 4 and 2（実卓の暗算の目安）
topic: outs_equity
label: HEURISTIC
formats: [cash, tournament]
streets: [flop, turn]
spots: [postflop_facing_bet]
keywords: [アウツ, outs, rule of 4 and 2, ドロー, draw, dirty outs, duplicate outs]
source:
  - docs/research/02_strategy_and_math.md §3 | PokerStars Learn — Calculating Outs
date: 2026-10-06
version: 1
---

# Outs と Rule of 4 and 2

Outs は、この先の Street で Hand を改善し、勝ちにつながりうる、まだ見えていない Card です。

## 実卓の暗算の目安（HEURISTIC）

- Flop から River までの概算: Outs × 4%
- 次の 1 Street だけ: Outs × 2%

アプリは正確な確率を Engine で計算できる。この目安は、実卓で暗算するときの近似として教える価値がある、という位置づけ。

## Outs を数えるときの注意

- Duplicate Outs: 別のドローと重なる Card を二重に数えない。
- Dirty Outs: 引いても Hand が改善しない・より強い Hand に負ける Card がある。
- Domination: 相手の Hand に支配されている場合は、Outs が実質的に減る。
- 相手の Range によって、同じ Outs でも価値が変わる。

## Review での使い方

Review では Rule of 4 and 2 の概算ではなく、Engine の Equity（Range に対する値）を根拠にする。この項目は、ユーザーが実戦でどう暗算できたかを説明するときの補助に使う。
