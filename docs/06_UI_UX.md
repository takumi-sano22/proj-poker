# UI / UX仕様

## 1. Table UI

方向性:
- ライブ卓寄りの2D Table
- Casinoゲーム的な演出より、学習しやすい読みやすさを優先
- 2〜8人でResponsiveにSeat配置
- Heroは可能なら画面下側に固定

表示:

- Seat / Name / Lightweight Avatar
- Stack実額
- Optional BB換算
- Dealer Button
- SB / BB
- Community Cards
- Pot
- Hero Hole Cards
- Current Turn

## 2. 実額表示は必須

BBだけを表示してはいけません。

例:

```text
Pot: 37
18.5 BB
```

上段の実額が正本で、BBは補助です。

## 3. Card / Chip Asset

Card / Chipは構造描画します。

- SVG
- CSS
- Component

要件:
- Scale可能
- 52枚で統一
- State切替容易
- 高解像度
- Theme変更可能

画像生成向き:
- Felt
- Table Rail
- Card Back
- App Icon
- Decorative Asset

52枚のCardを別々のRaster画像として生成しないでください。

## 4. Chip Interaction

対応:

- Chip Click
- 枚数選択
- Drag
- Betting Areaへの投入
- Stack Composition表示
- Dealer Change

Chip操作は `PhysicalAction` を生成します。

Stack Composition表示（#62）: 席のStackとBetを、額から自動で組んだChipの構成（額面ごとの色付きの積み。額面は1白・5赤・25緑・100黒・500紫の暫定値。D92・OI-004）で描きます。実額が正本で、積みは補助です（D49）。多い枚数は重ねる数に上限を置き、枚数（×N）で示します。Click・Drag・Betting Areaへの投入は#65で扱います。

Primary Numeric Bet Boxは作りません。

## 5. Declaration UI

Buttonによって口頭宣言の代替を行います。

ただし、毎回Declarationを強制しません。

目的は「宣言しなかったため裁定が変わる」という実卓操作も練習することです。

Voice RecognitionはScope外です。

## 6. Dealer Feedback

### RULING

Canonical Actionへ影響する裁定。

例:

> 宣言なしで500Chipを1枚出したため、このRule ProfileではCallとして扱います。

### ETIQUETTE

進行・マナーの指摘。

### COACHING

戦略・学習上の助言。

同じWarningとして混ぜないでください。

## 7. 用語表示

基本は:

**日本語説明 + 標準Poker Term**

例:

- ボタン（BTN）
- 有効スタック（Effective Stack）
- ポットオッズ（Pot Odds）
- 3ベット（3-bet）
- 継続ベット（C-bet）

実際に概念が発生した場面では標準用語を積極的に表示します。

Hover / Clickで:

- Definition
- Current Hand Example
- Related Concept
- Advanced Detail

を見られるようにします。

## 8. Hero Fold後

標準:
- 観戦継続

Option:
- Fast Forward

Handが終わるまではLearning-only Hidden Cardsを見せません。

## 9. Hint UI

標準では非表示。

段階:

1. 着眼点
2. 計算
3. Range / 相手読み
4. 選択肢比較
5. 推奨

開いたLayerをLogします。

## 10. Review UI

初期表示:

- Summary
- Important Spots
- Good Decisions
- Improvement Opportunities
- Full Hand Reveal Entry

Spot Detail:

- Table State
- Action Timeline
- 当時のUser Read
- Math
- Range
- Solver Evidence
- Alternative Actions
- AI Explanation
- Follow-up Chat

Replay:

- Previous
- Next
- Play / Pause
- Jump to Important Spot

## 11. CPU待ち時間

通常:

> Kenの手番...

長時間だけ:

> AI応答が遅延しています

のような技術状態を補足します。

通常Play中に「Claude APIをCall中」などの内部実装を前面表示しません。

## 12. AI障害

選択肢:

- Retry
- Emergency Botで続行
- Session終了 / Pause

Emergency Bot利用は記録し、後のOpponent Quality分析で通常Handと混同しません。

## 13. MVP設定

- Table Size
- Cash Preset
- Animation Speed
- BB補助表示
- Auto Top-up
- Rule Profile
- Rake Profile
- Model Role Mapping
- Learning / Real-Play Mode
