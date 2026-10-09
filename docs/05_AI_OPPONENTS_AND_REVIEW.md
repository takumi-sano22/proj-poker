# AI CPUとReview設計

## 1. Opponent Agent Contract

Opponent AIは**戦略を決めますが、ルールを決めません**。

入力:

- 自分のHole Cards
- 公開済みBoard
- Pot / Stack
- Position
- Legal Actions
- Legal Amount Range
- 自分が観察可能な履歴
- Persona / State
- 必要な決定論的Math
- 自分が過去に得たObservation / Hypothesis（Phase 7。§5。D106。実装はEvidence ID付きの構造化した要約〔#139・D121〕）
- Public Tournament Context（Phase 8。`docs/02` §7。D109）

渡してはいけないもの:

- 他PlayerのHidden Cards
- Future Deck
- Learning-only Reveal
- Hero Weakness Database
- 他CPUのPrivate Observation
- 他CPUのSecret Persona

出力:

- Action
- 必要ならAmount
- 任意のCompactなRationale / Debug Metadata

## 2. Persona Model

推奨Parameter:

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

すべてを一つの `difficulty` に縮約しないでください。

## 3. 弱いCPU

弱さは「人間にありがちな一貫したLeak」として作ります。

例:

- Call Rangeが広すぎる
- Cold Callしすぎる
- 3-bet不足
- Drawを追いすぎる
- RiverでOverfold
- RiverでOvercall
- Underbluff
- Overbluff
- Position軽視

弱くするために、Illegal / 意味不明なRandom Actionを混ぜないでください。

## 4. Tilt / 非合理行動

Transient Stateを持てます。

Trigger例:

- 大きいPotを失った
- 連続で負けた
- Bluff失敗
- 大勝ち後のOverconfidence

影響はPersona依存とします。

例:

```text
Tilt上昇
 ↓
参加Rangeが少し広がる
Aggression上昇
Discipline低下
```

このような条件成立時のみ、Strategically PoorなActionへ低確率を割り当てられます。

Phase 7のTilt（D107。#106 P7-5）:

- Version付きの決定論State Machineです（同じHandの流れからは同じTiltになる）。
- Hand間で増減・減衰し、Session終了でResetします。
- Persona（固定の性格）・Long-term Memory（観察の記録）とは別の、transientな層として持ちます。
- Personaの確率分布へ限定的に反映します。Illegal / RandomなActionを弱さとして混ぜません（§3）。
- TiltのPrivate StateはHeroのEvidenceに使いません。
- Trigger・しきい値・増減・減衰の値はVersion付きの暫定値です（OI-011）。D119の暫定値（`phase7_tilt_v1`）: 0〜3の整数の段階で、Trigger（40BB以上のPotの負け・3連敗・ShowdownでBluffが見つかる・大勝ち）で上がり、1 HandごとにPersonaの`recoverySpeed`に応じて下がります。反映はLooseness / Aggressionを段階ごとに上限付きで少しずらすだけです。順序はHandの論理順序で決め、壁時計を使いません（D117）。

Tiltの実装（#140。`apps/server/src/opponents/tilt.ts`・`tilt-policy.ts`。数値と定義はすべてOI-011の暫定値で、確定ではない）:

- **単位と寿命**: Session の中の席（その Session の参加者）ごとの状態です。Fixed CPU の Long-term Memory（§5のHypothesis）・Personaとは別の層で、保存しません（テーブル・列・Event・`schema_version`を足さない）。Hand Orchestratorが Handの開始時（そのHandをEvent Storeへ書く前）に、今のSessionの保存済み（終わった）Handを論理順序（`ordinals.ord`）で頭から畳み込んで作る純粋関数です。Sessionが変われば0から始まるので、Session終了でResetされ、`SESSION_ENDED`の無い放置されたSessionの後でも次のSessionへ持ち越しません。Resumeでは同じSessionのHandから同じ値になります。Personaの無いCPU・DrillのHandはTiltを持ちません。
- **入力**: 卓の全員が見た`public`のEvent（保存されたVisibilityとEngineが種類から決めるVisibilityの両方で判定。そのCPU自身の結果を含む）だけです。Hole Cards（`private`。自分の札もShowdownで表にした`CARDS_TABLED`から読む）・Deck・`system`の記録・Learning-only Reveal・Heroの弱点は読みません。CPUが座っていないHand（Bustの後）と、`HAND_FINISHED`の無いHand（打ち切ったHand）では動きません。
- **1 Handの結果**（そのCPU自身から見た定義）:
  - Showdownの負け: Foldせずに札を比べたPotまで残り、Potを1枚も受け取らなかった。Potを1枚でも受け取れば勝ち（連敗が切れる）。Foldした Handは勝ちでも負けでもない（連敗を切らない）。
  - 40BB以上のPotの負け（Trigger）: Showdownの負けで、争えたPotの総額がそのHandのBig Blindの40倍以上。
  - 3連敗（Trigger）: Showdownの負けが3回続いた（数えた連続は0に戻し、次の3連敗でまた発火）。
  - ShowdownでBluffが見つかる（Trigger）: Showdownの負けで、そのHandの最後に額を引き上げた（Bet / Raise / 額を上げるAll-in）のが自分で、Board 5枚に対して自分の2枚で役が上がっておらず（7枚の役の種類がBoard 5枚だけの役の種類と同じ）、その役がOne Pair以下。
  - 大勝ち（Overconfidence。Trigger）: 収支（受け取った額 − 出した額）がプラスで、受け取ったPotの総額がBig Blindの40倍以上。
