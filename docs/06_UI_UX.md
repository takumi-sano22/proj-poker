# UI / UX仕様

## 1. Table UI

方向性:
- ライブ卓寄りの2D Table
- モダン・カジノの世界観で強めのゲーム演出を許す。ただし読みやすさと正確性（実額の常時表示・Dealer Feedbackの3分類・情報境界）を先に守る（D135。旧方針「Casinoゲーム的な演出より読みやすさを優先」を置き換えた。#216）
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

実装（#5・狭い画面）: 幅719px以下（スマホ）では、卓の席と重なる欄を卓の中央に出さず、画面下に固定したHeroの欄へ置きます（`hooks/useNarrowScreen.ts`が境界を判定し、同じ内容を2か所に出さない）。置くのはHandの結果（獲得額の一覧・「次のHandへ」。「このHandのReview」と同じ行）・Session終了の案内・CPU障害のダイアログ（§12）で、広い画面は従来どおり卓の中央です（ただし Session が終わった後は、獲得額の一覧だけを卓の中央に置き、終わった理由・「この Session を振り返る」「新しい Session を始める」・「この Hand の Review」は画面の幅によらず Hero の欄に置きます。結果の欄に Button が縦に 2 つ並ぶと背が高くなり、1280×720 では下の Hero の席に覆われて押せなかったため。#158）。卓は縦長（幅:高さ = 5:7。7・8人卓は3:5、幅359px以下は7:10、同じ幅の7・8人卓は1:2）にし、中央（Board・Street・Pot）はBoardを1行目、StreetとPotを2行目にして低くします（Potは名前と額を1行に並べる）。中央の高さに席の面が来る4・5・7・8人卓は中央の使える幅が狭いので、Street・Board・Potを縦に積みます（`Table.tsx`の`data-center-stacked`）。Betの札は、卓の上に置くと席数によって中央や隣の席と重なるので、席の面の中（StackのChipの下）に置き、実額だけを出します（BB換算は補助なので省く。D49）。広い画面は従来どおり卓の上、席の前です。Heroの欄は、手番などの1行の案内をHeroの札・Stackの右に並べて低くします。幅720〜1023px（タブレット・小さい画面の横置き）は、卓は広い画面の配置のままで、Heroの欄だけ狭い画面と同じ詰め方（札・Stackと手番の案内を1行目、Chip・Betting Area・確定と宣言Buttonを横いっぱいの行に並べ、宣言ButtonとBetting Areaを小さく、BB換算を省く）にします。Heroの欄が折り返して高くなり（720×600で434px）、卓の下側（Heroの席・Board・Pot）を覆っていたため（約233pxに低くした。#163）。裁定（RULING）が出ると Hero の欄が約 100px 高くなり、720×600 で Hero の席・Board・Pot が収まらず、320×568 では欄が画面より高くなっていたので、幅 1023px 以下では Dealer Feedback の分類の札・用語・補足の Button を文の中に流し込み、狭い画面は欄の上下の余白を詰め、幅 359px 以下は Betting Area の案内（Click / Drag の仕方）を省きます（#179）。それでも 320×568 では Hero の欄が画面の 7 割強（RULING が出ると 9 割強）を占め、卓は欄の上でスクロールして見ます（さらに低くするには UX の変更が要る。方針は D137〔折りたためる Hero 操作パネル。§16.3〕で決まり、実装は UX-05 #220。`ui-design-recipes`の`references/proj-poker.md`「既知のずれ」）。

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

今後（D139・§16.3）: 操作パネルの折りたたみや Home / Learn への移動では、未確定の下書き（手に取った Chip・宣言の途中）を失いません。

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

今後（D142・§16.5）: 裁定が出たら RULING を先に数秒出して自動で閉じ、続けて ETIQUETTE を Hero が明示的に確認してから進行を再開します。下の「実装（#66）」の出し方（RULING を次の Hero の手番まで出し続け、ETIQUETTE は Button で開く）は、UX-11（#226）の実装までの現状です。

実装（#66。`apps/web/src/lib/dealer-feedback.ts`）: 公開 Event の `DEALER_RULING`（裁定の理由 `RulingCode`）と、その直前の操作の Event・直後の `ACTION_TAKEN` から、3 分類を別の項目として決定論で作ります（LLM は使いません）。Event は増やさず、Event Log から作る派生の表示です（D37）。

