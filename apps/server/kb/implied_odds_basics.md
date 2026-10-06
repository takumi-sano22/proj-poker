---
id: implied_odds_basics
title: Implied Odds と Reverse Implied Odds（今の価格を超えて考える）
topic: implied_odds
label: HEURISTIC
formats: [cash, tournament]
streets: [flop, turn]
spots: [postflop_facing_bet, preflop_facing_raise]
keywords: [implied odds, reverse implied odds, インプライドオッズ, ドロー, 追加 value, set mining]
source:
  - docs/research/02_strategy_and_math.md §6 | PokerStars Learn — Implied Odds
date: 2026-10-06
version: 1
---

# Implied Odds と Reverse Implied Odds

Pot Odds は今の価格（Call 額と Pot）だけを見る。この先の Street で次の 2 つを考えるのが Implied / Reverse Implied Odds。

- Implied Odds: Hand が完成した後に、追加で Value を取れる見込み。
- Reverse Implied Odds: Hand が完成しても、より強い Hand に負けて追加で失う見込み。

## Review での使い方

- Required Equity を下回る Call でも、Implied Odds があれば妥当になりうる。逆に、Required Equity を上回る Call でも、Reverse Implied Odds が大きければ妥当とは限らない。
- 追加で取れる額は相手の Range・Stack の深さ・Position に依存する推定で、Engine の数値のように断定しない。Effective Stack と SPR（`spr_and_effective_stack`）が小さいほど、この先に取れる・失う額は小さい。
- Engine の簡易 EV には Implied Odds を含めていない。含まれていない前提を、評価の「何が変わると結論も変わるか」に書く。