- **遷移**（`phase7_tilt_v1`）: 段階は0〜3の整数です。1 Handで発火したTriggerの数を数え、`ceil(数 × tiltSusceptibility × 2)`段上げます（上限3。上がったHandは下がらない）。Triggerの無いHandが`round(10 − 8 × recoverySpeed)`回続くごとに1段下げます（TAG Regularは4 Hand、Maniacは8 Hand）。
- **反映**: RuleBotは、1段あたりPersonaのPreflop LoosenessとAggressionを+0.05（3段で+0.15が上限。軸は1を超えない）ずらしたPersonaでしきい値を作るだけで（`tiltedPersona`）、乱数の引き方は変えず、Legal Actionの中から選びます（D40）。ClaudeのCPUには、そのCPU自身のInternal State（§1のPersona / State・`docs/04` §5）として、1以上のときだけ「あなたの今の状態」の節に段階と固定の説明（参加する手が少し広がり、少し攻撃的になる）を入れます。0のときは節ごと入れず、Promptは#140より前と同じ文字列です（LLMの呼び出しの回数・経路は変えない）。
- **境界**: TiltはHeroのEvidence・Review・UI・Event・APIの応答に出しません。他のCPUの`KnowledgeState`・Promptにも出しません。`opponents/tilt-isolation.test.ts`が、`review/`・`learning/`からのimportがTiltのモジュールに届かないことと、Fakeの`query()`で2つのSessionを進めたClaudeのCPUの全Promptで、Tiltの節がそのCPU自身の席の値（Personaで畳み込んだ値。0なら節が無い）だけであること・次のSessionが0から始まること・ReviewのPrompt・Heroへの応答・Event LogにTiltが出ないことを確かめます。

## 5. Opponent Modeling

各CPUは以下を分離して保持します。

1. Observation
2. Hypothesis
3. Confidence

SkillはOpponent Modelの質にも影響します。

強いCPU:
- Sample不足なら保留しやすい

弱いCPU:
- 少数Sampleから早合点する場合がある

CPU内部のSecret HypothesisをHeroへ「事実」として見せてはいけません。

### Phase 7のIdentityとMemory（D106。#106）

- **Identity**: Fixed CPUは、席・player id（`cpu1`等）と別の永続`cpuProfileId`を持ちます。Fixed CPUのMemoryはSessionを跨いで持続し、Guestの一時IdentityとMemoryはSession終了時に破棄します（D11・D63）。DBのSchemaを固定人数にCoupleしません（OI-005）。実装（#136）はSession×席の`session_participants`（`docs/04` §12）と、Fixed Poolのコードの Config（`apps/server/src/opponents/cpu-pool.ts`）です。Fixed CPUは常にPoolのPersonaで打ち（同じCPUは毎回同じPersona）、席のPersonaと同じPresetを持つ者から選ばれるので、既定の割り当てでは席のPersonaも従来と同じです。`CPU_PERSONAS`の上書きはFixed Poolで満たせる範囲で効きます。
- **Observation**: そのCPUが実際に観察できたPublic / Showdown Evidenceだけを、provenance付きでappend-onlyに記録します（`docs/02` INV-INFO-003・`docs/04` §6）。Learning-only Reveal・他者のHidden Cards・Future Cardsは入れません。
- **Hypothesis**: Observer × Subject × Contextごとに、Raw Observationから再生成できるProjectionとして作り、集計にrecency decayをかけます（Raw Observationは消さない）。Sample不足の扱いと更新の速さ・早合点の傾向は、上のSkillの差としてPersona Policyで変えられます。decayの係数等はVersion付きの暫定値です（OI-011）。
- **CPU-to-CPU Memory**: Observer CPUがSubject（Heroや他CPU）について持つPrivate Memoryです。他のCPUへ共有しません（CPU AのBへの仮説をCへ渡さない）。
- **Context**: Raw ObservationはCash / Tournamentで共通に使えますが、Strategy Hypothesisはcontext（cash / tournament）を分けます。
- **KnowledgeStateへの注入**: そのCPU自身が過去に得たObservation / Hypothesisだけを入れます（`docs/02` INV-INFO-001）。Promptへ渡す量を絞るときも、Evidence IDを失わない形にし、自然言語のMemoryを正本にしません。D121: 構造化したHypothesisの要約（Evidence ID付き、Subjectごとに上位5項目まで）をKnowledgeStateに足し、ClaudeのCPUはPromptで、RuleBotは決定論でこれを使います。LLMの呼び出しの回数・経路は増やしません。
- **Phase 7の暫定値（D118・D119。OI-005・OI-011）**: Fixed Poolはコードの Version付きConfigで、Fixed 8人＋Guestは1卓に最大1席です。Hypothesisのrecencyは、ObserverがそのSubjectを見たHandの数に応じた指数減衰（`phase7_memory_v1`。半減期150 Hand）、十分なSampleは機会数15以上（PersonaのSkillで0.5〜1.5倍）です。どれも永久仕様ではありません。
- **Private Hypothesisの実装（#138）**: `apps/server/src/memory/opponent-hypothesis.ts`が、ObserverのObservationからSubject × Contextごとに、観察可能な傾向の頻度（VPIP・PFR・3-bet・C-bet・Aggression Frequency等。EngineのStatsと同じ数え方）を、重み付きのnumerator / denominator・Evidence ID・十分か・PolicyのVersion付きで都度作ります。上のSkillの差は「十分なSample」の基準（`15 × (0.5 + Skill)`。重み付きの機会数で判定）で表し、不十分な項目は保留として扱います。形と規則は`docs/04` §12です。
- **KnowledgeStateへの注入の実装（#139）**: Hand Orchestratorが、Handの開始時に保存済みのHandだけから、座っているCPUごとにそのCPU自身のHypothesisの要約（`memory/memory-summary.ts`の`OpponentMemorySummary`。今の卓の他の参加者ごとに、席の`playerId`との対応・見たHandの数・上位5項目〔割合・機会の数・十分か・Evidence ID 3件まで〕）を作り、`KnowledgeState`に`memory`として足します（今のHandのSessionのmodeのHypothesisだけ。CashのHandは`cash`、TournamentのHandは`tournament`〔#188〕。形は`docs/04` §12）。ClaudeのCPUは、あるときだけ「あなたの記憶」の節で、固定の読み方の説明と構造化データのままのJSONを受け取ります（使い方の強さはPersonaの「相手への適応」「相手の読みの精度」に任せる。LLMの呼び出しの回数・経路は変えない）。RuleBotは同じ要約を決定論で使い、PersonaのSkill・Adaptability・Opponent Reading Qualityの平均に比例する幅（最大0.15）で、mediumの手のCallとPostflopのweakの手のBluffのしきい値だけをずらします（十分なSampleの項目だけ。`phase7_rulebot_memory_v1`。係数はOI-011の暫定値）。合法性はLegal Actionの中から選ぶことで守ります（D40）。