- RULING: 裁定の理由（例: 宣言なしの Oversized Chip・String Bet・50% 規則・手番外の操作の保留 / 拘束 / 撤回）と、Game State に反映した結果（実額）。
- ETIQUETTE: 裁定の理由に応じた進行・作法の注意（例: 先に Raise を宣言する・Chip は 1 回で出す・手番を待つ）。
- COACHING: 判断時点の Hero の情報だけで作る補足。今は Call の Pot Odds と、Bet の Pot に対する大きさ（相手の Pot Odds）。裁定より前の公開 Event だけを読み、他者の Hidden Cards・未来の Card（裁定より後の Event）・system Event は使いません（Hindsight Leak を防ぐ）。

Hero 欄は RULING を常に出し、ETIQUETTE / COACHING は分類の名前の Button で開きます（Hero 欄を低く保つため）。進行ログには 3 分類とも、分類の札を付けて別の行で残します。Hero 欄の裁定は、Hero の Action で Street が進んでも CPU の手番の間は「<Street> の裁定」として出し続け、次の Street で Hero の手番が来たら消します（保留中の裁定は裁定されるまで出します）。Dealer の進行速度の変更（D15）は Fast Forward（§8。#67）として扱います（現状。D140 で表示演出の速度4段階〔§16.4〕を Fast Forward と別の契約として足す）。

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

Fast Forward は CPU の思考待ちを縮める契約で、表示演出の速度4段階（D140・§16.4。client の表示だけを速める）とは別に持ちます（片方で他方を代用しない）。

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
- Animation Speed（D140 で標準 / 高速 / 超高速 / 演出なしの4段階。Replay は独立。§16.4）
- 効果音のマスター音量・ミュート（D141。§16.6）
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
  - **Sessionの種類の選択**: 最初の画面とSessionの終わりの案内（「新しいSessionを始める」の左。Heroの欄では見出しの文字を出さない`select`）に、Cash Game（既定）/ Tournament（10 Handごと）/ Tournament（10分ごと）を置きます。選んだ種類は「新しいSessionを始める」「Handを始める」だけが送り、「次のHandへ」「卓に戻る」は送りません（続くSessionをそのまま続ける）。前のSessionが続いていて種類が違えば（`session_mode_mismatch`）、案内と「続きから遊ぶ」を出します。まだ結果を見ていないHand・再起動後に戻したSessionが開いたとき（serverは開始の再送を冪等にするため、選んだ種類と違ってもそのHandを返す）は、開始の応答の`sessionKind`と選んだ種類を比べ、違えば「前のSessionの続きを開いた」と案内します。CashのSessionで選ばなければ、画面と流れは今までどおりです（Session終了の案内に`select`が1つ増えるだけ。狭い画面と720px台では1行増える）。
  - **見出し**: TournamentのHandは「Level 2 · 15 / 30 · BB Ante 30」の形で出します（Cashは今までどおり「ブラインド（Blinds） 1 / 2」）。値はHeroに見える`HAND_STARTED`（`tournament`・`ante`）から作ります。幅359px以下はAnteを見出しから省きます（見出しが1行増えないように。Tournamentの欄に出す）。
  - **Tournamentの欄**: 卓の右（狭い画面は卓の下）の進行ログの上に置き、Level（何Levelのうちか）・Blind・Ante・次のLevel（hand-countは「11 Hand目から（今3 Hand目）」、time-baseは「プレイ時間であと約7分」。過ぎていれば「次のHandから」。最後のLevelは「以後は上がりません」）・残人数を常に出し、PayoutとElimination（脱落した順位・名前・Payout）は畳める欄に置きます（進行ログを押し下げすぎない）。Payoutはpt（参加費の単位）と書き、Stack・PotのChip（実額）と別の量だと注記します。値はserverの`GET /api/hands/:handId/tournament`（`docs/03` §1）を、卓の状態が進むたびに読み直します（time-baseの進行中のHandは、Heroの考え中・AIの応答待ちの間も残りが減るので30秒ごとにも。`TOURNAMENT_REFRESH_MS`）。表示中のHandの値だけを出します（Handが変わったら、読み終えるまで欄を出さない）。
  - **Result**: HeroのBust・優勝でTournamentが終わったら、Heroの欄の案内を「Heroは2位でTournamentを終えました（Payout 180pt）。」/「Heroが優勝しました…」にし、Tournamentの欄を開いて順位とPayoutを出します（順位の決まっていないPlayerを先に「未決」「未確定」と書き、続けて決まった順位を上から）。打ち切った（`ai_outage`）Tournamentは、残っていたPlayer（Heroを含む）の順位とPayoutが決まらないことを書きます（OI-007の暫定Policy）。
  - **Review**: Pass Aの根拠に「Tournament（ICM / Prize Equity と Chip EV）」の欄を足し、段階（Stage）・残人数・Level・Payout・全席の判断時点のICM Equity（ptと%。Stackは実額でBBは補助）を出します。All-inの関わる判断は、相手ごとに「Chip EVの必要Equity」と「ICMの必要Equity」を別の列で出し、Shoveは「〈相手〉にCallされた場合」と書いて、条件付きの前提（Evidenceの文のまま）を出します。範囲外（MultiwayのAll-in等）は理由だけを出します。TournamentのHandでは「計算（Math）」の見出しを「計算（Math・Chipで計算）」にします。
  - **Important Spot**: Replay・Reviewの判断の一覧・Session ReviewのImportant Handsに、TournamentのHandの理由（Bubble（入賞の手前）・Pay Jump（賞金の段差）・Short Stack（10 BB以下））を出します（serverの`importantSpotsOf`がReviewと同じ規則で選ぶ）。
  - 情報境界: どの欄にもCPUのPersona・Private Memory・他者の札は出しません（ICMは公開のStackから）。320×568・375×667・720×600・1024×768・1280×720で横スクロールが出ないこと、Cashの配置のE2E（`session-end-layout`・`table-layout`）が通ることを確かめました。

