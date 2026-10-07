# 学習とAnalytics設計

## 1. 原則

短期収支をPoker Skillと同一視しません。

主評価:
- その時点で利用可能な情報に基づくDecision Quality

補助評価:
- 実額収支
- BB収支
- 結果Variance

### Phase 6の前提（D102〜D105）

Phase 6（Session Learning。#105）は、次を前提に実装します。

- Event Logが正本で、Stats / Score / Profile / Hypothesisはすべて再計算できる派生Projectionです（D37・D102）。Projectionを保存してもCacheとして扱い、正本にしません（`docs/04` §12）。
- Score・Recent Windowなどの数値は、Version付きのPolicy / Configに置く暫定値です（OI-006）。Playtest後に変えられるようにし、永久仕様にしません。
- 判断の評価の入力は、Review Pass A（判断時点の情報だけ。`docs/05` §7）のVersion付きAssessmentです。Pass B（Learning-only Reveal）の情報をScore・Hypothesisの根拠に使いません。
- Hidden CPU PersonaとLearning-only Revealを、Hero向けのObservation Evidenceに使いません（§8）。

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

### Ability DimensionとScoringPolicyの契約（D103。数値はOI-006の暫定値）

Scoreは、Version付きの暫定式 `ScoringPolicy` で計算します。最初のVersionは `phase6_provisional_v1` です。Policyは次を持ち、Versionを変えれば同じEvidenceから計算し直せるようにします（Scoreには計算したPolicyのVersionを必ず残す）。

- Ability Dimensionの一覧（上の初期候補。Policyの中のVersion付きの一覧で、永久仕様にしない）
- Pass A Assessmentの点（暫定値）

  | Assessment | 点 |
  |---|---|
  | `strong` | 100 |
  | `reasonable` | 80 |
  | `mixed_marginal` | 60 |
  | `improvement_suggested` | 35 |
  | `major_leak` | 0 |
  | `insufficient_evidence` | 集計から除外（0点として数えない） |

- Decision → Abilityの割り当てとWeight: 1つのDecisionは複数のAbilityに寄与できます。割り当てとWeightは決定論でVersion付き（LLMに決めさせない）。
- Confidenceの扱い: Confidenceは点数そのものを変えず、集計のWeightに使います（Weightの値は暫定値）。

ScoreはConfidence / Sample Size / Evidence IDs / Trendと必ず一緒に扱い、点数だけを見せません。Live MechanicsはPoker Decisionと別のScoreです（D48）。Drillの結果は通常PlayのAbility / Overall Scoreへ直接混ぜません（§7。D105）。

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

Stats Projection（D103）:

- Event Logから再計算する、**全Player対応**の汎用Projectionにします。Phase 6のUIはHeroを主対象にします。
- 同じEvent Logからは同じ結果になる決定論で作ります。
- 指標をSchemaへ固定で埋め込みすぎず、後から指標を足せる境界にします。
- Play中のHUDは足しません（D32）。Heroが他Playerの統計を見るのはReviewで、Heroが観察可能だった範囲に限ります（§8）。

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

Recent / Long-term（D104）:

| 区分 | 範囲 |
|---|---|
| Recent | 直近100の有効Decision（OI-006の暫定値。Configに置く） |
| Long-term | 全有効Evidence |

Structured Profileが正本で、自然言語のPlayer Profileはそこからの派生物です。古い自然言語Summaryを次の生成の正本にしません。

## 5. Hypothesis Lifecycle

例:

- Suspected
- Supported
- Strong
- Improving
- Resolved
- Insufficient Data

Counter Evidenceによって弱くなる仕組みを持ちます。

Weakness Hypothesis（D104）は、Supporting / Counter EvidenceをEvidence IDsで構造化して保存し、状態遷移を決定論で行います。LLMを状態遷移の正本にしません（説明文を書かせるのは可）。形は`docs/04` §7です。

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

Phase 6のDrill（D105）:

- 元のHand / Decision / Evidenceのprovenanceを持ちます。
- 基本の経路は、過去Handからの決定論的な変形（一要素だけ変える）です。
- LLMでSpotを生成する場合も、Poker EngineのValidation（合法なState・Action・Chipの保存）を必ず通します。
- Drillの判断もReviewしますが、結果は通常PlayのAbility / Overall Scoreと別の系列に持ち、直接混ぜません。

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

User Read / Note / Tag（D105）はPhase 6で実装します。

- 対象（Subject）の参照は、seat id（`cpu1`等）を永続Identityとみなさない形にし、Phase 7の永続`cpuProfileId`（D106）が入っても破綻しないようにします。
- User ReadはprovenanceつきでReviewのEvidence（User Read / Intent。`docs/05` §6）に入れます。
- Hidden Personaと照合して、読みの当たり外れをPlay中に見せません。Actual Revealとの比較はReview（Pass B）の別枠だけです。

## 9. HintとScore

Hint利用量を保存します。

将来、必要なら:

- Independent Decision
- Hint-assisted Decision
- Review-only Understanding

を区別できます。

ただしExact WeightはPlaytest前に固定しません。