### Table Tendency（D106。#106 P7-6）

卓全体の傾向（aggression・looseness等）は、Public / 観察可能なEvidenceだけから作るProjectionです。個々のCPUのPrivate Memoryを集約して作りません。CPUが使える情報と、HeroのReviewが使える情報の境界を分けます。D10の「ユーザーが選ぶ卓の傾向（卓の編成）」とは別のものです。

HeroのReviewでの扱い（D122・#153）: Decision ReviewのEvidenceに、判断時点より前の保存済みのHandのpublicのEventだけから作ったTable Tendencyを構造化Evidence（Evidence ID付き）として足します。判断時点より後の情報・Learning-only Reveal・CPUのPrivate Memory / Private Hypothesis・Persona・Tiltは使いません。数値は決定論のコードが正本で、Review AIは説明だけを行います。

実装（#141。`apps/server/src/memory/table-tendency.ts`・`table-tendency-policy.ts`。数値と定義はすべてOI-011の暫定値で、確定ではない）:

- **作り方**: 今のSessionの保存済み（終わった）Handを論理順序（`ordinals.ord`）で並べ、`public`のEvent（Observationと同じwhitelist）だけから都度数えます（保存しない。D111）。Version付きのPolicy`phase7_table_tendency_v1`で、項目はviewer以外の席の`vpip`（looseness）・`pfr`・`aggression_frequency`（Postflopのaggression）と、卓全体の`showdown`（札を比べて決着したHandの割合）です。範囲はviewerが座っていたHandの新しい100 Handまでで、項目ごとにnumerator / denominator・Handの数・十分か（Handが10以上かつ機会が20以上）・PolicyのVersionを持ちます（形は`docs/04` §12）。壁時計を使いません（D117）。
- **境界**: CPUが使えるのは、そのCPUが座っていたHandのpublicのEventから作った値です（座っていないHandを入れない）。HeroのReviewが使える範囲は、Heroが座って見えたHandのpublicのEventから作った値で、入り口を分けます（`buildCpuTableTendenciesFromStore` / `buildHeroTableTendencyFromStore`）。どちらにもHidden Cards・Future Cards・Learning-only Reveal・Persona・Tilt・Private Hypothesisは入りません（`memory/table-tendency-isolation.test.ts`・`table-tendency.test.ts`）。
- **CPUへの反映**: Hand OrchestratorがHandの開始時に作り、数えたHandが1以上のCPUだけ`KnowledgeState`に`tableTendency`として足します。ClaudeのCPUは「卓の傾向」の節で、固定の読み方の説明と構造化データのままのJSONを受け取ります（Handが0のときは節ごと無く、Promptは#141より前と同じ文字列。LLMの呼び出しの回数・経路は変えない）。RuleBotは、PersonaのAdaptabilityに比例する幅（最大0.1）で、卓の`aggression_frequency`でmediumの手のCallを、卓の`vpip`でweakの手のBluffのしきい値をずらすだけです（十分なSampleの項目だけ。`phase7_rulebot_table_tendency_v1`）。合法性はLegal Actionの中から選ぶことで守ります（D40）。
- **HeroのReviewへの接続（#153）**: `ReviewService`がPass AのEvidenceを作るとき、判断のHandと同じSessionの、そのHandより前（論理順序。D117）に保存したHandだけを、Hero用の入り口`buildHeroTableTendencyFromStore`（`beforeOrd`にそのHandの`ord`）で数え、§6のOpponent Observationに入れます（そのHand自身・後のHand・別のSessionのHandは入らない）。十分な項目が1つも無ければ`unavailable`のままで、Evidence・Promptは#153より前と同じ文字列です（Review Evalの録画の指紋を変えない）。形とPromptでの扱いは§6です。Pass B（Reveal Review）のEvidenceには入れません（§7。Pass Bの契約は変えない）。

### 層の合成とOpponent Memory Eval（#106 P7-7。#142）

- **合成**: RuleBotは、Persona（固定の性格）・Tilt（§4のtransientな状態）・Table Tendency・Long-term Memory（Hypothesisの要約）を`composeTuning`（`apps/server/src/opponents/rule-bot.ts`）の1か所で、決まった順に合成します。順序は Persona → Tilt（PersonaのLooseness / Aggressionをずらしてしきい値を作り直す）→ Table Tendency（卓全体の傾向）→ Memory（相手ごとの傾向。卓全体より個別の相手の情報を後に当てる）です。最後に、確率のしきい値ごとに、Personaだけのしきい値からのずれを±0.2までに丸めます（`phase7_rulebot_composition_v1`。OI-011の暫定値）。今の6つのPresetと各層の上限（Tilt 3段・Table Tendency 0.1 × Adaptability・Memory 0.15 × 読みの強さ）では上限に届かないので、CashのHandでのPresetの判断は#141までと同じです（軸の大きいPersonaや、層の係数を上げたVersionで1つのしきい値がPersonaの性格から大きく離れないための上限）。TournamentのHandでは、Memoryの後にTournamentの層（§10「CPUのPublic Tournament Context」。#188）を当て、同じ上限で丸めます。合成は乱数を引かず、選ぶActionはLegal Actionの中からなので、Illegal / RandomなActionを作りません（D27・D40）。PersonaなしのRuleBotはどの層も読みません（D71の挙動のまま）。
- **Eval**: Memoryが戦略に効くこと・Fixed CPUの継続性・Guestの一時性・Personaの分布が潰れないこと・計算時間・Leakage 0を、RuleBotの決定論で測ります（APIキーを使わない。`docs/09` §5「Opponent MemoryのEval」）。ClaudeのCPUについては、Memory / Table Tendency / Tilt の節の入った新しい録画はまだ取っていません（APIの呼び出しが要るため）。

