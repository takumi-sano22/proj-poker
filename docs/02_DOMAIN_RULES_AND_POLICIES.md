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

### 現在のPreset: `phase4_provisional_v1`（OI-008の暫定値。永久仕様ではない）

`packages/engine/src/table-config.ts` の `PHASE1_CASH_PRESET`。#63でRulingの規則（`TableConfig.ruling`）を足したので、IDを `phase1_provisional_v0` から上げました（IDは `HAND_STARTED` の `ruleProfile` に残ります。Eventの項目は増やしていません）。Rulingの規則はすべてTDA（`docs/research/01` §4〜§9）に沿った暫定値です。

| 項目 | 設定値 | 規則 |
|---|---|---|
| Odd Chip | `oddChipRule: first_left_of_button` | Buttonの左から時計回りで最初の勝者へ1 Chipずつ（D75） |
| Short All-in / Reopen | `reopenRule: cumulative_full_raise` | 行動済みのPlayerには、最後に行動した時点からの上乗せの合計が直近のFull Raise幅以上で再開（D79） |
| Button Movement | `buttonRule: simple_moving` | Bustした席を飛ばし、Dead Buttonは使わない（D80） |
| Oversized Chip | `ruling.oversizedChip: call_unless_raise_declared` | 相手のBetに対し、宣言なしでCall額を超えるChipを1枚出したらCall。相手のBetが無ければそのChipの額のBet（最小Bet未満なら最小Bet）（D91） |
| String Bet / Raise | `ruling.stringBet: first_motion_only` | 宣言なしで複数回に分けて出したら、最初の1回の量で裁定し、2回目以降はHeroへ返す（D91） |
| Multiple Chip | `ruling.multipleChip: tda_every_chip_and_half_raise` | 宣言なしの複数枚（1回）。相手のBetがあり全部のChipがCallに要る（どの1枚を除いてもCall額に足りない）ならCall。そうでなければ上乗せ（出した後の額−最高額）が直近のFull Raise幅以上で出した額のRaise、50%以上で最小Raiseまで足させる、50%未満でCall（BBのOptionではCheck）。誰もBetしていなければ出した額のBet（最小Bet未満なら最小Bet）。Call額に満たないChipはCall（足させる） |
| 宣言（Declare） | `ruling.declaration: declaration_first_nearest_legal` | 宣言とChipは先にした方がActionを決める（Chipの後の宣言は採らない）。宣言が2つ以上なら最初の宣言が拘束する。額は合法な最も近いActionに寄せる: 最小額未満→最小Bet / 最小Raise、Stack以上→All-in、Raiseできない局面（再開していない・相手が全員All-in）のRaise / All-in→Call、BetとRaiseの言い違いは同じ意図、Call額0のCall→Check。相手のBetがあるときのCheckは採らず、Actionを決めないでHeroに選び直させる。額なしのBet / Raiseは最初の1回のChip（最初の1回がちょうどCall額なら続く1回まで）の額で決め、最小額に満たなければ最小額まで足させる。出したChipは、このStreetですでにHeroの前にある額（Blind・前のBet）に足す |
| Out of Turn | `ruling.outOfTurn: bind_unless_action_changes` | 手番を正しいPlayerへ戻して警告し、OOTの操作を保留する。Heroの手番が来た時点で、同じStreetの最高額がOOTの時点から変わっていなければ（間のPlayerがCheck・Call・Foldだけ）保留した操作を拘束として裁定し、変わっていれば（Bet・Raise・最高額を上げるAll-in、またはStreetが進んだ）撤回してHeroに選び直させる（D91） |

TDAとの差（暫定値として扱う。確定はOI-008の人間判断で行う）:

- TDAは「OOTのFoldは状況が変わっても拘束」とするが、D91は「変われば撤回できる」なので、この版ではFoldも撤回できる。
- TDAのUndercall（Call額に満たないChip）は、Heads-Upと最初のBetへのCallでは全額のCall、それ以外のMultiwayはFloorの判断。この版は一律に全額のCallとする。
- TDAの「前のBetのChipが卓に残っているときのOversized Chip」の細則は持たず、出したChipは前のBetに足す一律の扱いにする。

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

実装（#63。`packages/engine/src/ruling.ts`）: Ruling Engineは純粋関数で、`rulePhysicalActions(state, playerId, actions, config)` がHeroの1回の手番の操作（した順の `PhysicalAction` の列）を、Rule Profileの規則（§3の表）で裁定します。結果は `action`（Canonical Action。必ずLegal Actionのどれかで、そのまま `applyAction` に渡せる。D40）・`out_of_turn`（手番でない操作を保留した）・`no_action`（相手のBetがあるときのCheckの宣言・撤回したOOT。Heroが選び直す）のどれかと、裁定の理由（`RulingCode`。Dealer FeedbackのRULINGの材料。§8）です。保留したOOTは、Heroの手番で `resolveOutOfTurn(state, pending, config)` が拘束か撤回かを決めます。物理的な誤操作をするのはHeroだけで、CPUはCanonical Actionを直接出します（D91）。

- 実装した `PhysicalAction` は `chip_push`（Chipの最初の動作）・`chip_add`（2回目以降の動作）・`declare`（宣言。bet / raiseの額はこのStreetの累計〔to額〕で、省略可）の3種です。Chipは額面（Table Configの `chipDenominations`。D92）の列で持ち、Oversized Chip・Multiple Chipの判定に使います。
- `OutOfTurnAttempt` は操作の種類として持たず、手番でないときの操作をRuling Engineが判定します。`CardMuckAttempt` / `ShowCards` はPhase 4のRuling（D91の3種）の範囲外で、まだ持ちません。
- 裁定そのものはStateもEventも作りません。宣言・物理的な操作・裁定をEvent Logに残すのは `hand-engine.ts` の `applyPhysicalActions`（操作ごとに `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION`、続けて `DEALER_RULING`、Actionが決まればその `ACTION_TAKEN`）と `resolvePendingOutOfTurn`（保留したOOTの拘束・撤回の `DEALER_RULING`）です（#64・D90）。保留したOOTはEventの並びから復元でき（Stateの `pendingOutOfTurn`）、保留中の2回目の操作と、Canonical Actionでの上書きは受け付けません。Eventの形は `docs/04` §3。

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
