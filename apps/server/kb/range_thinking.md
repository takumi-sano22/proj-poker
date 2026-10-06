---
id: range_thinking
title: Range で考える（1 つの Hand に決め打ちしない）
topic: range_thinking
label: FACT
formats: [cash, tournament]
spots: [preflop_facing_raise, postflop_facing_bet, postflop_aggressor, postflop_checked_to]
keywords: [range, レンジ, range 推定, card removal, 結果論, 更新, 決め打ち]
source:
  - docs/research/02_strategy_and_math.md §9 | PokerStars Learn — Thinking in Ranges
  - docs/research/03_review_and_learning.md §2
date: 2026-10-06
version: 1
---

# Range で考える

相手を 1 つの Hand に決め打ちせず、「その相手が取りうる Hand の集まり（Range）」で考える。Range は Action のたびに更新する。

```text
Prior Range → Preflop Action → Updated Range → Flop の Board / Action → Updated Range → Turn → River
```

## Review での使い方

- Pass A（Decision Review）では、判断時点で観察できた Action だけから Range を更新する。「実際は KQ だったから KQ を読むべきだった」という結果論は禁止。
- Hero の Hole Cards と見えている Board の Card は、相手の Range から除く（Card Removal）。
- Engine の Range Evidence は簡易モデル（Draw を数えない等）で、Assumption に前提を付けている。標準・Tight・Loose の想定で結論が変わるなら、結論の確からしさを下げて書く。