## 6. Review Evidence Model

Review AIへ渡す前に、以下を構造化します。

- Decision Context
- Math Evidence
- Range Evidence
- Opponent Observation Evidence
- Solver Evidence
- Knowledge Evidence
- User Read / Intent

AI文章はこの後に生成します。

Math EvidenceとRange Evidenceは、Engineの`analyzeDecision`（`packages/engine/src/decision-analysis.ts`。#79）が判断時点のHero Information Setだけから決定論で作ります（LLMに計算させない）。

- Math: 判断時点のPot・Call額・Pot Odds（計算は`pot-math.ts`の`potOdds` 1か所。KnowledgeStateの`math`・webのDealer Feedbackも同じ関数）・有効Stack・SPR。
- Range: Fold していない相手ごとに、Position（Buttonからの距離）とPreflopのAction列（open / limp / call_open / three_bet / call_three_bet / four_bet_plus / check_option / not_acted）で標準Rangeを選び、Heroの札と判断時点のBoardを除き（Card Removal）、PostflopのBet / Raise / Callごとに、そのStreetのBoardでの役の強さの上位を残す簡易モデルで絞ります（Drawは数えない）。標準Rangeと絞る割合はConfig（`range-config.ts`の`RangeProfile`）の暫定値で、永久仕様にしません。結果には必ずAssumption（どのRangeを仮定し、どう絞ったか）を付けます。
- Equity: 仮定したRangeに対するShowdownまでの勝率（`equity.ts`）。相手1人のFlop・Turn・Riverは全列挙、PreflopとMultiwayはseed固定のMonte Carloで、同じ入力から同じ結果になります。
- Alternative Action: Legal ActionからFold / Check / Call / Bet（Potの半分・Pot）/ Raise（最小・Pot Size）/ All-inを候補にし、Heroが実際に選んだ額を足して、それぞれの必要Equity・簡易EV（Foldを0とした差。Check / Callはこの後のBetが無い前提、Bet / Raiseは相手全員がCallする前提でFold Equityを含めず、Break-even Fold Frequencyを別に示す）を出します。簡易EVはAssumption付きの目安で、GTO / Solverの値として表示しません（D20）。
- 重要Spotでは`compareRangeProfiles`で標準・狭い（Tight）・広い（Loose）のRange想定ごとにEquityを比べられます（D08）。

Knowledge Evidenceは、Local KB（`apps/server/kb/`。#80・D98・`docs/03` §9）の`searchKb`が、判断時点のSpotの特徴（Street・Position・Player数・Spotの種類・相手のPreflopのAction列）と全文の語から決定論で返します。各項目のID・Version・KB全体のVersionを`evidenceId`としてEvidenceに残します。KBは概念とPracticalな指針で、Math / Range Evidenceの数値を置き換えません（数値の根拠はEngine）。`label`がHEURISTIC / EXPLOITの項目は経験則として書き、断定しません。

Evidenceの組み立て（#82。`apps/server/src/review/evidence.ts`）: 判断時点のHero Information Setだけを入力に、次の形でReview AIへ渡します（Event Log・`KnowledgeState`をそのまま渡さず、whitelistで写す）。各項目は`id`を持ち、Review AIは根拠に挙げた`id`を返します（実在しない`id`は不正）。