## 16. 横断 UI/UX（Post-Phase8。#215・#216・D135〜D142）

#203 の実機プレイを受けて人間が決めた Q1〜Q29（D135〜D142。Q と D の対応は `docs/10`）の設計の正本です。**この節は設計で、実装は UX-02 の照会 API（`GET /api/session/current`。D144）だけです**（UX-03〜UX-11 は未実装。#215 の Gate 0 / Gate 1 を満たすまで機能を実装しない）。可逆な値は OI-012 の暫定値で、ここに書いた数値は目安です。技術検証で決める事項（§16.8）は、人間が採用した行（UX-06 の D143・UX-02 の D144）を除き、採用済みの事実として扱いません。

### 16.1 守る不変条件

- Event Log が唯一のゲームの正本で、Hand Engine は決定論、LLM はルールを判定しない（D37・D40）。演出・下書き・表示設定はゲームの正本ではなく、Event に残さない（確定して送った物理操作は従来どおり `PHYSICAL_CHIP_ACTION` 等。D90）。
- 演出・Home・Replay は Hero に見える情報（Hero の View と公開 Event）だけを使い、Hero 以外の Hidden Cards・Future Cards・system Event・CPU の Persona / Private Memory・Learning-only Reveal を使わない。Showdown の演出も公開の対象になった札だけ（Muck した札は出さない）。
- Pass A / Pass B を混ぜない。実額を常に出し BB は補助（D49）。実卓の操作（Chip の Click / Drag・手番外の操作・String Bet などの裁定。D44・D47・D91）を保つ。
- Card / Chip は SVG / CSS の構造描画（D60）。音は効果音だけで、BGM・Voice・3D・SaaS 等は入れない（docs/00 §6）。
- Fast Forward（§8）と表示演出の速度4段階（§16.4）は別の契約。
- Cash / Tournament / Drill / Replay / Resume に回帰を出さない。

### 16.2 App Shell と画面遷移（D136）

```text
起動 ──► Home ──「続きから遊ぶ」/「新しい Session」──► Play（卓・Hero 操作）
          ▲  │                                         │  ▲
          │  └──────────► Learn ◄──────────────────────┘  │
          │               （Replay・Hand Review・          │
          │                Session Review・Player Profile）│
          └──────────── 戻る（戻り先と閲覧位置を保持）─────┘
```

