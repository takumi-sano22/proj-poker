# 戦略とPoker Math

## 1. Decisionを評価するContext

良いDecisionはHeroの2枚だけでは決まりません。

最低限考慮するもの:

- Hero Holding / Range
- Opponent Range
- Position
- Action History
- Board
- Pot
- Amount to Call
- Effective Stack
- SPR
- Bet Size
- Player Observation
- Rake / Payout Context

「AJoは強いからCall」のような単純評価を避けます。

## 2. Pot Odds

Call Costを `C`、Call後のFinal Potを `F` とすると:

```text
Required Equity = C / F
```

例:

- Bet前Pot = 100
- Villain Bet = 50
- Hero Call = 50
- Final Pot = 200

```text
50 / 200 = 25%
```

Review UIでは:

- Current Pot
- Call Amount
- Final Pot
- Required Equity

を分解して表示します。

## 3. Outs / Drawing Odds

Outsは、将来StreetでHandを改善し、勝ちにつながり得るUnseen Cardsです。

注意:

- Duplicate Outs
- Dirty Outs
- Domination
- Opponent Range

### Rule of 4 and 2

実卓暗算用 `HEURISTIC`:

- Flop→River概算: Outs × 4%
- 次の1 Street: Outs × 2%

アプリではExact Probabilityを計算できますが、Mental Shortcutとして教える価値があります。

## 4. Equity

区別:

### Hand vs Hand Equity

既知Holding同士。

### Hand vs Range Equity

Hero HoldingとVillain Range。

### Range vs Range Equity

両者のRange全体。

Decision ReviewではActual Villain Handより、**当時妥当だったRange**を優先します。

## 5. Expected Value

単純化したZero-equity River Bluff:

- Current Pot = `P`
- Bet = `B`
- Villain Fold Probability = `F`

```text
EV = F * P - (1 - F) * B
```

Break-even Fold Frequency:

```text
F = B / (P + B)
```

例:

- P = 100
- B = 50
- 必要Fold率 = 33.3%

重要:

- 必要Fold率 = 数学
- 「Villainが何%Foldするか」 = 推定

同じConfidenceで表示しません。

## 6. Implied / Reverse Implied Odds

Pot Oddsは現在のPriceだけを見ます。

Future Streetで:

- Hit後に追加Valueを取れる
- Hitしてもより強いHandに負ける

等を考えるのがImplied / Reverse Implied Oddsです。

Reviewで「Required Equityを上回ったから必ずCall」と単純化しません。

## 7. Effective Stack / SPR

Effective Stackは、当該Opponentとの間で実際にRiskできる小さい側のStackです。

```text
SPR = Effective Stack / Pot
```

MultiwayではOpponentごとにEffective Stackが異なる場合があります。

## 8. Position

Positionは情報量とEquity Realizationへ大きく影響します。

一般的なBaseline:

- Early PositionほどRangeは狭くなる
- Late Positionほど参加可能Rangeが広がる
- ButtonはPostflopで最後にActionできる

ただし「UTGは常に上位X%」のような数字は `RULE` ではありません。

Format / Stack / Rake / Open Size等で変わります。

## 9. Range Thinking

相手を1 Handに決め打ちしません。

```text
Prior Range
 ↓
Preflop Action
 ↓
Updated Range
 ↓
Flop Board / Action
 ↓
Updated Range
 ↓
Turn
 ↓
River
```

「実際KQだったからKQを読むべきだった」という結果論を禁止します。

## 10. Preflop

KB対象:

- RFI / Open Raise
- Limp
- Iso Raise
- Cold Call
- 3-bet
- 4-bet
- Squeeze
- Blind Defense
- Push / Fold

Context:

- Position
- Player Count
- Open Size
- Effective Stack
- Rake
- Ante
- Opponent Tendency

## 11. Rake

Cash Rakeが高いほどMarginalなPot参加EVは悪化します。

特に:

- Cold Call
- Blind Defense
- Small-edge Spot

へ影響します。

Cash PresetへRake Contextを持たせます。

## 12. Postflop Concept

KB対象:

- Range Advantage
- Nut Advantage
- Positional Advantage
- C-bet
- Value Bet
- Bluff
- Semi-bluff
- Blocker / Unblocker
- Bet Size

「Preflop Aggressorだから常にC-bet」のようなif文へ固定しません。

## 13. Exploit

基本:

```text
Baseline
 ↓
Observable Evidence
 ↓
Opponent Hypothesis
 ↓
Confidence
 ↓
Adjustment
```

例:

- Callしすぎる証拠 → Valueを広げ、Bluffを減らす候補
- Foldしすぎる証拠 → Bluff拡大候補
- 3-betが極端にTight → Opening / Defense調整候補

CPU Secret Personaを根拠にしません。

## 14. Multiway

MultiwayはHeads-Upと同じ助言をそのまま流用できません。

一般に:

- Bluff Successが下がる
- Range Interactionが増える
- Equity Realizationが変わる
- Effective Stackが複数
- Solver Complexityが上がる

`player_count` をFirst-class Parameterにします。

## 15. Tilt / Human Error

CPUの人間らしい非合理性はState-conditionedにします。

Trigger例:

- Big Pot Loss
- Repeated Loss
- Failed Bluff
- Overconfidence

一部Personaのみ低確率で:

- Wider Participation
- Excessive Aggression
- Chasing
- Overcalling
- Scared Overfold

へ偏ります。

無条件Random Bad Playにはしません。
