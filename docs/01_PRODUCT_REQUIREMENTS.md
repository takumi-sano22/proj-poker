# プロダクト要件

## 1. プロダクト目標

ローカル・Single UserのNLHE練習アプリを構築します。

以下を一つの学習環境に統合します。

- 2〜8人のライブ卓風ポーカー
- AI CPUプレイヤー
- 実チップを意識した操作・宣言練習
- 根拠ベースのHand Review
- Solver / Poker Math
- 長期的な傾向分析
- 弱点別Targeted Drill

主な学習目標:

1. 不完全情報の中で妥当な意思決定をする
2. 標準的なポーカー用語・考え方を理解する
3. 実卓のチップ操作・宣言に慣れる
4. 相手のRange・傾向を読む
5. Bluff / Value / Foldの価値を理解する
6. 結果ではなくDecision Qualityから上達する

## 2. ゲームモード

### 学習モード（Learning Mode）

- プレイ中に任意でHintを開ける
- Hand終了後にReviewできる
- 全Hole Cardsを学習用に開示できる

### 実戦モード（Real-Play Mode）

- Hand中の戦略Hintを抑える
- 学習用Reveal/ReviewをSession終了後などに回せる
- ルール裁定・操作ミスの指摘は行う

## 3. ゲームスコープ

### FR-GAME-001 — ゲーム形式

No-Limit Texas Hold'emを扱います。

### FR-GAME-002 — 卓人数

Heroを含めて2〜8人。

### FR-GAME-003 — Cash

Cashを標準練習モードとします。

要件:
- 複数の実額Preset
- **実額は常に表示**
- BB換算は補助表示としてON/OFF可能
- StackはHand間で持ち越す
- Reload / Top-up
- Auto Top-up設定
- 明示的な `RakePolicy`
- House Ruleをversioned profileで管理

### FR-GAME-004 — Tournament

MVP後の正式スコープ:

- Single Table Tournament
- 2〜8人
- Blind上昇
- Ante / Big Blind Ante
- 脱落
- Heads-Up
- Payout
- ICM Review
- 複数Preset + Custom
- 時間Base / Hand数BaseのBlind Level

## 4. AI CPU

### FR-CPU-001 — モデル

初期値:
- `opponent_fast` = Haiku級

具体モデル名は設定で差し替え可能にします。

### FR-CPU-002 — 卓編成

通常は自動編成。

追加でBroadな卓傾向を選択可能にします。

例:
- Aggressive多め
- Calling-heavy
- Tight
- Mixed

### FR-CPU-003 — 実力分布

基本:
- 大半はカジュアル経験者以上
- 少数の弱いCPUも混ざる

弱いCPUは「ランダムで意味不明な悪手」を打つのではなく、一貫したLeakを持ちます。

### FR-CPU-004 — Personality

多軸Parameterを持ちます。

例:
- Skill
- Preflop Looseness
- Aggression
- Bluff Tendency
- Risk Tolerance
- Discipline
- Adaptability
- Trap Tendency
- Opponent Reading Quality
- Tilt Susceptibility
- Recovery Speed

### FR-CPU-005 — 人間的な非合理行動

Tilt等の条件成立時のみ、一部Personaは低確率でStrategically PoorなActionにも確率を割り当てます。

無条件のRandom Errorにはしません。

### FR-CPU-006 — 継続CPU

- 固定CPU Pool
- 一部Guest

再登場CPUは、自分が以前観察できた情報だけを保持します。

### FR-CPU-007 — CPU同士の記憶

CPU同士も、実際に同卓して観察したShowdown / Actionについてのみ長期記憶を持てます。

## 5. ライブ実卓操作

### FR-LIVE-001 — 卓表示

実卓寄りの2D UI。

### FR-LIVE-002 — Chip

Betは数値入力ではなく、Chip選択を主とします。

- Click
- Drag
- 枚数選択
- DealerによるChange / Color-up / Stack整理

### FR-LIVE-003 — 宣言

以下の宣言Buttonを利用可能にします。

- CHECK
- CALL
- BET
- RAISE
- ALL-IN
- FOLD

Voice RecognitionはScope外です。

### FR-LIVE-004 — Physical Action

誤操作も可能な限り受け付けます。

```text
PhysicalAction
  ↓
Ruling Engine
  ↓
Dealer Ruling
  ↓
Canonical Poker Action
```

「間違いをできなくする」のではなく「実際に間違えて裁定される」ことで学習します。

### FR-LIVE-005 — Dealer

