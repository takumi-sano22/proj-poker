# Reviewと学習モデル

## 1. 中心価値

目的は「結果を当てること」ではありません。

**限られた情報から再現可能な判断プロセスを身につけること**を中心にします。

短期収支にはVarianceが大きいため、Winning HandだったかだけではDecision Qualityを測れません。

## 2. Two-pass Hand Review

### Pass A — Decision Review

利用可能:

- Hero Hole Cards
- その時点までに公開されたBoard
- Pot / Stack / Position
- Public Action
- Heroが当時持っていたNote
- Heroが実際に観察したShowdown / History
- 観察可能なEvidenceから作ったOpponent Model

利用禁止:

- Fold済みCPU Hole Cards
- Future Board
- CPU Secret Persona
- Review-only User Profile
- 他CPUだけが知っている情報

出力:

- Assessment
- Confidence
- Alternative Actions
- Key Factors
- Range Assumption
- Math Evidence
- Solver Evidence

### Pass B — Reveal Review

Hand終了後のみ:

- 全Player Hole Cards
- Actual Hand Equity
- Bluff / Valueの答え合わせ
- Hero Readとの比較

Actual Cardを理由にPass Aを自動変更しません。

## 3. Review Interview

ログだけで評価が揺れる場合、Review AIからUserへ質問します。

例:

- 当時VillainをValue-heavyと見ていたか
- Bluff候補を何と考えたか
- Bet Sizeの目的は何だったか
- Pot OddsでCallしたのか、Player Readだったのか

回答は `UserDecisionContext` として保存します。

すべてのHandで質問しません。

## 4. Hand Review UI

初期:

1. 全体Summary
2. Important Spot
3. Good Decision
4. Improvement Candidate

詳細:

- Timeline
- Replay
- Per-action Review
- Range View
- Math
- Solver
- Reveal
- Chat

Replayは保存Eventの再生であり、Re-simulationとは別です。

## 5. Evaluation Category

各Action:

- Strong
- Reasonable
- Mixed / Marginal
- Improvement Suggested
- Major Leak
- Insufficient Evidence

Session:

- Preflop
- Postflop
- Bet Sizing
- Pot / Equity Math
- Range Reading
- Opponent Adaptation
- Position
- Live Mechanics

ScoreにはConfidence / Sample Sizeを併記します。

## 6. Evidence Model

弱点を永久Labelにしません。

例:

```yaml
hypothesis: river_bluff_catch_overcall
supporting_hands:
  - hand_122
  - hand_147
counter_evidence:
  - hand_231
sample_size: 6
confidence: medium
status: improving
```

AI Player ProfileはこのEvidence Layerから再生成します。

## 7. Session Review

最低限:

- Hands Played
- 実額Result
- BB Result
- Decision Quality Summary
- Positive Pattern
- Key Leak
- Confidence
- Evidence Hand
- Recommended Practice

収支を主評価にしません。

## 8. Statistics

内部には詳細Eventを保存し、UIではProgressive Disclosureします。

通常:

- VPIP
- PFR
- 3-bet
- Aggression系
- Showdown系
- Position別
- Street別

詳細:

- より多くのTracker-style Stats

`2/3 = 66%` を大量Sampleと同じConfidenceで扱いません。

## 9. Opponent Reading Review

Play中:
- HUDなし
- Free Note
- Hypothesis Tag
- Optional Read Capture

Review:

1. User Read
2. Heroが観察可能だった実データ
3. AI Range / Opponent Assessment
4. Actual Revealは別Pass

「Aggressiveだと思った」が、Observed VPIP/PFRから見るとLoose-passiveだった、というように**人読みそのもの**をレビューします。

## 10. Targeted Drill

```text
Bad / Uncertain Spot
 ↓
Underlying Concept
 ↓
Structurally Similar Scenario
 ↓
One Factor Variation
 ↓
New Decision
 ↓
Review
```

同じHandを暗記させません。

## 11. Play中のHint

学習モードのみ。

Layer:

1. 着眼点
2. Math
3. Range
4. Candidate Comparison
5. Recommendation

Hint使用履歴を保存します。

## 12. Review Versioning

保存:

- Review Version
- Model Role / Version
- KB Version
- Solver Adapter / Version
- Assumptions
- Calculated Metrics
- Assessment
- Explanation

過去Reviewは上書きしません。
