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

実装（#67）: BBの補助表示は、画面上部の「BB 補助表示」ボタンでON / OFFできます（既定はON）。OFFにしても実額は常に出し、消えるのはBB換算だけです（Table上のStack・Pot・Bet、Heroの欄のStack、Hand結果の獲得額、宣言Buttonの額、Poker Vocabularyの例の文）。設定はviewerごと（このブラウザの`localStorage`。`apps/web/src/lib/display-settings.ts`）に保存し、保存が使えない環境（プライベートウィンドウ・保存の拒否）でも例外にせず既定の表示で動きます。

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

Stack Composition表示（#62）: 席のStackとBetを、額から自動で組んだChipの構成（額面ごとの色付きの積み。額面は1白・5赤・25緑・100黒・500紫の暫定値。D92・OI-004）で描きます。実額が正本で、積みは補助です（D49）。多い枚数は重ねる数に上限を置き、枚数（×N）で示します。

Chip操作（#65）: 画面下のHero欄に、Config の額面ごとのChip（Stack の Chip）・手元（手に取ったChip）・Betting Area を置きます。Chipを Click すると1枚手に取り（Click の回数が枚数）、手元の山か Betting Area を Click すると、手に取ったChipを1回の動作で出します。Stack の Chip を直接、または手元の山を Betting Area へ Drag しても出せます（Pointer Events で書き、マウスとタッチで同じ操作。Click だけでも完結する。D44）。手元のChipは出す前なら戻せますが、Betting Area に出したChipは取り消せません（実卓と同じ）。この手番の最初のChipの動作は `chip_push`、2回目以降は `chip_add` になり、「確定して Dealer に渡す」で `PhysicalAction` の列を送ります。持っている額を超えるChipは物理的に出せないので手に取れませんが、額面は Stack の構成に関係なく選べます（両替は Dealer の補助。D14）。Out-of-Turn・Oversized Chip・2回に分けた投入になる操作も、事前の警告なしにそのまま送ります（裁定はRuling Engine。D47・D91）。

Primary Numeric Bet Boxは作りません（#65 で Slider・Preset による額の指定を Hero の操作から外しました。Canonical Action の入口 `/actions` はサーバーに互換のために残っています）。

## 5. Declaration UI

Buttonによって口頭宣言の代替を行います。

ただし、毎回Declarationを強制しません。

目的は「宣言しなかったため裁定が変わる」という実卓操作も練習することです。

宣言 Button（#65）は Fold / Check / Call / Bet / Raise / All-in を局面によらず全部出し、手番でなくても押せます（合法でない宣言・手番でない宣言の扱いは裁定が決める）。Fold / Check / Call / All-in は宣言だけで Action が決まるので、押した時点でそれまでの操作と一緒に Dealer に渡します。Bet / Raise は続けて Chip を出してから確定します。手に Chip を持っていればその額を「この Street の累計（to 額）」として額も宣言し、持っていなければ額なしで宣言します（額は続けて出した Chip で決まる）。裁定の結果は Hero 欄に Dealer Feedback（§6）として出し、保留中は Hero の手番で裁定されるまで次の操作を送れません。

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

実装（#66。`apps/web/src/lib/dealer-feedback.ts`）: 公開 Event の `DEALER_RULING`（裁定の理由 `RulingCode`）と、その直前の操作の Event・直後の `ACTION_TAKEN` から、3 分類を別の項目として決定論で作ります（LLM は使いません）。Event は増やさず、Event Log から作る派生の表示です（D37）。

- RULING: 裁定の理由（例: 宣言なしの Oversized Chip・String Bet・50% 規則・手番外の操作の保留 / 拘束 / 撤回）と、Game State に反映した結果（実額）。
- ETIQUETTE: 裁定の理由に応じた進行・作法の注意（例: 先に Raise を宣言する・Chip は 1 回で出す・手番を待つ）。
- COACHING: 判断時点の Hero の情報だけで作る補足。今は Call の Pot Odds と、Bet の Pot に対する大きさ（相手の Pot Odds）。裁定より前の公開 Event だけを読み、他者の Hidden Cards・未来の Card（裁定より後の Event）・system Event は使いません（Hindsight Leak を防ぐ）。

