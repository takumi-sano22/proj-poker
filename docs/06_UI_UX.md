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

実装（#5・狭い画面）: 幅719px以下（スマホ）では、卓の席と重なる欄を卓の中央に出さず、画面下に固定したHeroの欄へ置きます（`hooks/useNarrowScreen.ts`が境界を判定し、同じ内容を2か所に出さない）。置くのはHandの結果（獲得額の一覧・「次のHandへ」。「このHandのReview」と同じ行）・Session終了の案内・CPU障害のダイアログ（§12）で、広い画面は従来どおり卓の中央です（ただし Session が終わった後は、獲得額の一覧だけを卓の中央に置き、終わった理由・「この Session を振り返る」「新しい Session を始める」・「この Hand の Review」は画面の幅によらず Hero の欄に置きます。結果の欄に Button が縦に 2 つ並ぶと背が高くなり、1280×720 では下の Hero の席に覆われて押せなかったため。#158）。卓は縦長（幅:高さ = 5:7。7・8人卓は3:5、幅359px以下は7:10、同じ幅の7・8人卓は1:2）にし、中央（Board・Street・Pot）はBoardを1行目、StreetとPotを2行目にして低くします（Potは名前と額を1行に並べる）。中央の高さに席の面が来る4・5・7・8人卓は中央の使える幅が狭いので、Street・Board・Potを縦に積みます（`Table.tsx`の`data-center-stacked`）。Betの札は、卓の上に置くと席数によって中央や隣の席と重なるので、席の面の中（StackのChipの下）に置き、実額だけを出します（BB換算は補助なので省く。D49）。広い画面は従来どおり卓の上、席の前です。Heroの欄は、手番などの1行の案内をHeroの札・Stackの右に並べて低くします。幅720〜1023px（タブレット・小さい画面の横置き）は、卓は広い画面の配置のままで、Heroの欄だけ狭い画面と同じ詰め方（札・Stackと手番の案内を1行目、Chip・Betting Area・確定と宣言Buttonを横いっぱいの行に並べ、宣言ButtonとBetting Areaを小さく、BB換算を省く）にします。Heroの欄が折り返して高くなり（720×600で434px）、卓の下側（Heroの席・Board・Pot）を覆っていたため（約233pxに低くした。#163）。

実装（#115・D112・`docs/07` §8）: Heroの手番の間だけ、手番の案内の右に「読みを記録」（User Read）のButtonを1つ出し、押したときだけ対象（Foldしていない相手の席か「相手なし（意図）」）と本文の入力を手番の行の下に開きます（閉じている間はHeroの欄を低く保つ。記録すると閉じる）。記録した読みは進行ログにHero自身の行として出し、当たり外れは出しません。卓の右（狭い画面は下）の進行ログの下に、既定で閉じた「CPU の Note / Tag」の欄を置き、CPUを選んでTag・Noteを足し・消せます。HUD（統計）ではなくHero自身のメモなので、Play中も出します（D32）。どちらも`ui-design-recipes`の既存トークン（入力欄はFollow-upと同じ面と縁）で、横スクロールが出ないこと・操作がHeroの欄や席に覆われないことを1280×900・375×667・320×568で確かめました（E2E `e2e/tests/session.spec.ts`）。

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

実装（#68・D93）: 見出しの「Replay を見る」で Hand の一覧（新しい順＝進行中の Hand、続けて保存の新しい順〔論理順序。#132・D117〕。開始時刻・Hero の札・Hero の収支〔実額 + BB 補助〕、途中で止まった Hand は「未完了」、AI の障害で Session を終えて打ち切った Hand は「打ち切り」〔#77〕）を開き、選んだ Hand を Hero の視点で一手ずつ再生します（`components/ReplayScreen.tsx`）。操作は「前へ（Previous）」「再生（Play）」「一時停止（Pause）」「次へ（Next）」で、再生は最後の step で止まり、最後の step で「再生」を押すと最初から再生し直します。卓・進行ログ・Chip の構成・Dealer Feedback・用語の詳細は卓の画面と同じ部品で出し、他者の札は Showdown で公開された step から表に向きます。Hero の宣言・Chip の操作・裁定もそれぞれ 1 step です（Action に決まった裁定はその Action と同じ step）。狭い画面でも 3 つの操作 Button が 1 行に並ぶよう、ラベルは日本語と英語の 2 段にしています。Jump to Important Spot と Learning-only Full Reveal は Phase 5 の Review で扱います（D93）。

