---
id: river_decision
title: River の判断（Call / Fold / Bet）の考え方
topic: river_decision
label: HEURISTIC
formats: [cash]
streets: [river]
spots: [postflop_facing_bet, postflop_aggressor, postflop_checked_to]
keywords: [river, リバー, bluff catch, ブラフキャッチ, big bet, overbet, 最後の bet, showdown, hero call]
source:
  - docs/research/02_strategy_and_math.md §2 | PokerStars Learn — Pot Odds
  - docs/research/02_strategy_and_math.md §5
  - docs/research/03_review_and_learning.md §6
date: 2026-10-06
version: 1
---

# River の判断

River は、この先に Card が出ない最後の Street。Call した Hand の勝敗は Showdown で決まり、Implied Odds（この先に取れる額）は無い。

## 見るポイント

- Call: 必要 Equity（Pot Odds）に対して、相手の Range の中で Hero に負ける Hand と勝てる Hand の比率を考える。大きな Bet ほど必要 Equity は高く、相手の Range は強い Hand に偏りやすいが、Bluff も混ざる。
- 相手の Bet の大きさ・それまでの Action 列から、Value と Bluff の割合をどう見積もったかが評価の中心。Hero の Hand の絶対的な強さだけで決めない。
- Bet / Bluff: 必要な Fold 率（`expected_value_break_even_fold`）と、相手の Range の Fold しやすさ・Hand が勝ちうる Showdown Value を見る。
- Bluff Catch（弱めの Hand で相手の Bluff に Call する）の評価は、相手が Bluff をする証拠（観察できた Showdown の履歴）の量に依存する。少ない Sample は確からしさを低く書く。

## Review での使い方

- 判断時点で見えていた情報だけで評価する。Call した相手が実際に持っていた Hand（Showdown の結果）は Pass B（Reveal Review）で扱い、Pass A の評価を後から変えない。
- Equity と Required Equity の比較（Engine の Math Evidence）を根拠にし、KB の文に数値を書かない。
