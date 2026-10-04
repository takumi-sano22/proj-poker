# Poker Research Pack

調査日: 2026-10-04  
対象: No-Limit Texas Hold'em（Cash / Single Table Tournament）

## 1. このResearch Packの位置づけ

この資料はアプリの「正解データ」そのものではありません。

関係は以下です。

```text
Research Pack
  ↓
採用済みProduct Requirements
  ↓
Architecture / Domain Rules
  ↓
Curated Runtime Knowledge Base
```

Research Packの内容が、採用済みの人間判断を上書きしてはいけません。

## 2. Knowledge Label

Knowledge Base化するときは、最低限以下を区別します。

| Label | 意味 | 例 |
|---|---|---|
| `RULE` | 正式ルール・裁定 | Oversized Chip、Minimum Raise |
| `FACT` | 定義・数学的事実 | Pot Odds、Equity |
| `THEORY_BASELINE` | 理論・均衡上の基準 | Solver Strategy、River Bluff Ratio |
| `HEURISTIC` | 条件付き経験則 | Rule of 4 and 2 |
| `EXPLOIT` | 観察した偏りへの調整 | Overcaller相手にBluffを減らす |
| `HOUSE_RULE` | 会場・Profile依存 | Straddle、Rake、Run It Twice |
| `UNCERTAIN` | 証拠・文脈不足 | 少数SampleからのPlayer Read |

この区別は、Review AIが「経験則」を「普遍的ルール」として断定することを防ぐために重要です。

## 3. 調査から得た重要結論

1. ライブ裁定は単一の普遍ルールではなく、Rule Profile / House Ruleとして扱う必要がある。
2. Decision Reviewと全手札開示後のReveal Reviewは分離する。
3. 勝率、Equity、Required Equity、EVは別概念として表示する。
4. Cash Rakeは戦略へ影響するため、分析Contextに明示する。
5. SolverにはCapability Boundaryが必要で、Local OSSはHeads-Up中心のものが多い。
6. Multiway SpotではSolverを無理に使わず、Math + Range + KB + Review AIへFallbackする。
7. Knowledge Baseへ移すときは、Format・人数・Stack・Rake・更新時点などSource Scopeを保持する。

## 4. 推奨学習モデル

### 通常Play

```text
Observe
 ↓
Decide
 ↓
Act
 ↓
Observe Result
```

### Hand Review

```text
判断時点のInformation Set再構築
 ↓
Math
 ↓
Range Analysis
 ↓
対応可能ならSolver
 ↓
Review AI
```

### Session Review

```text
Decision集計
 ↓
Repeated Leak抽出
 ↓
Evidence-backed Hypothesis
 ↓
Practice Recommendation
```

### Targeted Practice

```text
Past Mistake
 ↓
Underlying Skill
 ↓
Analogous Spot生成
 ↓
Re-test
```

## 5. Research Pack構成

- `01_rules_and_live_mechanics.md`
- `02_strategy_and_math.md`
- `03_review_and_learning.md`
- `04_tournament_and_icm.md`
- `05_solver_and_analysis.md`
- `06_knowledge_base_design.md`
- `SOURCES.md`

## 6. Requirementsへ反映すべき調査由来事項

- Rake設定
- StraddleをHouse Rule Optionとして扱う
- Heads-Up移行時のButton / SB動作
- Rule Profile Versioning
- Solver Capability Mismatch時のFallback
- Rabbit Huntingの扱い
- Play中のStrategy Toolと学習Hintの区別
- Position Nameは人数によってAliasが揺れるため、内部は相対Positionを正本にする