- Decision Context（`ctx:`）: Street・Blind・HeroのPositionと札・判断時点のBoard・Pot・各席の表示名（Heroの画面に出ている名前。CPU 3など。Personaは入れない。#96）/ Position / Stack / Commit / Fold / All-in（他者の札は持たない）・Public Actionの履歴・裁定の履歴・Legal Action・Heroが選んだAction・Important Spotの理由。
- Math（`math:`）: `analyzeDecision`の値（Pot・Call額・Pot Odds・有効Stack・SPR・Equity・Alternative Action・前提）。Monte Carloのseedは入れません。
- Range（`range:`）: 相手ごとのRangeのAssumption。Important Spotだけ、Rangeの想定（標準・狭い・広い）ごとのEquityの比較（`compareRangeProfiles`）。
- Opponent Observation（`tendency:<handId>/d<判断の番号>/<項目>`。D122・#153）: Heroが観察できた相手の傾向は、今はTable Tendency（§5）だけです。判断のHandより前に保存した、今のSessionのHeroが座っていたHandのpublicのEventだけから決定論で作り（そのHand自身・後のHand・Learning-only Reveal・CPUのPrivate Memory / Hypothesis・Persona・Tiltは入らない）、十分な項目（Policyの基準以上）が1つ以上あるときだけ`available`として`tableTendency`（Policyの版・数えたHandの数・項目ごとのid・割合・回数・機会の数・Handの数・十分か）を入れます。割合は`numerator / denominator`を決定論で小数第3位まで計算した値で、Review AIに計算させません。不十分な項目も`sufficient: false`のまま残し、保留として読ませます。十分な項目が無ければ`unavailable`のままで（Exploitは根拠なしとして書かせる）、Evidence・Prompt・Schemaは#153より前と同じ文字列です（Review Evalの録画の指紋が変わらない。`docs/09` §6）。あるときだけ、Promptに読み方（卓全体の傾向で個々の相手の傾向ではない／数値はEvidenceの値をそのまま使う／保留の項目は根拠にしない／特定の相手の傾向として断定しない。`review-ai.ts`の`TABLE_TENDENCY_GUIDE`）と項目の説明を添え、`exploitBasis`に`observation`を選べるようにします（構造ゲート）。数値は決定論のコードが正本で、Review AIは説明だけを行います。Groundingは、`exploitBasis`が`observation`なら、サンプルが十分な項目のidを1つ以上`evidenceIds`に挙げることを求めます（Review AIの文の中の数値をEvidenceと照合する検証はまだ無い）。idはReview AIが根拠に挙げてよいIDで、Review Recordの`evidence_ids.tableTendency`に残ります（`docs/04` §8）。今後Heroが観察可能だった範囲のStats（`docs/07` §3・§8）を入れるときも、Hidden Persona・Learning-only Reveal・CPUのPrivate Memory / Tiltは入れません。
  - 画面での扱い（#169）: Review（Pass A）の根拠の欄「卓の傾向（Table Tendency）」に、保存済みのReview Recordの`evidence.opponentObservation`をそのまま出します（APIは今までどおり保存済みのEvidenceを返すだけで、Evidenceを作り直さず、LLMを呼びません。画面で数え直さず、Review AIの説明文から値を拾いません）。項目ごとに、割合と分子 / 分母（`rate`・`numerator`・`denominator`）・機会があったHandの数・サンプルが十分か保留か（`sufficient`。色だけでなく文字でも示す）と、数えたHandの数（`hands`）を出し、説明が根拠に挙げた項目のidには「説明の根拠」の印を付けます。`unavailable`の記録（十分な項目が無い判断・#153より前のReviewを含む）は「卓の傾向はありません」とだけ出し、項目は出しません。CPUのPrivate Memory / Hypothesis・Persona・Tilt・Learning-only RevealはEvidenceに無く、画面にもAPIの応答にも出しません（Pass Bの画面とは混ぜません）。
- Solver（`solver:`）: Capability Gateを通って解けたときだけ`supported`（`docs/03` §7）。それ以外はUnsupported / 当てはまらないNode / 失敗の理由を前提として渡します。
- Knowledge（`kb:<KB Version>:<id>@<version>`）: 判断時点のSpotの特徴（Street・HeroのPosition・Heads-Up / Multiway・Spotの種類・相手のPreflopのAction列）で`searchKb`した上位4項目。
- User Read / Intent（`read:<handId>/<seq>`。#115・D112）: その判断の`ACTION_TAKEN`より前にHeroが記録した読み（`docs/07` §8）を、Street・対象の席（`playerId`と表示名）・本文と一緒に`collected`として入れます（Information Setの`userReads`。判断より後の読みは入らない。`docs/04` §1）。読みが無い判断は`not_collected`のままで、Evidence・Prompt・Schemaは読みの無いHandと同じ文字列です（Review Evalの録画の指紋が変わらない。`docs/09` §6）。読みがあるときだけ、Promptに「読みはHeroの主張で、相手の観察の記録ではない／判断が読みに沿っているか・判断時点の公開情報と整合するかをpracticalで触れる／読みの当たり外れは書かない」の扱い方を添えます（構造ゲート。`review-ai.ts`の`USER_READ_GUIDE`）。読みのIDはReview AIが根拠に挙げてよいIDで、Review Recordの`evidence_ids.userRead`に残ります（`docs/04` §8）。Exploitの根拠（`observation`）にはしません。Review Interview（§12）で後から聞く経路はまだありません。
- Tournament（`tournament:` / `icm:` / `chipev:` / `icmreq:`。D109・D130・#189）: TournamentのHandの判断だけが持ちます（CashのEvidenceは項目ごと持たず、Evidence・Prompt・Schemaは#189より前と同じ文字列。Review Evalの録画の指紋が変わらない）。公開の状況（`tournament:<handId>/d<判断の番号>`。参加人数・残人数・Level・Sessionの何Hand目か・Anteの種類と額・Prize Pool・順位ごとの賞金・Stage）、判断時点の全席のICM Equity（`icm:`。席ごとのICMに使ったStack・BB換算・pt・%）、All-inの関わる判断だけChip EVの必要EquityとICMの必要Equity（相手ごとに`chipev:<…>/<相手>`と`icmreq:<…>/<相手>`の別のid。Fold・勝ち・負けのHeroのStackとICM Equity・前提）を入れます。作り方と暫定Policyは§10「TournamentのReview（#189）」です。

**内部の識別子を文に出さない**（#96・D101）: Reviewは Hero が読む学習用の文なので、`cpu3` のようなplayerIdや`inAssumedRange=false`のようなEvidenceの項目名を、そのまま出しません（内部実装を前面に出さない方針。`docs/06` §11）。対策は3段で、①Evidenceの席に表示名を添える、②Promptで識別子を書かないよう指示し、「Evidenceの項目の説明」（項目名 → 自然な言葉。`apps/server/src/review/identifiers.ts`の`EVIDENCE_TERMS`が1か所の正本。Pass Aには判断時点の項目だけ、Pass Bにはreveal側の項目も出す）を添える、③出力の文を保存の前に機械的に置換する（playerId → 表示名、項目名 → 説明、`monte_carlo`のような値 → 書き方。根拠のidとenumは触らない）。識別子が見つかっても**Retryはしません**（言い直しを求めても残ることがあり、呼び出しと利用枠が増えるだけのため）。置換するのは対応表にある既知のものだけで、未知の識別子は残り、Review Evalの「識別子の残存率」で数えて対応表に足します（`docs/09` §6）。Pass B・Follow-upにも同じ置換を通します。

