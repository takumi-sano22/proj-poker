# TournamentとICM

## 1. 初期Tournament Scope

最初のTournamentはSingle Table Tournamentに限定します。

- 2〜8人
- Blind上昇
- Optional Ante / Big Blind Ante
- Elimination
- Heads-Up
- Payout
- ICM

Multi Table Tournamentは初期Scope外です。

## 2. Chip EVとPrize Equity

CashではChip Valueは概ねLinearです。
ただしRake等の影響は別途考慮します。

Tournamentでは:

- ChipをそのままCash Outできない
- Payout Structureがある
- 同じChip増減でもPrize EVへの影響が対称ではない

ICM（Independent Chip Model）は、Stack DistributionとPayoutからTournament Equityを推定するModelです。

## 3. ICMが重要なSpot

特に:

- Bubble
- Large Pay Jump
- Final Table
- Satellite Bubble

で影響が大きくなります。

Reviewでは:

- Chip EV
- ICM / Prize EV

を分離して表示します。

例:

> Chip EVではCall寄りだが、ICMではFold寄り

という説明を可能にします。

## 4. ICMの限界

ICMは以下を直接すべてModel化するものではありません。

- Player Skill
- Future Position
- Future Edge
- Table Dynamics

Review AIはICM Resultを絶対的な唯一の正解として説明せず、InputとScopeを明示します。

## 5. Tournament Engine State

必要なState:

- Blind Level
- Level Progression
- Ante Type
- Payout
- Remaining Players
- Stack Distribution
- Elimination Order
- Button Movement
- Heads-Up Transition

Blind Level Progression:

- Time-based
- Hand-count-based

両方に対応します。

## 6. Heads-Up Transition

Regression Test必須:

- Button = SB
- Button/SBはPreflop first to act
- Button/SBはPostflop last to act
- 3人以上からHeads-Upへ移行した際にBlind / Buttonが不正にならない

## 7. Preset

将来の標準Preset候補:

### Standard

標準的なStack / Level。

### Deep

Deep Stack + Slow Blind。

### Turbo

Shallow / Fast Level。

具体数値はRequirementsやPlaytestで決定し、このResearch Packでは固定しません。
