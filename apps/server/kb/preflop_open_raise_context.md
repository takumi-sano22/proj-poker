---
id: preflop_open_raise_context
title: Preflop の Open Raise（RFI）で見る Context
topic: preflop_open
label: HEURISTIC
formats: [cash]
streets: [preflop]
spots: [preflop_open]
keywords: [open raise, rfi, オープン, limp, iso raise, レイズ, 参加 range]
source:
  - docs/research/02_strategy_and_math.md §10 | Upswing Poker — Preflop Charts and Ranges
  - docs/research/02_strategy_and_math.md §8
date: 2026-10-06
version: 1
---

# Preflop の Open Raise

誰も Raise していない場面の選択肢は Open Raise（RFI）・Limp・Fold。Limp の後に Iso Raise する場面もある。

## 評価に必要な Context

- Position（Early ほど狭く、Late ほど広い）
- Player 数と、まだ Action していない人数
- Open Size
- Effective Stack
- Rake・Ante
- 相手の傾向（観察できた Evidence がある場合だけ）

## 注意

- Preflop Chart の % や個別の Hand は、Format・Stack・Rake・Open Size の前提つきの目安で、普遍的な RULE ではない。Review では「この Position・この Hand は常に Open」のように断定しない。
- Chart の Hand を KB の根拠として転記しない（Solver の出力や特定 Chart の転記は行わない方針）。判断の評価は、Range Evidence の Assumption と Math Evidence を併記して Confidence を付ける。