- 起動時は必ず Home を出す。Home は読み取り専用の Session 状態の照会だけを使い、Hand を始めない・進めない。続けられる Session があれば「続きから遊ぶ」を出す（照会は D144 の `GET /api/session/current`。今の `POST /api/hands` は開始の要求なので Home の照会に使わず、「続きから遊ぶ」を Hero が押したときだけ呼ぶ。`ended` はこのプロセスで終わった Session だけで再起動後は `null`、知らない state では「続きから」を出さない）。
- Learn / Replay から戻るときは、戻り先（Home か Play）と閲覧していた Hand・Review の位置を保持する（Q23）。
- Play を離れている間も、進行中の Hand は今の規則どおり server が進め・止める（Hero の入力待ち・AI 障害・ETIQUETTE の確認待ち。§16.5）。Play に戻ったら最新の公開状態から表示する（§16.4 の再接続と同じ）。

### 16.3 レイアウトと Hero 操作（D137・D138・D139）

- **PC**: 卓を中央、右に情報パネル（進行ログ・Note / Tag・Tournament の欄など。折りたためる）、下部に Hero の操作。右のパネルにも Play 中の HUD（統計）は置かない（D32）。
- **スマホ**: Hero の操作パネルを折りたためる形にし、Hero の手番で自動で開き、Hero はいつでも開閉できる。開いた高さの上限は画面の高さの約65〜70%で、中身は内部でスクロールする（OI-012）。今の「狭い画面で Hero 欄が画面の 7〜9 割を占める」制約（§1・`ui-design-recipes` の `references/proj-poker.md`「既知のずれ」）を解くための判断。
- **Chip**: Click / Drag の両方を保ち、操作用の Chip を大きく（PC 約54px・スマホ約48〜52px を基準に画面で調整。OI-012）する。Stack → 手元 → Betting Area の移動を演出で見せる。Betting Area は見た目を小さくしてよいが、ドロップの判定領域は確保し、他の操作の判定領域と重ねない。数値の Bet Box・Slider は今どおり作らない。
- **下書きの寿命**: 手に取った Chip・宣言の途中などの未確定の下書きは client の表示状態で、パネルの折りたたみや Home / Learn への移動では失わない。同じ Hand で有効な間だけ保持し、Hand が進んで無効になったら破棄して Hero に知らせる。有効の判定（`operationKey` / `lastSeq` との整合）と寿命の細部は UX-04（#219）で決める。プロセスの再起動を跨いだ復元は求めない（D62）。

### 16.4 Presentation Controller（D140）

client の表示層で、ゲームの進行（Engine・Event Log・server の CPU の進行）を変えない。責務:

1. **入力**: Hero に見える View / 公開 Event だけ（§16.1）。UX-06（#221）の検証で、今の `HeroView.log`（配るたびに Hero に見える Event の全量を運ぶ）から、表示済みの seq より大きい Event を取り出し、各時点の卓を `projectHeroView`（prefix）で作れば、API を足さずに演出の順序を復元できることを確かめた（連続する CPU Action・Street・Showdown・All-in の Runout・Main / Side / Split Pot・Fold の終了・受信の重複 / 欠落・再接続。裁定とその Action を 1 つにまとめた各時点の卓は Replay の `steps` と一致）。この API 拡張なしの案 A と、情報境界・操作送信の契約は人間が UX06-1〜3=A として承認した（D143。記録は `docs/taskLog/issue-221-live-presentation-verification.md` と #221 のコメント）。
2. **順序**: 表示を 1 つずつ演出し、終わってから次を出す（キュー）。Flop は 3 枚を順にスライド・フリップし、Turn / River も個別に演出する。Showdown は毎回、公開対象の札・勝者・Pot の配分（Side Pot を含む）を演出する。
3. **速度**: 表示演出の速度は 標準 / 高速 / 超高速 / 演出なし の4段階で、Skip もできる。Skip・演出なしでも表示の内容（公開札・勝者・Pot の配分・実額）は省かず、省くのは動きだけ。
4. **Hero の手番の到来**: 順序を保ったまま、残っている通常の演出を自動で速める。Showdown の公開と結果は省かない。
5. **再接続**: 古い演出のキューを捨て、最新の公開状態に合わせる。見逃した分は Replay で見る。
6. **Replay との共有**: Live と Replay は演出の部品を共有し、Replay の再生・一時停止・速度は Live と独立に持つ（D93 の Previous / Next / Play / Pause に速度を足す）。
7. **Fast Forward と別**: Fast Forward（§8）は server の CPU の思考待ちを縮める契約で、表示演出の速度は client の表示だけを速める。