実装（#84・D04・D05・D93）: Hand が終わったら、画面下の Hero の欄と Replay の「この Hand の Review」で Hand Review（`components/ReviewScreen.tsx`）を開けます。初期表示は Hero の札と、Important Spot（判断時点の情報だけで選んだ判断。理由は「大きい Pot」「All-in」「River の大きい Bet」「Dealer の裁定」）を先に、ほかの判断を後に並べた一覧で、行ごとに段階評価（または「作成中」「Review 未作成」）を出します（要点先行）。一覧にも Pass A の画面にも Hand の結果・相手の実際の札は出しません。判断を選ぶと「判断時点の Review」と「Hand 後の答え合わせ」をタブで切り替え、答え合わせは別の色の面（`--color-reveal`）で出し、段階評価を付けません（Full Hand Reveal Entry）。判断時点の Review は段階評価（6 段階）・確度・要点・結論が変わる条件・理論・Exploit・前提を先に出し、Spot Detail の根拠（判断時点の卓・Action の流れ・Math・選択肢の比較・Range・Solver・知識〔KB〕）は畳んで後ろに置きます。Solver は Supported のときだけ結果（Heads-Up の解で、前提つき・唯一の正解ではない）を出し、Multiway・Flop・未導入等では使わなかった理由と代わりの根拠（Math・Range・KB）を出します。Review は「作る」「作り直す」「詳しく作る」（時間がかかる）で新しい Version として残り、Version を選んで見られます（D39）。Follow-up は Pass と Version ごとの入力欄です。判断の前に Hero が記録した User Read（#115）は、判断時点の Review の根拠に「Hero の読み（User Read）」の欄として出します（読みの無い判断では出さない）。判断より前の Hand から数えた卓の傾向（Table Tendency。D122・#169）は、根拠の「卓の傾向（Table Tendency）」の欄（畳んだ欄。Range の仮定と Solver の間）に、保存済みの Review の Evidence の値をそのまま出します。項目（VPIP・PFR・攻めの頻度・Showdown）ごとに、割合と分子 / 分母・機会があった Hand の数・「サンプルが十分」か「サンプルが足りない（保留）」か（色と文字）を 1 つの面にし、欄の先頭に「この判断より前の N Hand の、公開された Action だけから数えた卓全体の傾向で、個々の相手の傾向ではない」と断ります。広い画面（560px 以上）は項目を 1 行（名前・割合・機会があった Hand・十分か）にそろえ、狭い画面は折り返して縦に積みます。説明が根拠に挙げた項目には「説明の根拠」の印を付けます。十分な項目が無い Review は「卓の傾向はありません」とだけ出し（#153 より前の Review の記録で `opponentObservation` 自体が無いときは欄を出さない）、CPU の Persona・Memory・Tilt と Hand 後の情報（Pass B）は出しません。1280×720・375×667・320×568 で横スクロールが出ず、項目が重ならないことを E2E で測っています（`e2e/tests/review-tendency.spec.ts`）。Review Interview（docs/05 §12）で後から聞く経路と Good Decisions / Improvement Opportunities のまとめはまだありません。Replay には Jump to Important Spot（Important Spot の判断の直前の step へ移るボタン）を足し、判断の直前の step では「この判断の Review を見る」でその Review を開けます。Review の生成の待ちは「Review を作っています…」とだけ出し、長く待つときだけ「時間がかかっています」を補足します（§11。モデル名・API は出さない）。

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

実装（#52・#5）: 障害のダイアログは広い画面では卓の中央に重ね、狭い画面（幅719px以下）では席と重なって下に固定したHeroの欄に隠れるため、Heroの欄にそのまま出します（§1）。

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

## 14. Session Review / Learning

実装（#116・D16・D32・D34・D49・D115・`docs/07` §2〜§6）: Sessionが終わったとき（HeroのBust・CPUが全員Bust・AI障害でSession終了）の案内に「この Session を振り返る」を置き、Session Review（`components/SessionReviewScreen.tsx`）を開きます。広い画面は卓の中央、狭い画面は画面下のHeroの欄（§1）で、「新しい Session を始める」と並べます。戻るのはヘッダーの「卓に戻る」です。Play中のHUDは出しません（D32）。

