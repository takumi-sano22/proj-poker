# ドメインルールとポリシー

## 1. 最重要Invariant

**ポーカーのルール・Game Stateは決定論的コードで処理し、LLMへ裁定させません。**

Poker Engineが担当:
- Deck / Deal
- Hand Ranking
- Button / Position
- Blind / Ante
- Legal Action
- Minimum Raise
- Short All-in / Reopening
- Side Pot
- Split Pot
- Showdown
- Winner / Chip Movement

## 2. Information Boundary

### INV-INFO-001

global `GameState` をOpponent Modelへ直接渡してはいけません。

各Player専用の `KnowledgeState` を構築します。

渡してよい情報:
- 自分のHole Cards
- 公開済みBoard
- Public Action
- Pot / Stack / Position
- 自分が観察したShowdown
- 自分が過去に取得したObservation
- 自分自身のPersona / State

渡してはいけない情報:
- 他人の非公開Hole Cards
- Fold済みCard
- 未来のDeck
- Learning-only Reveal
- HeroのWeakness DB
- 他CPUのPrivate Memory
- 他CPUのSecret Persona

### INV-INFO-002

Learning-only RevealはReview用Privilegeであり、ゲーム世界内のObservationではありません。

### INV-INFO-003

CPU ObservationはProvenanceを保持します。

最低限:
- Observer
- Subject
- Source Hand / Event
- Visibility
- Timestamp / Hand Number

## 3. Rule Profile

ライブルールはHouseやTournament/Cashによって異なるため、Version付きProfileとして管理します。

初期候補:
- `tournament_tda_2026_v1`
- `live_cash_training_v1`

Profile対象:
- Oversized Chip
- Multiple Chip
- Minimum Raise
- Short All-in / Reopen
- Button Movement（Bust した席の扱い・Dead Button の有無）
- Out of Turn
- Showdown Order
- Straddle
- Run It Twice
- Rabbit Hunting
- Rake
- Buy-in / Reload

一つのProfileを「世界共通の唯一のルール」として扱わないでください。

## 4. Physical Action と Canonical Action

UI操作とゲーム上の正式Actionを分離します。

```ts
type PhysicalAction =
  | ChipPush
  | ChipAdd
  | Declare
  | CardMuckAttempt
  | ShowCards
  | OutOfTurnAttempt;

type CanonicalAction =
  | Fold
  | Check
  | Call
  | Bet
  | Raise
  | AllIn;
```

例:

相手Bet 100に対して、Raise宣言なしで500Chipを1枚出す。

```text
PhysicalAction: Push 500
  ↓
Oversized Chip Rule
  ↓
Dealer Ruling: CALL 100
  ↓
Poker Engine: CALL
```

## 5. 必須Scenario Test

最低限:
- Minimum RaiseのTotalとIncrement
- Short All-in
- 累積Short All-in
- Action Reopening
- Multi Side Pot
- Odd Chip Split
- Heads-Up Button/SB
- 3人→Heads-Up移行
- Blind / Ante
- All-in Showdown
- Fold後のAction順
- Oversized Chip
- String Bet / Raise
- Representative Out-of-Turn

## 6. Cash Policy

Cash Config:
- SB / BB実額
- Buy-in / Starting Stack
- Chip Denomination
- Top-up
- Auto Top-up
- RakePolicy
- Optional Straddle

実額表示は常時必須です。

### RakePolicy

明示的に持ちます。

最低限:
- Rakeless Training
- Percentage + Cap型

Solver / ReviewがRakeを無視する場合、その制約をReviewへ表示します。

## 7. Tournament Policy

初期Tournament Scope:
- Single Table
- 2〜8人
- Blind / Ante
- Payout
- Elimination
- ICM Review

Heads-Up Invariant:
- Button = SB
- Button/SBはPreflop first to act
- Button/SBはPostflop last to act

## 8. Dealer Feedback分類

### RULING

Game Stateへ影響する正式裁定。

### ETIQUETTE

進行・マナーに関する指摘。

### COACHING

戦略・学習上の補助。

UIでもLogでも混同しないでください。

## 9. Replay と Re-simulation

### Replay

保存済みEventだけを再生します。

### Re-simulation

Decision Pointから別Actionを選んだ仮想分岐です。

Current AI / Solverを使う可能性があります。

ReplayをCurrent AIで再生成してはいけません。

## 10. Reproducibility

完全な再現はHard Requirementではありません。

保存候補:
- RNG Seed
- Deck Hash
- Model Request / Response
- Model Role / Version
- Rule Profile Version
- CPU Profile Version

ただし、LLMの完全決定論的再現のためにArchitectureを過剰複雑化しないでください。
