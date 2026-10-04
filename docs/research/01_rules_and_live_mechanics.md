# ルールとライブ実卓操作

## 1. 基本ゲームフロー

No-Limit Texas Hold'emでは各Playerに2枚のHole Cardsが配られます。

Community Cards:

- Flop: 3枚
- Turn: 1枚
- River: 1枚

Betting Round:

- Preflop
- Flop
- Turn
- River

Showdownでは、利用可能なCardからBest Five-card Handを構成します。

全員をFoldさせてもPotを獲得できます。

## 2. Position / Action Order

通常:

- Buttonの左がSB
- さらに左がBB
- PreflopはBBの左側からAction開始
- PostflopはButtonの左側にいるLive PlayerからAction開始
- ButtonはHandごとにClockwiseへ移動

### Heads-Up

重要な例外:

- Button = Small Blind
- Button / SBがPreflop first to act
- Button / SBがPostflop last to act

3人以上からHeads-Upへ移行する際のBlind / Button処理はRegression Test対象にします。

## 3. Physical ActionとCanonical Action

UI上の操作とPoker Engineへ適用される正式Actionを分けます。

例:

```text
Facing Bet: 100
User: Raise宣言なしで500 Chipを1枚投入
 ↓
Oversized Chip Rule
 ↓
Dealer Ruling: CALL 100
 ↓
Poker Engine: CALL
 ↓
Change 400
```

この分離により「間違った実卓操作を経験できるが、Game Stateは壊れない」を実現します。

## 4. 宣言とChip

2026 Poker TDAを主要参照の一つとします。

重要ポイント:

- Bet / Raise / Call / Fold / Check / All-in等の明確な用語を使う
- Verbal DeclarationとChip投入のTimingが裁定へ影響する
- Raiseは明確な一動作、または事前の明確な宣言を基本とする
- String Bet / Raiseは認めない

これらはLLMではなくRuling Engineで扱います。

## 5. Oversized Chip

Facing a Betで、Raise宣言なしにSingle Oversized Chipを出した場合、TDA系Profileでは原則Call扱いになります。

例:

```text
Bet 100
Silent 500 Chip × 1
→ Call 100
```

Tutorial文章だけではなく、実操作として経験できるようにします。

## 6. Multiple Chips / 50% Rule

複数Chipを無言で出した場合は:

- Callに全Chipが必要か
- Minimum Raiseへ達するか
- Raise量のThresholdを超えるか

等で裁定が変わります。

Rule Table / Scenario Testとして決定論的に実装します。

## 7. Minimum Raise

No-LimitではRaise IncrementとTotal Betを混同しないことが重要です。

現在StreetのLargest Previous Full Bet / Raise等を基準に、Minimum Raiseを計算します。

## 8. Short All-in / Reopening

Full Raise未満のAll-inは、既にAction済みPlayerのBettingを必ずしもRe-openしません。

複数Short All-inの累積Caseもあるため、Scenario Testを厚くします。

## 9. Action Out Of Turn

Out-of-Turnは単純な「常に無効」ではありません。

Profileによって:

- 正しいPlayerへActionを戻す
- Intervening Actionが変化しなければBinding
- Actionが変化した場合はOptionが戻る
- OOT FoldはBinding

等の規則があります。

MVPで全Edge Caseを再現する必要はありませんが、Ruling Profileで拡張可能にします。

## 10. Showdown

Formal ShowdownとLearning Revealを分離します。

```text
Table-visible Showdown
≠
Learning-only Full Reveal
```

CPU Knowledge Stateへ入るのは、実際にそのCPUが観察できた前者だけです。

## 11. Burn / Dealing

Dealer UIでは必要に応じて:

- Shuffle
- Cut
- Hole Cards
- Burn + Flop
- Burn + Turn
- Burn + River

を表示します。

内部Randomnessの正しさをAnimation Timingへ依存させません。

## 12. Cash House Rule

Live Cashでは以下がHouse Rule依存です。

- Table Stakes
- Buy-in
- Reload
- Straddle
- Rake
- Run It Twice
- Rabbit Hunting

Core Hold'em RuleとHouse Ruleを分離します。

## 13. Feedback分類

### `RULING`

Game Actionへ影響する正式裁定。

### `ETIQUETTE`

進行・マナー。

### `COACHING`

戦略・初心者向け学習補助。

UIでもLogでも分類を維持します。
