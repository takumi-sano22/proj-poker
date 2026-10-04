# Knowledge Base設計

## 1. Directory案

```text
knowledge/
├── rules/
│   ├── holdem-core
│   ├── betting-rulings
│   ├── live-cash
│   ├── tournament
│   └── etiquette
├── math/
│   ├── pot-odds
│   ├── outs-equity
│   ├── ev
│   ├── implied-odds
│   └── spr-effective-stack
├── preflop/
│   ├── position
│   ├── open-raise
│   ├── 3bet-4bet
│   └── blind-defense
├── postflop/
│   ├── range-thinking
│   ├── range-nut-advantage
│   ├── cbet
│   ├── value-betting
│   ├── bluffing
│   └── bet-sizing
├── exploit/
│   ├── player-types
│   ├── evidence-and-sample
│   └── common-leaks
├── tournament/
│   ├── stack-depth
│   ├── icm
│   └── bubble
└── glossary/
```

## 2. Metadata

各Knowledge UnitにContext Metadataを持たせます。

例:

```yaml
id: pot_odds_basic
type: FACT
game: NLHE
formats: [cash, tournament]
players: [2,3,4,5,6,7,8]
streets: [flop, turn, river]
source_quality: high
sources:
  - ...
reviewed_at: 2026-10-04
```

Strategy Heuristicではさらに:

- Conditions
- Caveats
- Rake
- Player Count
- Stack
- Position

等を持たせます。

## 3. Source Hierarchy

### Tier 1

- Poker TDA
- Formal Venue / Operator Rule
- Peer-reviewed / Game Theory Research
- Solver Official Documentation

### Tier 2

- Established Strategy Education
- PokerStars Learn
- Upswing Poker
- GTO Wizard Technical / Educational Material

### Tier 3

- Community Discussion
- Forum
- Reddit等

Tier 3は:

- Terminology Discovery
- Common Confusion
- Real Player Experience

には有用ですが、重要な採点根拠のPrimary Sourceにはしません。

## 4. Retrieval

MVPではVector DBを必須にしません。

開始案:

1. Metadata Filtering
2. Topic / Keyword Index
3. Full-text Search
4. Relevant ChunkだけReview AIへ渡す

KBが大きくなってからEmbedding / Vector Searchを検討します。

## 5. Web Fallback Gate

```text
Local KB
 ↓
Math / Solver
 ↓
Evidence Sufficiency
 ├─ Enough → Answer
 └─ Insufficient → Web Search
```

Web Search Trigger:

- 未登録用語
- House-specific Rule
- Strategy ConceptのCoverage不足
- Current Solver / Tool Behavior
- Source Conflict

Web Evidenceに保持:

- Source
- Publication / Update Date
- Context
- Confidence

## 6. Conflict Handling

例:

- 教材A: C-bet High Frequency
- Solver: Current BoardではMostly Check

これは必ずしも矛盾ではありません。

教材AがGeneral Heuristic、SolverがSpecific Contextかもしれません。

優先の考え方:

```text
Formal Rule
  >
該当House Rule

Specific Calculation
  >
Rough Heuristic

Supported Solver Spot
  >
Generic GTO Heuristic

Strong Observed Evidence
  >
Population-level Exploit Heuristic
```

ただしSolverもInput Range / Tree Assumptionに依存します。

Assumptionを必ず保存します。

## 7. Vocabulary UI

Default:

- 日本語説明
- Standard Poker Term

例:

- ボタン（BTN）
- 有効スタック（Effective Stack）
- ポットオッズ（Pot Odds）

Detail:

- Definition
- Current Hand Example
- Related Concept
- Advanced Explanation

専門用語を隠すのではなく、意味を理解しながら実戦用語へ慣れることを目的にします。