Dealerの責務:
- Shuffle / Deal演出
- Burn / Flop / Turn / River
- Blind / Ante
- Action順
- Pot / Chip移動
- Ruling
- Etiquette
- 初心者向け用語補助

速度（D140。旧記述の Real Table / Normal / Fast の3段を置き換えた。#216）:
- 表示演出の速度は 標準 / 高速 / 超高速 / 演出なし の4段階、Skip 可。Event の表示順序を保ち、Showdown の公開札・勝者・Pot の配分は省かない（省くのは動きだけ）
- Fast Forward（Hero Fold 後の CPU の待ちの短縮。D93）とは別の契約

### FR-UX-001 — App Shell・演出・効果音（Post-Phase8。#215・D135〜D142）

- 画面は Home / Play / Learn の3領域。起動時は Home で、Home は Hand を進めない読み取り専用の照会だけを使う（D136）
- モダン・カジノの世界観で、読みやすさと正確性を守った上で強めの演出を許す（D135）
- PC は中央卓・右の情報パネル・下部の Hero 操作、スマホは折りたためる Hero 操作パネル（D137）。Chip の Click / Drag を保ち視認性を上げる（D138）。未確定の下書きは同じ Hand で有効な間は保持する（D139）
- 効果音（Card / Chip / Street / 勝利）を足し、BGM は入れない（D141）。RULING → ETIQUETTE の確認 → 再開（D142）
- 詳細は `docs/06` §16、可逆な値と技術検証は OI-012

### FR-LIVE-006 — Live Mechanics Score

戦略Skillとは別に評価します。

## 6. Hint

### FR-HINT-001

学習モードでユーザーが任意に開きます。

### FR-HINT-002

段階表示:

1. 着眼点
2. Math
3. Range / Opponent Consideration
4. Candidate比較
5. Recommendation

Hint使用履歴を保存します。

## 7. Hand Review

### FR-REVIEW-001 — Review開始

Hand全体が終了した後に開けます。

### FR-REVIEW-002 — 標準表示

1. 短い総評
2. 重要な判断
3. 良かった判断
4. 改善候補
5. 詳細展開

### FR-REVIEW-003 — Replay

Action単位で一手ずつ再生可能。

Replayは保存済みEventを再生するものであり、Re-simulationとは別です。

### FR-REVIEW-004 — Decision Review

判断時点でHeroが知り得た情報だけを使います。

### FR-REVIEW-005 — Reveal Review

Decision Reviewの後に、学習用に全Hole Cardsを確認できます。

この情報は:
- Decision Reviewへ逆流させない
- CPUのKnowledgeへ入れない

### FR-REVIEW-006 — 代替Action

重要なSpotではFold / Call / Raise等を比較します。

### FR-REVIEW-007 — Range

標準Range推定を出し、結論が揺れる場合は別仮定も比較します。

### FR-REVIEW-008 — Review Interview

Heroが当時どう読んでいたかで評価が変わる場合、Review AIが追加質問できます。

### FR-REVIEW-009 — 追加質問

Review結果へ対話的に質問可能。

### FR-REVIEW-010 — Version

Reviewは上書きせず、Version付きで保存します。

## 8. Opponent Reading

- CPUごとの自由記述Note
- Tag
- 重要Spotで当時のReadを任意記録
- Play中はHUDなし
- Reviewで「Heroが観察可能だったデータ」だけを統計化して照合

## 9. Session Learning

MVP後の学習ループ:

```text
Play
 ↓
Review
 ↓
Weakness Hypothesis
 ↓
Targeted Practice
 ↓
Play
```

要件:
- 収支よりDecision Qualityを重視
- 能力別Score + Confidence + Sample
- 通常UIは代表統計
- 詳細UIではTracker-like stats
- 証拠付きWeakness Hypothesis
- Player Profileを高頻度再生成
- 自動練習提案
- 過去Hand由来 + 生成類題

## 10. Persistence

- Event Logを正本
- Summary / Statsは派生
- Completed Hand単位でAuto Save
- Hand途中からの完全復元は不要
- 再現情報はBest Effort
- Reset:
  - Learning Profile
  - Opponent Memories
  - Hand History
  - Factory Reset

## 11. 制約・非目標

- Local-first
- Single User
- Authなし
- Tenantなし
- SaaS化前提なし
- Real Money Gamblingなし
- Online Multiplayerなし
- Voice Recognitionなし
- BGMなし（音は効果音だけ。D141）
- 3D Casinoなし
