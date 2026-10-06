---
id: pot_odds_required_equity
title: Pot Odds と必要 Equity（Call の価格）
topic: pot_odds
label: FACT
formats: [cash, tournament]
spots: [postflop_facing_bet, preflop_facing_raise]
keywords: [ポットオッズ, pot odds, 必要 equity, required equity, call 額, final pot]
source:
  - docs/research/02_strategy_and_math.md §2 | PokerStars Learn — Pot Odds
date: 2026-10-06
version: 1
---

# Pot Odds と必要 Equity

Call に必要な Equity（Required Equity）は、Call 額 `C` を、Call した後の Final Pot `F` で割った値です。

```text
Required Equity = C / F
```

例: Bet 前の Pot 100、相手の Bet 50、Hero の Call 50 なら Final Pot は 200 で、必要 Equity は 50 / 200 = 25% です。

## Review での使い方

- Current Pot・Call 額・Final Pot・Required Equity を分けて示す。ここは数値の事実で、値は Engine の Math Evidence（`potOdds`）から取る。KB の文に数字を転記しない。
- 勝率・Equity・Required Equity・EV は別の概念。Equity が Required Equity を上回ることは「Call が損をしない目安」であって、その場の最善を断定しない。
- Pot Odds は「今の価格」だけを見る。この先の Street で追加で取れる額・失う額は Implied / Reverse Implied Odds（`implied_odds_basics`）で別に考える。

## 注意

「Required Equity を上回ったから必ず Call」と単純化しない。Equity は仮定した相手の Range に対する値で、Range の仮定（Range Evidence の Assumption）が変われば結論も変わる。