- **判断の質を主に置く**: 先頭は「判断の質（Decision Quality）」の面で、「この Session の判断 M 件中 N 件を Review 済み」を必ず出し、Overallの点数は確度と件数を添えて出します（数えられる判断が無ければ点数を出さない）。段階評価の内訳は色と文字で、件数の注意（Confidence / Sample Caveat）を件数に応じた文で出します。未Reviewの判断をまとめてReviewするButtonは置かず、Strength / Leak・Important Handsの行からそのHand（判断）のReviewを開いて1つずつ作ります（D115）。
- **収支は事実の欄（補助）**: Hand数・時間・収支を判断の質の下に小さく並べます。収支は実額が正本で符号つき、BBはBB補助表示の設定で消せる補助です（D49）。「収支は短期の結果で運を含み、上手・下手は判断の質で見る」と添えます。
- **Ability**: Abilityごとに点数・確度・件数・傾向を1行で出し、Live MechanicsはPokerの判断と別のScoreだと示します。
- **Strength / Leak・Important Hands**: Hand の番号・Street・Action・段階評価（Important HandsはHeroの札・Important Spotの理由・Review済みの数）を出します。勝ち負けでは選ばず、結果は出しません。
- **Stats**: Hero自身の代表Stats（VPIP・PFR・3-bet等）を、割合と分子 / 分母で出します（機会が無ければ割合を出さない）。他Playerの統計は出しません。
- **Recommended Drill**: 候補（Leakの最初の判断）と「Drill を始める」を出します。候補が無ければButtonは押せません。押すとTargeted Drill（下記）を始めます（#117）。
- **Drill の結果**: 「Drill の結果（通常の Score と別に数えます）」の欄に、練習した判断の「M 件中 N 件を Review 済み」とOverall（確度と件数つき）と、Drillごとの行（変えた要素・段階評価または「未 Review」）を出します。行から、練習した判断のReviewを開きます（D105）。
- **Player Profile**: 「直近 N 件（Recent）」「全期間（Long-term）」のタブで、Review済みの数・Overall・Abilityを出し分け、全期間のWeakness Hypothesis（状態の文字と支持 / 反証の件数）・決定論の文のまとめ・全期間のHeroのStatsを続けます。Learning Reset（下記）の後は、Resetしたカテゴリの欄だけ「全期間」を「Reset 後」にし、「<日時> の Learning Reset より後に終わった Hand から数えています。」を添えます（Statsは全期間のまま）。Drillの結果の欄も、カテゴリ`score`のResetの後は同じ文を添えます。
- **Learning Reset（#118・D114・`docs/04` §11）**: Player Profileの下に「学習の記録を数え直す（Learning Reset）」の欄を置きます（`components/LearningReset.tsx`）。数え直す項目（Score・弱点の仮説・まとめの文）をチェックで選び（既定は全部）、「数え直す…」で確認の面を開きます。確認の面は危険色の縁で区切り、選んだ項目・「この操作は取り消せません」・「Hand の記録・Review・Note / Tag・User Read・Stats は消えません」を出し、初期フォーカスは「やめる」に置きます（開いた直後の Enter で確定させない）。確定は`.btn--danger`の「数え直す」です。送信中は Button を押せなくし、失敗したら驚かせない文言で再送を促します。終わったらProfileとDrillの結果を読み直し、最後のResetの時刻をカテゴリごとに出します。1280×900・375×667・320×568で横スクロールが出ないこと・確定の Button が覆われないことを確かめました。
- Hidden Persona・CPUのPrivateな状態・他者の札・Learning-only Revealは画面に届きません（APIが返さない）。値はすべて`ui-design-recipes`の既存トークン（Reviewの面・段階評価の色・`.spot-row`・`.pass-tab`）で描き、横スクロールが出ないこと・Buttonが覆われないことを1280×900・375×667・320×568で確かめました。

### Targeted Drill（#117・D105・D110・D116・`docs/07` §7）

- Session Reviewの「Drill を始める」で、Drillの卓に移ります（`App.tsx`の画面の状態`drill`）。卓・進行ログ・Heroの欄は通常の卓と同じ部品で、上にDrillの説明の面（`components/DrillBanner.tsx`）を置きます。説明は、変えた要素の名前（有効 Stack / Bet の額 / 相手の傾向）と、元 → Drillの値（Stackと Betの額は実額が正本でBBは補助。D49）、相手の傾向はDrillの設定のPresetの名前です。しくみ（Heroの札と判断時点のBoard・それまでのActionは元のまま、相手の札とこの後のBoardは配り直す、相手はRuleBot、結果は別に数える）は畳んだ欄（`<details>`）に置き、狭い画面で卓を押し下げすぎないようにします。
- Drillの卓にはCPUのNote / Tagの欄を出しません（Drillの相手はDrillの設定のRuleBot）。Handが終わったら、結果の欄（広い画面は卓の中央、狭い画面はHeroの欄。§1）に獲得の行と「卓に戻る」を出し、Heroの欄に「練習した判断の Review」を出します（既存のReviewの画面。Pass Aの経路そのまま）。「次の Hand へ」は出しません。通常の卓のSessionはDrillの間もそのまま残り、「卓に戻る」で続きに戻ります。
- 上の席の札は卓の枠より上へはみ出すので、説明の面の下を広い画面で32px・狭い画面で20px空けます。1280×900・375×760・320×568で、説明の面と席の札が重ならないこと・横スクロールが出ないことを確かめました。


## 15. Tournament（Phase 8。#107・D108・D127〜D130）

