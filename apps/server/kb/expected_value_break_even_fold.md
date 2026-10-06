---
id: expected_value_break_even_fold
title: EV の考え方と Break-even Fold Frequency（Bet の損益分岐）
topic: expected_value
label: FACT
formats: [cash, tournament]
spots: [postflop_aggressor, postflop_checked_to, preflop_open]
keywords: [ev, 期待値, break-even fold, 必要 fold 率, bluff, fold equity]
source:
  - docs/research/02_strategy_and_math.md §5
date: 2026-10-06
version: 1
---

# EV と Break-even Fold Frequency

Equity が 0 の Bluff（Current Pot = `P`、Bet = `B`、相手が Fold する確率 = `F`）の EV は次の式です。

```text
EV = F * P - (1 - F) * B
Break-even Fold Frequency: F = B / (P + B)
```

例: P = 100、B = 50 なら、必要な Fold 率は 50 / 150 = 33.3% です。

## 数学と推定を分ける

- 「Bet が損をしないのに要る Fold 率」は計算できる数学。
- 「相手が実際に何 % Fold するか」は推定。数学と同じ確からしさ（Confidence）で書かない。

## Review での使い方

Engine の Alternative Action の簡易 EV は、Fold Equity を含めない目安で、Break-even Fold Frequency を別に示している（GTO / Solver の値ではない）。Bet / Raise の評価では、必要な Fold 率と、その場の相手がそれだけ Fold しそうか（Opponent Observation の Evidence）を分けて書く。Equity が高いなら Fold されなくても損をしにくい点も合わせて見る。