Evidenceに他者のHidden Cards・未来のCard・`system`のEvent・CPUのPersonaが入らないこと、判断より後のEventを切り落としても見えないEventの中身を差し替えてもEvidenceが変わらないことをテストで確かめます（`evidence.test.ts`）。Table Tendencyが判断のHandより前のHandのpublicのEventだけから作られること（後のHand・別のSession・見えないEventの差し替え・Pass Bの有無で変わらない）・CPUのMemory / Tilt / PersonaがReviewのPromptに入らないことは、`review-table-tendency.test.ts`と`memory/table-tendency-isolation.test.ts`で確かめます。

## 7. Two-pass Review

### Pass A — Decision Review

判断時点で利用可能だった情報だけを使います。

入力の元は、Engineの`heroInformationSets`（#78）が作る判断時点のHero Information Setです（判断時点までにHeroに見えたEventとHeroのKnowledgeState。作り方は`docs/04` §1）。前のHandから作るTable Tendency（§5・§6。D122）は、判断のHandより前に保存したHandのpublicのEventだけから作ります。Reviewの対象にするImportant Spotも、判断時点の情報だけから決定論で選びます（`extractImportantSpots`）。

### Pass B — Reveal Review

Hand終了後にActual Hole Cardsを見せます。

用途:
- 読みと実際の比較
- Actual Hand Equity
- Bluff / Valueの答え合わせ

Pass Bの情報を理由にPass Aを勝手に変更しないでください。

全員の札は、Pass Aの入力とは別のProjection `projectLearningReveal`（#78。`docs/04` §4）から取ります。

実装（#83。`apps/server/src/review/reveal-evidence.ts`・`reveal-ai.ts`・`generate-reveal.ts`）: Pass BのEvidenceは、Pass Aと同じ判断時点のDecision Contextに、次を決定論で足したものです（LLMに計算させない）。

- 読みと実際の比較（`reveal:`）: 相手ごとの実際の札と、判断時点でFoldしていなかった相手は、判断時点に仮定した標準のRange（Pass AのRange Evidenceと同じ作り方）と、実際の札がそのRangeに入っていたか・判断時点のBoardでの役。
- 実際のEquity（`equity:`）: 判断時点のBoardからの、Potを争っていた相手の実際の札に対するHeroの勝率と、判断時点に仮定したRangeに対する勝率。
- Bluff / Valueの答え合わせ（`aggression:`）: 判断時点までのBet / Raiseと、Heroの判断がBet / Raiseならその判断の、本人の実際の札の、その時点でPotを争っていた残りの相手の実際の札に対するEquity。公平な取り分（1 / 人数）以上ならvalue、未満ならbluff（暫定の基準。Evidenceに基準の文を添える）。

Review AIは評価（Assessment）を出さず、`readComparison`（読みと実際の比較）・`actualEquity`・`bluffValue`・`takeaways`（次に活かす点）だけを書きます。Promptで、判断の評価はPass Aで済んでいて結果を理由に付け直さないこと、1 Handの結果でRangeの想定を断定しないことを指示します。Pass Bは`reveal_reviews`に別のVersionの列として保存し、Pass Aの`reviews`は変えません（`docs/04` §8）。Pass BのEvidenceはCPUの入力・Pass Aの入力に渡しません（INV-TEST-008。`docs/09`）。

### Follow-up Q&A

Heroは、PassとVersionで指定したReviewに続けて質問できます（#83。`apps/server/src/review/followup.ts`）。答えの根拠は、そのReviewのEvidenceと説明だけです。Pass Aへの質問のPromptにはPass AのEvidence（判断時点の情報）しか入らないので、Hand後の情報（相手の実際の札・結果）は混ざりません。範囲の指示はPassごとに文で出し分け（Pass Aは「Hand後の情報は知らない。聞かれたら`out_of_scope`にしてReveal Reviewで確かめられると答える」、Pass Bは「結果で判断の評価を付け直さない」）、Evidenceで答えられない質問は`out_of_scope`にさせます。複数ターンは、同じVersionのこれまでの質問と答えを古い順にPromptへ入れ、1回の単発の問い合わせで呼びます（D87）。答えの検証はSchema（`scope`・本文・件数）→ Grounding（`answered`なら根拠のidが1つ以上で、すべてそのReviewのEvidenceに実在する）の順で、不正なら1回だけ再要求し、2回続けて不正なら答えずに（`unanswered`）失敗を残します。履歴はReviewのVersionに紐づけて`review_followups`に保存します。

## 8. Assessment Style

一つのActionにFake Precisionな点数をつけるより、段階評価を基本にします。

例:

- Strong
- Reasonable
- Mixed / Marginal
- Improvement Suggested
- Major Leak
- Insufficient Evidence

併記:

- Confidence
- Assumptions
- 何が変わると結論も変わるか

実装（#82。`apps/server/src/review/review-ai.ts`・`generate.ts`）: Review AIは構造化出力で`assessment`（`strong` / `reasonable` / `mixed_marginal` / `improvement_suggested` / `major_leak` / `insufficient_evidence`）・`confidence`（`low` / `medium` / `high`）・`assumptions`・`conclusionChangers`（何が変わると結論も変わるか）・`evidenceIds`と、§9の順の説明（`practical` → `theory` → `exploit`）を返します。検証はSchema（形・enum・文字数・件数）→ Grounding（`evidenceIds`がEvidenceに実在する・Solverの結果が無いのに`theory.basis: solver`を選ばない・Observationが無いのに`exploit.basis: observation`を選ばない）の順で、不正なら理由を付けて1回だけ再要求し、2回続けて不正ならInsufficient Evidenceにします。根拠が足りない（判断時点の卓が読めない・EquityもSupportedのSolverの結果も無い・KBの項目が無い）ときは、Review AIを呼ばずにInsufficient Evidenceにします（Evidence Sufficiency Gate。§11のWebへは進まない。D94）。TournamentのHand（#189）では、Groundingが「All-inの判断（ICMの必要Equityがある）ならICMの必要Equityのid（`icmreq:`）を1つ以上挙げる」も検査し、Gateは「TournamentのAll-inの判断でICMの必要Equityを計算できない（MultiwayのAll-in等）」も根拠不足にします（`tournament_icm`。Chip EVだけで評価させない。§10）。