- 新しいSessionの開始でCash / Tournamentと、TournamentのPreset（標準のhand-countの6-max STTとtime-base。D128）を選べます。Cashの画面と流れは変えません。
- 卓には現在のBlind / Ante / Levelと、次のLevelまでの残り（hand-countはHandの数、time-baseはプレイ時間）を出します。
- 残人数・Payout・Eliminationを出し、Stackは実額を常時表示してBBを補助にします（D49）。
- HeroのBustか優勝でTournamentを終え、Result（Heroの順位とPayout・確定した他の順位。残ったCPUの順位は未決）を出します（D129）。
- ReviewではICM / Prize EquityとChip EVを別の項目として表示し、混同させません（D130）。
- 具体的な配置（#190。`ui-design-recipes`）。人間判断を経ていない表示の規則は暫定です（変えてよい）:
  - **Sessionの種類の選択**: 最初の画面とSessionの終わりの案内（「新しいSessionを始める」の左。Heroの欄では見出しの文字を出さない`select`）に、Cash Game（既定）/ Tournament（10 Handごと）/ Tournament（10分ごと）を置きます。選んだ種類は「新しいSessionを始める」「Handを始める」だけが送り、「次のHandへ」「卓に戻る」は送りません（続くSessionをそのまま続ける）。前のSessionが続いていて種類が違えば（`session_mode_mismatch`）、案内と「続きから遊ぶ」を出します。CashのSessionで選ばなければ、画面と流れは今までどおりです（Session終了の案内に`select`が1つ増えるだけ。狭い画面と720px台では1行増える）。
  - **見出し**: TournamentのHandは「Level 2 · 15 / 30 · BB Ante 30」の形で出します（Cashは今までどおり「ブラインド（Blinds） 1 / 2」）。値はHeroに見える`HAND_STARTED`（`tournament`・`ante`）から作ります。幅359px以下はAnteを見出しから省きます（見出しが1行増えないように。Tournamentの欄に出す）。
  - **Tournamentの欄**: 卓の右（狭い画面は卓の下）の進行ログの上に置き、Level（何Levelのうちか）・Blind・Ante・次のLevel（hand-countは「11 Hand目から（今3 Hand目）」、time-baseは「プレイ時間であと約7分」。過ぎていれば「次のHandから」。最後のLevelは「以後は上がりません」）・残人数を常に出し、PayoutとElimination（脱落した順位・名前・Payout）は畳める欄に置きます（進行ログを押し下げすぎない）。Payoutはpt（参加費の単位）と書き、Stack・PotのChip（実額）と別の量だと注記します。値はserverの`GET /api/hands/:handId/tournament`（`docs/03` §1）を、卓の状態が進むたびに読み直します（time-baseの進行中のHandは、Heroの考え中・AIの応答待ちの間も残りが減るので30秒ごとにも。`TOURNAMENT_REFRESH_MS`）。表示中のHandの値だけを出します（Handが変わったら、読み終えるまで欄を出さない）。
  - **Result**: HeroのBust・優勝でTournamentが終わったら、Heroの欄の案内を「Heroは2位でTournamentを終えました（Payout 180pt）。」/「Heroが優勝しました…」にし、Tournamentの欄を開いて順位とPayoutを出します（順位の決まっていないPlayerを先に「未決」「未確定」と書き、続けて決まった順位を上から）。打ち切った（`ai_outage`）Tournamentは、残っていたPlayer（Heroを含む）の順位とPayoutが決まらないことを書きます（OI-007の暫定Policy）。
  - **Review**: Pass Aの根拠に「Tournament（ICM / Prize Equity と Chip EV）」の欄を足し、段階（Stage）・残人数・Level・Payout・全席の判断時点のICM Equity（ptと%。Stackは実額でBBは補助）を出します。All-inの関わる判断は、相手ごとに「Chip EVの必要Equity」と「ICMの必要Equity」を別の列で出し、Shoveは「〈相手〉にCallされた場合」と書いて、条件付きの前提（Evidenceの文のまま）を出します。範囲外（MultiwayのAll-in等）は理由だけを出します。TournamentのHandでは「計算（Math）」の見出しを「計算（Math・Chipで計算）」にします。
  - **Important Spot**: Replay・Reviewの判断の一覧・Session ReviewのImportant Handsに、TournamentのHandの理由（Bubble（入賞の手前）・Pay Jump（賞金の段差）・Short Stack（10 BB以下））を出します（serverの`importantSpotsOf`がReviewと同じ規則で選ぶ）。
  - 情報境界: どの欄にもCPUのPersona・Private Memory・他者の札は出しません（ICMは公開のStackから）。320×568・375×667・720×600・1024×768・1280×720で横スクロールが出ないこと、Cashの配置のE2E（`session-end-layout`・`table-layout`）が通ることを確かめました。
