---
id: equity_types_and_plausible_range
title: Equity の 3 種類と、Review で優先する「当時妥当だった Range」
topic: equity
label: FACT
formats: [cash, tournament]
spots: [postflop_facing_bet, postflop_aggressor, postflop_checked_to, preflop_facing_raise]
keywords: [equity, エクイティ, hand vs range, range vs range, 勝率, 結果論, hindsight]
source:
  - docs/research/02_strategy_and_math.md §4
  - docs/research/03_review_and_learning.md §2
date: 2026-10-06
version: 1
---

# Equity の 3 種類

- Hand vs Hand Equity: 既知の Holding 同士の勝率。
- Hand vs Range Equity: Hero の Holding と、相手の Range に対する勝率。
- Range vs Range Equity: 両者の Range 全体の勝率。

## Decision Review で優先するもの

Decision Review では、相手が実際に持っていた Hand ではなく、**判断の時点で妥当だった相手の Range** に対する Equity を使う。実際の札が分かるのは Hand の後の Reveal Review（別 Pass）で、Pass A の評価を実際の札で自動的に変えない。

## Review での使い方

- 「実際は KQ だったから KQ を読むべきだった」という結果論を書かない。
- Equity は Range の仮定（Assumption）とセットで示す。Range の想定を狭く・広くしたときに結論が変わるなら、その旨を書く。
- 勝率・Equity・Required Equity・EV を同じものとして書かない。
