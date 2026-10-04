# 学習とAnalytics設計

## 1. 原則

短期収支をPoker Skillと同一視しません。

主評価:
- その時点で利用可能な情報に基づくDecision Quality

補助評価:
- 実額収支
- BB収支
- 結果Variance

## 2. Ability Dimension

初期候補:

- Preflop
- Postflop
- Bet Sizing
- Pot / Equity Math
- Range Reading
- Opponent Adaptation
- Position
- Live Mechanics

各Abilityに持つもの:

- Score
- Confidence
- Sample Size
- Evidence IDs
- Trend

## 3. Detailed Statistics

Eventを十分細かく保存し、後から多くのStatを再計算可能にします。

通常UI:

- VPIP
- PFR
- 3-bet
- 一部Aggression / Fold Metrics
- Position別
- Street別

詳細UI:

より多いTracker-style Metrics。

Percentageだけでなく:

- Numerator
- Denominator
- Opportunity Count

を必ず保持します。

`2 / 3 = 66%` と `200 / 300 = 66%` を同じConfidenceで扱わないでください。

## 4. Evidence-backed User Profile

正本:
- Structured Evidence

派生:
- Natural Language Player Profile

Profileは以下から高頻度で再生成します。

- Recent Evidence
- Long-term Evidence
- Improvement
- Unresolved Hypothesis

過去の自然言語Summaryを再帰的に「真実」として積み重ねないでください。

## 5. Hypothesis Lifecycle

例:

- Suspected
- Supported
- Strong
- Improving
- Resolved
- Insufficient Data

Counter Evidenceによって弱くなる仕組みを持ちます。

## 6. Session Review

表示:

- Hands
- Duration
- 実額結果
- BB結果
- Decision Quality Summary
- Strength
- Leak
- Important Hands
- Confidence / Sample Caveat
- Recommended Drill

「負けたから下手」「勝ったから上手」としません。

## 7. Targeted Drill

```text
実際の問題Hand
 ↓
Underlying Concept抽出
 ↓
Analogous Spot生成
 ↓
一要素だけ変える
 ↓
新しい判断
 ↓
Review
```

同じカードを再提示して答えを暗記させるだけにしません。

例:
- River Bluff Catch
- Blind Defense
- Effective Stack変更
- Opponent Tendency変更
- Bet Size変更

## 8. Opponent Reading Training

Play中:

- HUDなし
- User Note
- Tag
- Optional Read Capture

Review時:

1. User Read
2. Heroが観察可能だったEvidence
3. 観察可能範囲のStats
4. AI Range / Opponent Assessment
5. Actual Revealは別枠

Hidden CPU PersonaをHero-facing Evidenceとして使わないでください。

## 9. HintとScore

Hint利用量を保存します。

将来、必要なら:

- Independent Decision
- Hint-assisted Decision
- Review-only Understanding

を区別できます。

ただしExact WeightはPlaytest前に固定しません。