## 9. Practical / GTO / Exploitの順序

標準説明:

1. 実戦的なBaseline
2. 必要に応じてGTO / Theory
3. EvidenceがあればExploit Adjustment

「GTOでXだから常にXが正しい」と教えないでください。

## 10. Solver利用

MVPから実Solverを組み込みます。

原則:

- Capability Matchしてから使用
- Unsupportedは正常系
- Range Assumptionを明示
- MultiwayをHUのExact Truthとして扱わない
- SolverはEvidenceの一つ

Session Deep Analysisでは通常Reviewより重いSolveを使っても構いません。

### TournamentでのSolverとReview（Phase 8。D109・#107）

- Push/Fold Nash Solver等のTournament SolverはPhase 8の初期Scope外です。Tournamentでも、対応するSolverが無いSpotは正常な非対応として扱います。
- Decision ContextにTournamentの公開情報（残人数・Blind Level・StackのBB換算・Payout・Placement）を足します。
- ICMは決定論のICM Calculator（2〜8人）が計算し、Chip EVとは別のEvidenceとして渡します。Review AIはICMを説明しますが、数値の正本になりません（LLMにICMを計算させない）。
- Pass A / Pass Bの情報境界は変えません（判断時点の情報だけでPass Aを作る）。
- Important SpotにBubble / Pay Jump / Short Stack等を足せるようにします。
- ICMのEvidenceの粒度（D130）: 判断時点のICM Equityを常にEvidenceとして出し、All-inが関わる判断（Shove・All-inへのCall）ではChip EVの必要Equity（Pot Odds）とICMの必要Equityを別の項目として並べます。どちらにもEvidence IDを付けます。All-inへのCallはそのまま計算し、Shoveは「特定の1人にCallされ、ほかはFoldした場合」の条件付きの値をCallしうる相手ごとに出します（Fold Equity・Callの頻度は含めない）。この前提はEvidenceと画面に明記し、Review AIへ前提ごと渡します。
- CPUのPublic Tournament Context（D130。`docs/02` §7）: 全席のStackとBB換算・ICM Equity・Stage・自分から見た相手ごとのBubble Factor。CashのKnowledgeState / Promptは変えず、Tournamentのときだけ足します。
- CPUのMemory: TournamentのHandのObservationは`tournament`のcontextで抽出し、TournamentのHandではそのcontextのStrategy Hypothesisを使います（D106。Raw Observationは共通・Hypothesisは分離）。Private Memoryの分離とLearning-only Revealを入れない規則は変えません。
- CPUのPublic Tournament Contextの実装（#188。形は`docs/04` §5・§12、値の規則は`docs/02` §7）:
  - **作り方**: Engineの`tournamentKnowledgeOf`（`packages/engine/src/tournament-knowledge.ts`）が、publicの`HAND_STARTED`とSessionの設定のSnapshot・参加人数だけから、Handの開始時の公開のStackでICM Equity・Bubble Factorを計算します。Hand OrchestratorはTournamentのHandでだけSessionの情報を渡し、Cashの`KnowledgeState`・Prompt・RuleBotの判断は#188より前と同じです（既存のOpponent Evalの録画の`paramsHash`も変わらない）。
  - **Claude のCPU**: TournamentのHandだけ、System Promptの1行目をトーナメントの卓にし（2行目以降はCashと同じ）、「トーナメントの状況」の節に固定の読み方の説明と構造化データのJSONを入れます（この Handの情報の節の直後）。JSONのBB換算・ICM Equity（ptと%）は小数第1位、Bubble Factorは小数第2位に丸めます（表示の丸め。`KnowledgeState`の値は丸めない）。説明は「計算済みの値を計算し直さずに使う」とし、ICMをLLMに計算させません。Persona の節があるときだけ「リスク許容度」「規律」に合わせる1行を足します。Memoryの節には、`tournament`のcontextのときだけ「トーナメントのHandだけから数えた傾向」の1行を足します。Push/FoldのRange・Solverの結果は渡しません（D130）。LLMの呼び出しの回数・経路は変えません。
  - **RuleBot**（`phase8_rulebot_tournament_v1`。OI-007の暫定Policy。人間判断を経ていない）: この Streetで最後に額を引き上げた相手（自分以外。同額までのAll-inは除く）とのBubble Factorが1より大きいときだけ、mediumの手のCallのしきい値を`Skill × 0.15 × min(1, (Bubble Factor − 1) ÷ 1)`下げます（ICMを知る強いCPUほど、負けの痛みが大きい相手のBetにCallを絞る）。ほかのしきい値・参加Range・Bet額は変えず、乱数を引かず、Legal Actionの中から選びます（D40）。PersonaなしのRuleBotは読みません（D71）。合成はMemoryの後（§5「層の合成」）で、Persona だけのしきい値からのずれの上限（±0.2）に入ります。Shove / CallのRange（Push/Fold Solver）は使いません。
  - **TournamentのReview（#189。`apps/server/src/review/tournament-evidence.ts`。組み立ての版`phase8_review_tournament_v1`）**:
  - **入力**: 判断時点のHero Information Set（判断時点までにHeroに見えたEventと`KnowledgeState`）と、Sessionの設定のSnapshot・参加人数（Sessionの最初の保存済みのHandの`SESSION_STARTED`と`HAND_STARTED`から読む。`tournament-session-info.ts`）だけです。他者の札・判断より後のEvent・Learning-only Reveal・CPUのPrivate Memoryは入力の経路に無く、判断より後のEventを切り落としても見えないEventを差し替えても値は変わりません（`review/tournament-evidence.test.ts`）。Pass B（Reveal Review）にICMのEvidenceは足しません（Decision ContextのImportant Spotの理由はPass Aと同じ）。
  - **ICM Equity（常に）**: 判断時点の各席の手元のStackにこのHandで出した額を戻したStack（Potの行方は決めない。誰のCommitにも数えない`big_blind_ante`のAnteは誰にも戻さない）で、EngineのICM Calculator（`icmEquities`）が計算した全席の値です（OI-007の暫定Policy。CPUのContextはHandの開始時のStack）。
  - **All-inの必要Equity（D130）**: Heroが判断の後の額で相手の誰の額も超えてAll-inし、Callできる相手がいればShove（`icmShove`。Callしうる相手ごと）、All-inした相手に直面している・CallするとHeroがAll-inになる・足りない額のAll-inならAll-inへのCall（`icmCallAllIn`。FoldしていないうちこのHandで出した額が最も大きい相手）です。Shoveの比較点（HeroがFoldした場合）でPotを取るPlayerは、FoldしていないうちこのHandで出した額が最も大きい相手（同じ額が複数なら最後にBet / Raiseした相手、それも無ければ席順で先）とします（OI-007の暫定Policy）。前提（ほかはFold・Fold EquityとCallの頻度を含めない・比較点でPotを取るPlayer）は構造化した値と文の両方でEvidenceに入れます。ICM Calculatorが拒否するSpot（MultiwayのAll-in・All-inした相手がいるShove等）は`out_of_scope`で、Evidence Sufficiency GateがReview AIを呼ばずにInsufficient Evidenceにします（`tournament_icm`。Chip EVだけで評価するとICMを無視した評価になるため。OI-007の暫定Policy）。
  - **丸め**: Evidenceに出すときだけ、pt・%・BB換算・必要Equity（%）を小数第1位に四捨五入します（`docs/02` §7）。数値は決定論のコードが正本で、Review AIは説明だけを行います。
  - **Prompt（構造ゲート）**: TournamentのEvidenceがあるときだけSystem Promptの1行目をトーナメントにし（2行目以降はCashと同じ）、「トーナメントの状況（tournament）の扱い」（ICMは計算済みの値で計算し直さない・Chip EVとICMを混同しない・Push / FoldのRangeは渡していない）とTournamentの項目の説明を添えます。All-inの判断ではChip EVとICMの必要Equityを並べて比べる・前提をassumptionsに書く・ICMの必要Equityのidを挙げる節を、Shoveではさらに「条件付きの値でFold Equity・Callの頻度を含まない。推測で数値にしない」節を足します（`review-ai.ts`の`TOURNAMENT_GUIDE` / `TOURNAMENT_ALL_IN_GUIDE` / `TOURNAMENT_SHOVE_GUIDE`）。Pass AへのFollow-upにも、TournamentのEvidenceがあるときだけ1行目・読み方・項目の説明を出します。
  - **Grounding**: All-inの判断（ICMの必要Equityがある）では、`evidenceIds`にICMの必要Equityのid（`icmreq:`）を1つ以上求めます（Chip EVのidだけでは不正）。Reviewの文の中の数値の照合は入れません（D125）。
  - **Important Spot**: Engineの`tournamentImportantSpotReasons`（`packages/engine/src/hand-summary.ts`。規則の版`phase8_tournament_spot_v1`。OI-007の暫定値）が、`bubble`（Stageがbubble）・`pay_jump`（残りの全員が入賞し、3人以上が残り、1つ上の順位の賞金が多い）・`short_stack`（HeroのStack〔判断時点の手元 + このHandで出した額〕が10BB以下）を、CashのImportant Spotの理由に足します（TournamentのHandだけ。Cashの理由は変えない）。Replay・Hand Summary・Session ReviewのImportant Spotはまだ足していません（画面は#190）。
  - **Solver**: Capability Gateに`mode: tournament`で渡し、Cashだけを解くSolverは`unsupported`（`mode`）の正常なFallbackになります（Multiway・Flop・Preflopは今までどおりの理由）。
  - **Review Eval**: Tournamentの代表の判断（BubbleのShove・BubbleのAll-inへのCall）を足しましたが、実モデルの録画はまだありません（`docs/09` §6）。
