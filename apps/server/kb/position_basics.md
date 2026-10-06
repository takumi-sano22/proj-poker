---
id: position_basics
title: Position が Range と Equity Realization に与える影響
topic: position
label: HEURISTIC
formats: [cash]
keywords: [position, ポジション, button, btn, utg, 先に動く, 後に動く, in position, out of position]
source:
  - docs/research/02_strategy_and_math.md §8 | PokerStars Learn — Position
date: 2026-10-06
version: 1
---

# Position の一般的な Baseline

Position は、得られる情報量と Equity Realization（Equity をどれだけ勝ちに変えられるか）に大きく影響する。

- Early Position ほど、参加する Range は狭くなる。
- Late Position ほど、参加できる Range は広がる。
- Button は Postflop で最後に Action できる。

## 注意

「UTG は常に上位 X%」のような数字は RULE ではない。Format・Stack・Rake・Open Size で変わる。Engine の標準 Range（`range-config.ts`）の割合も暫定値で、永久仕様ではない。

## Review での使い方

Position を理由にするときは、「後に動けるので情報が多い」「Early Position なので Range が狭いはず」のように、方向の話にとどめる。具体的な % を KB の根拠として示さない。