Hero 欄は RULING を常に出し、ETIQUETTE / COACHING は分類の名前の Button で開きます（Hero 欄を低く保つため）。進行ログには 3 分類とも、分類の札を付けて別の行で残します。Hero 欄の裁定は、Hero の Action で Street が進んでも CPU の手番の間は「<Street> の裁定」として出し続け、次の Street で Hero の手番が来たら消します（保留中の裁定は裁定されるまで出します）。Dealer の進行速度の変更（D15）は Fast Forward（§8。#67）として扱います。

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

実装（#66。`apps/web/src/lib/vocabulary.ts`・`components/Vocabulary.tsx`）: 用語の辞書（日本語・標準 Term・Definition・Related Concept・Advanced Detail と、Current Hand Example を作る関数）を web 側のデータとして持ちます。卓の Street・Pot・Dealer Button・SB / BB・Fold / All-in の表示、Hero の Stack、Dealer Feedback に添えた用語を、マウスの Hover・Click / タップ・キーボード（Enter / Space で開き、詳細へ focus を移す。Escape で閉じて用語へ戻す）で開けます。Current Hand Example は Hero に見える情報（公開された値と公開 Event）だけで作り、他者の札・system Event は読みません。手番中の判断の計算（Pot Odds など）は Hint（§9）の役割なので、例は済んだ判断（Hero の直近の Call の判断時点の Pot）から作ります。

## 8. Hero Fold後

標準:
- 観戦継続

Option:
- Fast Forward

Handが終わるまではLearning-only Hidden Cardsを見せません。

実装（#67。D12・D15・D93）: Heroが Fold した後（またはHandから外れている間）のHandの途中だけ、Heroの欄に「Fast Forward」のON / OFFを出します（`components/FastForward.tsx`）。ONにすると、そのHandの残りのCPUの思考待ち（`BOT_THINK_DELAY_MS`の演出。待っている最中の分も今すぐ終える）を0にし、卓の動きの演出（transition）も止めます。縮むのは演出の待ちだけで、AI（Claude）の応答を待つ時間そのものは縮まず、`OPPONENT_TIMEOUT_MS`の上限も変わりません。速くなると誤解させないよう、Fast Forward中もCPUの手番の案内は「<CPU 名> の手番…」のまま出し（遅延が長引けば「AI応答が遅延しています」の補足も同じ）、操作の横に「CPU の思考の待ちを短くします。AI の応答を待つ時間そのものは短くなりません。」を常に添えます。Handが終わったら自動で通常の速さに戻り、次のHandはOFFで始まります。観戦中のViewは通常どおりSSEで届くHeroのViewだけで、Showdownで公開された札以外は伏せたままです。FastForwardの操作はEventに残さない演出の状態で、serverのメモリにだけ持ちます。

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

実装（#68・D93）: 見出しの「Replay を見る」で Hand の一覧（開始の新しい順。開始時刻・Hero の札・Hero の収支〔実額 + BB 補助〕、途中で止まった Hand は「未完了」、AI の障害で Session を終えて打ち切った Hand は「打ち切り」〔#77〕）を開き、選んだ Hand を Hero の視点で一手ずつ再生します（`components/ReplayScreen.tsx`）。操作は「前へ（Previous）」「再生（Play）」「一時停止（Pause）」「次へ（Next）」で、再生は最後の step で止まり、最後の step で「再生」を押すと最初から再生し直します。卓・進行ログ・Chip の構成・Dealer Feedback・用語の詳細は卓の画面と同じ部品で出し、他者の札は Showdown で公開された step から表に向きます。Hero の宣言・Chip の操作・裁定もそれぞれ 1 step です（Action に決まった裁定はその Action と同じ step）。狭い画面でも 3 つの操作 Button が 1 行に並ぶよう、ラベルは日本語と英語の 2 段にしています。Jump to Important Spot と Learning-only Full Reveal は Phase 5 の Review で扱います（D93）。

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