**送信時の鮮度契約（D143）**: Server から届いた最新の `authoritative` View と、演出を終えた `displayed` View を別々に管理する。演出中に操作の下書きを作ってもよいが、確定送信の前に残演出を自動高速化して追いつき、手番・下書きの有効性を最新の公開状態で検査する。可視 `lastSeq(displayed) === lastSeq(authoritative)` になった場合だけ、その表示値で送信する。未表示の最新 seq を先取りして送信せず、無効化された下書きは破棄・通知する（D139・UX-04 #219 と同じ寿命契約）。手番外の操作も同じ鮮度条件を守る。飛び番は欠落と解釈せず、UI に seq を表示しない（UX06-1=A）。

各段階の所要時間（ms）と自動高速化の度合いは OI-012 の暫定値。`prefers-reduced-motion` では既存どおり動きを止める。

### 16.5 Dealer の通知の優先順位（D142）

1. 裁定が出たら **RULING** を先に数秒（OI-012）出し、自動で閉じる。
2. 続けて **ETIQUETTE** を出し、Hero が明示的に確認するまで進行を再開しない。
3. 確認の後に進行を再開する。**COACHING** は今どおり Hero が開いたときだけ出す（自動では出さない）。
4. 確認を待つ間も Hero は Home / Learn へ移動でき、進行の待ちは続き、Play に戻ったら確認を再び求める。

3 分類を同じ Warning として混ぜない（§6）・裁定の規則（D91）と Event（D90）は変えない。確認待ちで CPU を止める責務・確認（Ack）の契約・AI 障害（§12）のダイアログや再接続・Resume との関係・複数の裁定が続いたときの順序は UX-11（#226）で設計し、#215 Gate 1 で人間が承認するまで実装しない。

### 16.6 効果音と設定の保存先（D141）

- 効果音は Card・Chip・Street・勝利。BGM は無し。既定は ON だが、ブラウザがユーザー操作の後にしか再生を許さない制約と、ユーザーの設定を尊重する。
- マスター音量とミュートは保存する。保存するのは viewer の表示設定で、ゲームの正本（Event Log）や server の DB には入れない。保存先は UX-10（#225）で決める（既存の BB 補助表示の viewer ごとの `localStorage`〔§2〕が第一候補。保存が使えない環境でも既定で動く）。
- 表示演出の速度（§16.4）も表示設定で、Event Log に入れない。

### 16.7 デザイン・音声のトークン（D135・D141）

- 世界観はモダン・カジノ。背景・光・演出などの装飾素材は制作してよい（UX-08 #223 で ChatGPT が制作し、実装担当と分ける）。Card / Chip は構造描画のまま。
- 色・光・影・動き・音は、既存の方式どおりトークン（`apps/web/src/styles.css` の `:root`）を通して使い、部品に直書きしない。追加するトークンの種類と導線は `ui-design-recipes` の `references/proj-poker.md` に置き、値は OI-012 の暫定値。
- 強い演出も、実額・RULING・Hero の操作を覆わない・読みにくくしない範囲で使う。

### 16.8 技術検証で決める事項（未確定）

採用済みの事実ではありません。人間の判断を要するものは #215 Gate 1 で承認します（一覧は OI-012）。

| Issue | 決めること |
|---|---|
| UX-02 #217 | **採用済み D144**: `GET /api/session/current`（`{session: null}` か state・Session の種類。Session ID・Hand ID・Stack・札は返さない）、開始と同じ読み取り専用の判定から作る、`ended` はこのプロセスの終了だけ、知らない state は安全側、#230（Pause / End）の承認後に追加で拡張 |
| UX-04 #219 | 下書きの有効・無効の判定（`operationKey` / `lastSeq`）と寿命、無効化の通知 |
| UX-06 #221 | **採用済み D143**: 可視 Event 全量を現在の `HeroView.log` から client が再構築（API 拡張なし）、seq の飛び番を受容、演出中の下書き保持・送信前の同期と再検証。未検証の Tournament Ante / BBA と Hand 途中の Side Pot 派生表示は #222・#224 に引き継ぐ |
| UX-10 #225 | 効果音の設定の保存先・自動再生の制約への対応 |
| UX-11 #226 | ETIQUETTE の確認待ちで CPU を止める責務の置き場所・Ack の契約と Event に残すか・Outage / Resume / 再接続との関係・連続する裁定の順序 |