- **境界**: `memory/tournament-isolation.test.ts`が、Fakeの`query()`でCashのSession（Pass A・Pass Bを作る）の後にTournamentのSessionを進め、CPUの全Promptで、Tournamentの節がTournamentのHandにだけあり公開のHandの開始時のStackとSessionの設定の値だけであること・TournamentのHandのMemoryが`tournament`のcontextで、EvidenceがObserver自身の座ったTournamentのHandのSubjectのpublicの`ACTION_TAKEN`だけであること（CashのHandのHypothesisを混ぜない）・他者の札・Learning-only Reveal・Heroの弱点・他CPUのPersonaが出ないことを確かめます。実モデルのEval・録画はしていません（OAuthの利用枠を使う判断は人間判断。Promptの確認は決定論のテスト）。

## 11. Web Fallback

毎HandでWeb検索しません。

順序:

```text
Local KB
 ↓
Math / Solver
 ↓
Evidence Sufficiency
 ├─ Enough → Review
 └─ Insufficient → Web
```

Web EvidenceでRecommendationが大きく変わる場合、Source / Provenanceを保持します。

## 12. Review Interview

ログだけでは評価が揺れる場合、Heroへ質問できます。

例:

- 当時VillainをValue-heavyと見ていたか
- Bluffがどの程度含まれると考えたか
- BetのTarget Handは何だったか
- Pot OddsでCallしたのか、Player Readだったのか

すべてのHandで質問しないでください。

## 13. Model Routing

初期Role:

- `opponent_fast`: Haiku級
- `review_standard`: Sonnet級以上
- `review_deep`: コスト許容範囲の高性能Model

Concrete ModelはConfigで変更可能とします。
