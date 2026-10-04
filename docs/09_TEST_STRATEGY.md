# テスト戦略

## 1. 優先順位

最優先は**決定論的なPoker Engineの正しさ**です。

AIの戦略は多少不完全でもよいですが:

- Chip Accounting
- Legal Action
- Pot Distribution
- Hidden Information Isolation

は壊れてはいけません。

## 2. Poker Engine Unit Test

最低限:

- Hand Ranking
- Tie
- Deck Uniqueness
- Deal
- Blind / Ante
- Action Order
- Fold / Check / Call / Bet / Raise
- Minimum Raise
- All-in
- Short All-in
- Reopening
- Side Pot
- Split Pot
- Button Movement
- Heads-Up

## 3. Invariant Test

### INV-TEST-001

同じCardが同時に二か所へ存在しない。

### INV-TEST-002

Rake / Rebuy / Top-up等の明示操作を除き、Chip総量が勝手に増減しない。

### INV-TEST-003

FoldしたPlayerへ同Hand中に再度Actionを要求しない。

### INV-TEST-004

Playerは自分のStackを超えてChipをCommitできない。

### INV-TEST-005

配分されたPot総額 = Rake等控除後のDistributable Pot。

### INV-TEST-006

合法なActorだけがCanonical Actionを実行できる。

### INV-TEST-007

Opponent KnowledgeStateに他PlayerのHidden Cardsが含まれない。

### INV-TEST-008

Learning-only RevealがCPU Memoryへ入らない。

## 4. Scenario Regression

固定Scenario:

- Standard Heads-Up
- Standard 6-max
- Multiway All-in
- 3-way Side Pot
- Short All-inでReopenしないCase
- 累積Short Raise
- Odd Chip Split
- Heads-Up移行
- Oversized Chip
- String Raise
- Representative Out-of-Turn

## 5. AI Opponent Eval

Poker Engine Correctnessとは別に評価します。

測定:

- Structured Output Valid率
- Illegal Action率
- Retry率
- Latency
- Persona Differentiation
- Action Diversity
- 明らかなStrategic Incoherence
- Hidden Information Leakage

代表Spotを固定Regression Caseとして持ちます。

## 6. Review Eval

確認:

- Pass AにHindsight Leakがない
- Mathが正しい
- Solver Capability Gateが動く
- KB / Source Grounding
- Uncertaintyの表現
- Hidden CPU SettingをEvidenceに使わない
- Assumption変更でRecommendationが適切に変わる

Human-reviewed HandをRegression Caseにします。

## 7. Solver Adapter Test

- Capability Detection
- Supported Spot
- Unsupported Spot
- Timeout
- Cancellation
- Invalid Input
- Parse Failure
- Version Metadata
- Range Assumption保持

## 8. Critical E2E

1. 6-max Cash開始
2. Handを最後までPlay
3. Chip / Declaration操作
4. Hand終了
5. Reviewを開く
6. 全Hand Reveal
7. Replay
8. Follow-up質問
9. 次Hand開始
10. Hand間でアプリ再起動しSession再開

## 9. Property / Fuzz

有効な用途:

- Random Legal Action Sequence
- Side Pot / Chip Conservation
- Random Stack
- Random Player Count
- Deck Uniqueness

Fuzz Testだけで明示的Rule Scenarioを置き換えないでください。
