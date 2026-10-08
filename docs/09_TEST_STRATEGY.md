# テスト戦略

## 1. 優先順位

最優先は**決定論的なPoker Engineの正しさ**です。

AIの戦略は多少不完全でもよいですが:

- Chip Accounting
- Legal Action
- Pot Distribution
- Hidden Information Isolation

は壊れてはいけません。

## 2. Poker Engine Unit Test

最低限:

- Hand Ranking
- Tie
- Deck Uniqueness
- Deal
- Blind / Ante
- Action Order
- Fold / Check / Call / Bet / Raise
- Minimum Raise
- All-in
- Short All-in
- Reopening
- Side Pot
- Split Pot
- Button Movement
- Heads-Up

## 3. Invariant Test

### INV-TEST-001

同じCardが同時に二か所へ存在しない。

### INV-TEST-002

Rake / Rebuy / Top-up等の明示操作を除き、Chip総量が勝手に増減しない。

### INV-TEST-003

FoldしたPlayerへ同Hand中に再度Actionを要求しない。

### INV-TEST-004

Playerは自分のStackを超えてChipをCommitできない。

### INV-TEST-005

配分されたPot総額 = Rake等控除後のDistributable Pot。

### INV-TEST-006

合法なActorだけがCanonical Actionを実行できる。

### INV-TEST-007

Opponent KnowledgeStateに他PlayerのHidden Cardsが含まれない。

### INV-TEST-008

Learning-only RevealがCPU Memoryへ入らない。

CPU Memoryができるまでは、Learning-only Full Reveal（`projectLearningReveal`）でだけ見える札が、どのCPUの`KnowledgeState`（Handの全prefix）にも、判断時点のHero Information Set（Pass Aの入力）にも入らないことで確かめます（`packages/engine/src/hand-summary.property.test.ts`。#78）。Runtime側（#83）では、Hand 1のPass B（全員の札をReview AIに渡す）とそのFollow-upを作った後にHand 2を続け、両HandのClaude OpponentのPromptに入る札がその時点でそのCPUが知ってよい札だけであること・Learning-onlyの印が無いことを確かめます（`apps/server/src/review/learning-reveal-isolation.test.ts`）。Pass Aへの質問（Follow-up）のPromptに、判断時点のHeroが知り得ない札が入らないことも確かめます（`review/reveal.test.ts`・`routes/reviews.test.ts`）。CPU Memory（Phase 7。#139）ができてからは、Pass A / Pass Bを作った後に複数のSessionを進め、ClaudeのCPUの全PromptのMemoryの要約がObserver自身の座っていたHandのpublicのActionだけをEvidenceに持ち、Learning-only Revealの札・文・Heroの弱点のHypothesis・前のSessionのGuestが入らないことも確かめます（`apps/server/src/memory/memory-injection-isolation.test.ts`）。CPUのTilt（Phase 7。#140）は、2つのSessionを進めたClaudeのCPUの全Promptで、Tiltの節がそのCPU自身の席の値だけであること・次のSessionが0から始まること・ReviewのPrompt・Heroへの応答・Event LogにTiltが出ないことを確かめます（`apps/server/src/opponents/tilt-isolation.test.ts`）。Table Tendency（Phase 7。#141）は、Sessionを進めたClaudeのCPUの全Promptで、卓の傾向の節がそのCPUが座っていた、そのHandより前に保存したHandのpublicのEventから作った値だけであること（Handが0なら節が無い）・ReviewのPromptの卓の傾向（D122・#153）がHeroが座って見えた、判断のHandより前に保存したHandのpublicのEventから作った値だけで（十分な項目が無ければ入らない）、CPUのMemoryの要約・Tilt・Persona・PoolのIdentityが入らないこと・Review以外のHeroへの応答とEvent LogにTable Tendencyが出ないこと、Table TendencyのモジュールがHeroの弱点・CPUのPrivate Hypothesis / Memoryの要約・Tiltのモジュールに届かずLearning-only Revealを参照しないことを確かめます（`apps/server/src/memory/table-tendency-isolation.test.ts`）。見えないEvent（Hole Cards・Deck・`system`）を差し替えても結果が変わらないこと・時計が後ろへ戻った記録でも結果が変わらないことは`memory/table-tendency.test.ts`です。

## 4. Scenario Regression

固定Scenario:

- Standard Heads-Up
- Standard 6-max
- Multiway All-in
- 3-way Side Pot
- Short All-inでReopenしないCase
- 累積Short Raise
- Odd Chip Split
- Heads-Up移行
- Oversized Chip
- String Raise
- Representative Out-of-Turn

## 5. AI Opponent Eval

Poker Engine Correctnessとは別に評価します。

測定:

- Structured Output Valid率
- Illegal Action率
- Retry率
- Latency
- Persona Differentiation
- Action Diversity
- 明らかなStrategic Incoherence
- Hidden Information Leakage

代表Spotを固定Regression Caseとして持ちます。

### 実装（Issue #53）

- **置き場所**: `apps/server/src/testing/opponent-eval/`（buildの対象外）。`spots.ts`（代表Spot）・`harness.ts`（判断を集める）・`metrics.ts`（集計・合格ライン）・`recording.ts`（録画と再生）・`run.ts`（手動実行）。
- **代表Spot**（`spots.ts`）: 本番の既定の卓（6-max・100BB・playerIdも本番と同じ）で、積んだDeckと決めたActionの列でEngineを判断の直前まで進めた単発の局面です（CPU同士でHandを頭から進めると前の判断のブレで局面が揃わないため）。入力は本番と同じく`projectKnowledgeState`と`getLegalActions`から作ります。`preflop_open`（UTGで最初にOpenするか。KTo）・`preflop_facing_3bet`（UTGのOpenにBTNが3-bet。AQo）・`flop_cbet`（COのOpenにBBがCallしCheck。AJo・K72r）・`river_facing_big_bet`（Riverで Pot 23に26のBet。QJsのトップペアだった手）の4つです。
- **本番と同じ経路**: CPUは本番のFactory（`createClaudeOpponentFactory`）でそのCPU自身のPersonaだけを入れて作り、出力は`checkOpponentOutput` → `applyAction`で検証し、不正なら理由を付けて1回だけ再要求・2回続けて不正ならFallback（§5の流れ。Orchestratorの`cpuTurn`と同じ）。差し替えるのはSDKの`query()`だけです。
- **手動の Eval**: `pnpm --filter @proj-poker/server eval:opponent [--repeats 3] [--concurrency 1] [--record]`。Claude CodeのOAuth（サブスク枠。D87）で4 Spot × 6 Persona × 繰り返しの判断を集めて指標と合格ラインを表示し、`--record`で録画（`recordings/opponent-eval.json`）に書きます。障害が1件でもあれば録画しません。
- **CI**（`harness.test.ts`）: Claudeを呼ばず、録画した出力を本番と同じ経路で再生して集計し直し、録画時の集計と一致すること・Hidden Information Leakageと障害が0件であることを確かめます。録画は判断ごとに渡した引数（Prompt・Options）の指紋を持ち、Prompt・Persona・Schema・単発化の設定が変わると再生が失敗します（手動のEvalで録画を取り直す）。KnowledgeStateに入るRule ProfileのID（`ruleProfile`）もPromptの引数に含まれるので、`spots.ts` は本番と同じPreset（`PHASE1_CASH_PRESET`。IDは `phase4_provisional_v1`）でSpotを始め、PresetのIDを上げたら録画を取り直します（#63でIDを上げた間は旧IDに固定し、#68で取り直して戻した）。

指標の定義（`metrics.ts`）:

| 指標 | 定義 | 合格ライン（暫定） |
|---|---|---|
| Structured Output Valid率 | 呼び出し（Retryを含む）のうちSchemaの検証を通った割合 | 0.95以上 |
| Illegal Action率 | 呼び出しのうちSchemaは通ったが、今選べないAction・範囲外の額・Engineの拒否だった割合 | 0.05以下 |
| Retry率 | 判断のうち1回目が不正で再要求した割合 | 0.1以下 |
| Fallback率（参考に追加） | 判断のうち2回続けて不正で、本番ならRuleBotのFallbackになる割合 | 0.02以下 |
| Latency | 呼び出しごとの所要時間（子プロセスの起動を含む）のmin / median / p90 / max | 表示のみ（上限は`OPPONENT_TIMEOUT_MS`。OI-001） |
| Persona Differentiation | Spotごとに、Personaの組の最終Actionの種類の分布の差（Total Variation Distance。0〜1）を平均し、Spotで平均したもの | 0.2以上 |
| Action Diversity | Personaごとに、全Spotの最終Actionの種類のShannon Entropy（bit） | 表示のみ |
| Hidden Information Leakage | CPUの入力（Card・Deck・seed・Persona）か実際に送ったPrompt（知ってよい札以外のCard表記・他のPresetの名前）に、知ってはいけない情報が入っていた判断の数 | 0件（1件でも不合格） |

- 合格ラインは測定の前に決めた暫定値で、Persona・Promptの見直し（Playtest）と合わせて見直します（永久仕様ではありません）。CIで落とすのはHidden Information Leakageと障害だけで、その他は手動のEvalで表示します（録画は一回分のスナップショットのため）。
- **明らかなStrategic Incoherence**はJudge（人間かLLM）が要るため、まだ測りません（`llm-quality-improvement`のJudgeの設計で扱います）。

### Opponent MemoryのEval（Issue #142）

RuleBotの決定論だけで回し、ClaudeもAPIキーも使いません。CI（`pnpm test`）で回るのは`apps/server/src/testing/opponent-eval/memory-eval.test.ts`で、向き・境界だけを判定します。分布と計算時間の値は手動の`pnpm --filter @proj-poker/server eval:opponent-memory [--hands 200,200] [--repeats 5]`（`memory-run.ts`）で表示し、作業ログに残します。

- **代表Spotと層の条件**（`memory-eval.ts`）: 上の代表Spot（本番と同じ`projectKnowledgeState`の入力）に、本番と同じ形の`memory` / `tilt` / `tableTendency`を足した入力で、6つのPersona × 400 seedのRuleBotの判断を集め、Engineで合法かを確かめます。条件は、層なし・Memory（Subjectが Loose / Tight・保留）・Tilt 3段・卓が緩い / 締まっている・3つの層を同じ向きに最大で足したもの、です。
- **(1) Memoryが戦略に効く**: `river_facing_big_bet`（QJsのトップペアでPotを超えるBetに直面）で、攻める（Loose）相手と分かっていればCallが増え、攻めない（Tight）相手なら減る。`flop_cbet`（AJoでC-betするか）で、C-betによく降りる（Tight）相手にはBluffのC-betが増え、降りない（Loose）相手には減る。Persona ごとに向きが逆にならず、全Personaの合計で向きどおりに動き、保留（Sample不足）のMemoryでは変わらないこと。
- **(2) Fixed Poolの継続性・(3) Guestの一時性・(6) Leakage 0**: 本番のHand Orchestrator（RuleBot・メモリ内のEvent Store・既定の6人卓）で2つのSession（60 Hand + 20 Hand。区切りはCPUの障害 → Session終了の本番の経路）を進め、CPUに渡った入力をそのまま記録します。両方のSessionの同じ席にGuestが座るseedを選びます。
  - 層の値は、Orchestratorと同じ入力で作った値とCPUに渡った値が一致する（評価ハーネスと本番の組み立ての一致。LC-050）
  - 両方のSessionに座ったFixed CPUは、Session 2の最初の判断からSession 1の観察（Evidence）をMemoryに持ち、Session 2でMemoryの有無でしきい値の変わる判断がある
  - Session 1のGuestはSessionの中でMemoryを積むが、Session 2の誰のMemoryにもSubjectとして出ず、同じ席の新しいGuestのMemoryは空から始まる
  - どのCPUの入力にも、知ってよい札以外のCard・Deck / seed / `system`のEvent・Persona・Reveal・Heroの弱点が無く、層を除いたKnowledgeStateはEngineのProjectionと同じ。MemoryのEvidenceはそのCPU自身が座っていたHandだけ（Session 1にいなかったFixed CPUがSession 2にいることも確かめ、検査を空振りさせない）
- **(4) Action Diversity・Strategic coherence**: どの条件でも、Illegal 0・Checkできるのに Fold 0、Persona Differentiation（上の表と同じ定義）とPersonaごとのAction Diversityが層なしの0.75倍以上、攻撃性（Bet / Raiseの割合）の順序（Maniac > Nit・LAG > Nit・Maniac > Calling Station）が保たれること。合格ラインは測定の前に決めた暫定値です（OI-011。`MEMORY_EVAL_TARGETS`）。
- **(5) Latency**: 同じOrchestratorの実行で、Handの開始時のMemory・Tilt・Table Tendencyの計算時間（CPU全員分）を保存済みのHandの数ごとに記録します。CIでは値の大きさを判定しません（実行環境で変わる）。
- **時計が後ろへ戻った記録（D117）**: 記録時刻が保存の順と逆に並ぶEvent Storeと、進む時計のEvent Storeで同じSessionを進め、CPUに渡る合成の入力（Memory・Tilt・Table Tendency）と判断が同じであること。
- **ClaudeのCPU**: 既存の録画（`recordings/opponent-eval.json`）の再生が通り続けることだけを確かめます（代表Spotの入力には層が無いので、Promptの指紋は変わらない）。Memory等の節の入ったPromptの録画は、APIの呼び出しが要るので取っていません。

## 6. Review Eval

確認:

- Pass AにHindsight Leakがない
- Mathが正しい
- Solver Capability Gateが動く
- KB / Source Grounding
- Uncertaintyの表現
- Hidden CPU SettingをEvidenceに使わない
- Assumption変更でRecommendationが適切に変わる

Human-reviewed HandをRegression Caseにします。

Math / Equity / Range（#79。Engineの決定論のテスト）:

- Equityは手計算できる既知の値と照合します（River・Turn・FlopのHand vs Handは全列挙の分数、PreflopのAA vs KK ≈ 82%などはseed固定のMonte Carloで許容幅つき）。全列挙のHand vs HandはEquityの和が1になることをProperty Testで確かめます。
- 速い役の強さ（`handScore`）は、Hand Evaluator（`evaluateHand`）の`score`と一致することをProperty Testで確かめます。
- 性能の上限: Flopの手札 vs Range（全1326 Comboの全列挙を含む）・PreflopとMultiwayのMonte Carloを、それぞれ500ms以内で終えることをテストで守ります。
- Decision Analysisは判断時点のInformation Setだけを入力にし、相手の実際の札・判断より後のBoardとActionを変えても結果が変わらないことを確かめます（Pass AにHindsight Leakがない）。

Local KB（#80。`apps/server/src/kb/`のテスト）:

- **Metadataの検証**: 必須項目の欠け・未知のTopic・未知の項目名・idとファイル名の不一致・実在しないdate・1未満のversion・書式の違うsourceなどを弾くことをテストで確かめます。実物のKB（`apps/server/kb/`）が全項目で検証を通り、sourceが`docs/research`の実在するファイル・節と`SOURCES.md`の見出しを指すこと、使っていないTopicが無いこと、本文が参照する項目IDが実在すること、1項目が研究資料の丸写しにならない長さであることも確かめます。
- **KB全体のVersion**: 項目の内容のハッシュが`manifest.json`と一致すること（内容を変えてmanifestの更新を忘れるとテストが落ちる）。
- **検索の決定性**: 同じ入力で同じ結果になること、項目の並び順に依らないこと、同点がidの昇順になること、Spotの特徴・Topic・全文の加点を手計算の値で確かめます。結果にKBのVersionと項目のID・Version・Evidence IDが入ることも確かめます。
- 実物のKBで、代表的なSpot（Riverでの大きなBetへの直面・FlopのC-bet・BBのBlind Defense・Multiway）に対して、期待する項目が出ることを確かめます。

Review AI（Pass A）・Evidence・Versioned Review（#82。`apps/server/src/review/`のテスト）:

- **Hindsight Leak / Hidden Information**（`evidence.test.ts`）: RuleBotの卓で進めた多数のHand（CPUの不正な出力で`system`のEventを含む）の全判断で、EvidenceとPromptに判断時点のHeroが知り得ない札（他者の札・後のBoard・Showdown）・Deck・seed・`system`の記録・CPUの出力の値・Personaが無いこと、判断より後のEventを切り落としても見えないEventの中身を差し替えてもEvidenceが変わらないことを確かめます。KBの本文は静的なCurated KBで、KBの項目そのものであることを確かめたうえで語の検査から外します。
- **Math / Range / KB / Solver**: MathがEngineの`analyzeDecision`と同じ値であること、Important SpotだけRangeの想定の比較を持つこと、KBのEvidence IDがKBのVersionを含むこと、SolverはPreflop / Multiway / 未導入をFallbackし、HUのRootの判断だけを解き（Betへの直面・IPは解かない）、失敗の本文をEvidenceに入れないこと（`solver-evidence.test.ts`）。
- **識別子の置換**（`identifiers.test.ts`・`generate.test.ts`・`reveal.test.ts`・`harness.test.ts`。#96）: playerId → 表示名・項目名 → 説明（値付きのboolean・`cpu1`と`cpu10`・別の語の一部・未知の識別子は残す）、根拠のidとenumを触らないこと、Pass Aの項目の説明にHand後の項目を出さないこと、識別子があってもRetryしないこと（Pass A・Pass B・Follow-up）、置換前後の指標（出現率・残存率）。
- **Table Tendency（D122・#153）**（`review-table-tendency.test.ts`・`generate.test.ts`・`identifiers.test.ts`）: Pass AのEvidenceの卓の傾向が、判断のHandと同じSessionの、そのHandより前に保存したHandのpublicのEventだけから作られること（そのHand自身・後のHand・別のSessionのHandを入れない。見えないEvent〔他者の札・Deck。Learning-only Revealの元〕を差し替えても、前のHandのPass Bを先に作っても変わらない）、項目ごとのEvidence IDと決定論の割合、十分な項目が無い・Handが0・無いときEvidence・Prompt・Schemaが#153より前と同じ文字列であること、あるときだけPromptに読み方と項目の説明を添え`exploitBasis`に`observation`を選べること、Grounding（`observation`ならサンプルが十分な項目のidを挙げる）、Pass A へのFollow-upの項目の説明、Pass BのEvidenceに入らないこと、項目名・値の置換。
- **出力の検証と生成**（`generate.test.ts`）: Schema（形・enum・文字数）とGrounding（実在しないEvidence ID・Solverの結果が無いのに`solver`・Observationが無いのに`observation`）の不正、1回のRetry、2回続けて不正ならInsufficient Evidence（失敗の記録）、Evidence Sufficiency GateでReview AIを呼ばないこと、`depth`ごとのModel Role、Claudeの呼び出しの失敗を例外のまま伝えること。
- **保存とAPI**（`review-store.test.ts`・`review-service.test.ts`・`routes/reviews.test.ts`）: Versionの追記と上書きの拒否（メモリ内とSQLiteの両方）、非同期の生成（202・pending）、二重の要求で1回だけ作ること、上限の超過（timeout）・アプリの終了で子プロセスを止めること、生成を1つずつ順に進めること、失敗の種類だけを返すこと、404 / 409 / 400。

### Review Eval の最小形（Issue #82）

- **置き場所**: `apps/server/src/testing/review-eval/`（buildの対象外。AI Opponent Evalと同じ形）。`hands.ts`（積んだDeckとActionの列で最後まで進めた固定Hand）・`harness.ts`（判断ごとにReviewを作る）・`metrics.ts`（集計・合格ライン）・`recording.ts`（録画と再生）・`run.ts`（手動実行）。
- **代表の判断**: BTNのHeroがUTGのOpenにCall（Preflop）・同じHandのRiverの大きいBetへのCall（Important Spot）・SBのHeroがHUのTurnで最初にBet（SolverのRoot）・3人のFlopでBetにCall（Multiway）の4つ。
- **本番と同じ経路**: Evidenceは`buildReviewEvidence`、生成は`generateReview`（`ReviewService`と同じ関数）で、差し替えるのはSDKの`query()`だけです。Solverは録画の再生で結果が揃うよう未導入に固定します（Supported のSolver Evidenceを渡したReviewは`--solver`の手動実行で確かめる。録画には使わない）。
- **手動の Eval**: `pnpm --filter @proj-poker/server eval:review [--repeats 1] [--depth standard|deep] [--solver] [--record]`。Claude CodeのOAuth（サブスク枠。D87）で呼び、指標と合格ラインを表示し、`--record`で録画（`recordings/review-eval.json`）に書きます（障害が1件でもあれば書かない）。
- **CI**（`harness.test.ts`）: Claudeを呼ばず、録画した出力を本番と同じ経路で再生して集計し直し、録画時の集計と一致すること・Hindsight Leakと障害が0件であることを確かめます。Evidence・Prompt・Schema・KBが変わると引数の指紋が合わず、再生が失敗します（手動のEvalで録画を取り直す）。
- **Table Tendency（D122・#153）**: 代表の判断は前のHandを持たない固定Handなので、Opponent Observationは`unavailable`のままで、録画の指紋は#153より前と同じです（録画は取り直していない）。卓の傾向が入るPromptとGroundingは、Fakeと決定論のテストで確かめます（上の「Table Tendency」）。卓の傾向が入ったReviewの実モデルの品質（説明が数値を作らない・個々の相手の傾向として断定しない等）は、まだ録画で測っていません。

指標の定義（`metrics.ts`）:

| 指標 | 定義 | 合格ライン（暫定） |
|---|---|---|
| Structured Output Valid率 | 呼び出し（Retryを含む）のうち検証（Schema・Grounding）を通った割合 | 0.9以上 |
| Retry率 / Fallback率 | 判断のうち1回目が不正だった割合 / 2回続けて不正でInsufficient Evidenceにした割合 | Fallback率 0.05以下 |
| Insufficient Evidence率 | Gate・Fallback・Review AI自身の判断のすべて | 表示のみ |
| Hindsight Leak | EvidenceかPromptに判断時点のHeroが知り得ない情報が入っていた判断の数 | 0件（1件でも不合格） |
| Math Grounding率 | Review AIが書いた判断のうち、Math EvidenceのIDを根拠に挙げた割合 | 0.9以上 |
| KB Grounding率 | Review AIが書いた判断のうち、KBの項目（実在するID）を根拠に挙げた割合 | 0.5以上 |
| 識別子の出現率 / 残存率（#96・D101） | Review AIが書いた判断のうち、出力の文に内部の識別子（playerId・Evidenceの項目名・snake_case・Evidenceのid）があった割合（置換の前＝Promptの効き）/ 保存するReviewの文にまだ識別子が残っていた割合（置換の後。置換の対応表に無い未知の識別子） | 残存率 0（1件でも不合格。残った識別子は`residualIdentifiers`に出るので、`review/identifiers.ts`の対応表に足す） |
| Exact GTOの言及 | 説明に「Exact GTO」「厳密なGTO」を含む判断の数（否定の文脈も数える） | 表示のみ（人が読んで確かめる） |
| Latency | 呼び出しごとの所要時間のmin / median / p90 / max | 表示のみ（上限は`REVIEW_TIMEOUT_MS`。OI-001） |

- Mathの正しさはEvidenceがEngineの値そのものであることで担保し（LLMに計算させない）、Uncertaintyの表現とAssumptionを変えたときのRecommendationの変わり方はJudge（人間かLLM）が要るため、まだ測りません。Human-reviewed HandのRegression Caseは、人がReviewを読んで固定するまで置きません。

## 7. Solver Adapter Test

- Capability Detection
- Supported Spot
- Unsupported Spot
- Timeout
- Cancellation
- Invalid Input
- Parse Failure
- Version Metadata
- Range Assumption保持

実装（#81）: `apps/server/src/solver/amaster97-adapter.test.ts`が上の各項目を、実Solverを呼ばずに確かめます。Solverの代わりに、テスト中に書き出すNodeのスクリプト（偽のSolver。録画の出力・終わらない・壊れたJSON・exit 1等を返す）と、実Solver（amaster97）の#76のRiverの固定Spotの出力の録画を使います。Timeout / CancellationはSIGKILLの後にプロセスが残っていないことを、Invalid InputはSolverが一度も起動しないことを確かめます。実Solverでの確認（RiverとTurnを各1 Spot・Timeout / Cancel後のプロセスの残り）は手動の`pnpm --filter @proj-poker/server smoke:solver`です。

## 8. Critical E2E

1. 6-max Cash開始
2. Handを最後までPlay
3. Chip / Declaration操作
4. Hand終了
5. Reviewを開く
6. 全Hand Reveal
7. Replay
8. Follow-up質問
9. 次Hand開始
10. Hand間でアプリ再起動しSession再開

### 実装（Issue #85・D98）

- `e2e/`（workspaceの`@proj-poker/e2e`）のPlaywright（Chromiumだけ）で、上の1〜10を1本のテスト（`e2e/tests/session.spec.ts`）として通します。実行はルートの`pnpm e2e`、CIは`check`とは別の`e2e`ジョブです（`.github/workflows/ci.yml`。ブラウザはPlaywrightの版ごとにキャッシュ）。
- 決定論にするため、serverは`POKER_SEED`（山札のseedの固定の並び）・`OPPONENT_PROVIDER=rulebot`・`REVIEW_PROVIDER=fake`（Review AIを固定応答に差し替え、Claudeを呼ばない）・`BOT_THINK_DELAY_MS=0`・空の一時DBで起動します（`e2e/support/server.ts`）。固定応答は呼び出しの種類（Pass A / Pass B / Follow-up）を構造化出力のSchemaで見分け、`evidenceIds`をSchemaの候補から選ぶので、本番と同じ検証・保存・画面の経路を通ります。
- HeroはChip操作（最初にCallする手番でCallの額のChipを手に取りBetting Areaへ出して確定）と宣言Button（Call / Check）で手番を進めます。Reviewは最初の判断でPass Aの段階評価→Pass B→Follow-upの答えが出ること、ReplayはImportant Spotへのジャンプを確かめます。
- 再起動は、2 Hand目の後にserverを止めて同じDBで起動し直し、画面を読み込み直して「Handを始める」で3 Hand目を始めます。3 Hand目の開始時のStackが2 Hand目の終わりのStackと同じ（新しいSessionの均等Stackに戻っていない）・Chipの総量が変わらないことを、Replay APIの値で確かめます。
- 実際のClaude（OAuth）での通しは手動で1回行い、結果は作業ログ（`docs/taskLog/issue-85-e2e-readme.md`）に残します（D98）。

### Phase 6のCritical E2E（Issue #119）

Phase 6（Session Learning）の通しは、上の1〜10と重ならないよう、Sessionの終わりからの学習の流れだけを別の1本（`e2e/tests/learning.spec.ts`）で通します。

1. 2人卓で、HeroがAll-inできる手番はAll-in（それ以外はCall / Check）してSessionが終わるまでPlayする（Session Reviewの入口はSessionの終わりに出る）
2. 最後のHandのReviewを開き、Pass A（段階評価）とPass B（Learning-only Reveal）を作る
3. Session Review: 判断の質（M件中N件）・Leak・HeroのStats・おすすめのDrillの候補が出る。Pass Bの文は出ない
4. Player Profile: Review済みの判断からScoreと弱点の仮説（Weakness Hypothesis）が作られ、直近 / 全期間を切り替えられる。Profile・Session Reviewの応答にPass Bの文・Personaが入らない
5. おすすめのDrillを始め、Drillの卓でHandを最後まで遊び、練習した判断のReviewを作る
6. Drillの結果は別の欄（練習した判断のM件中N件）に数え、Session Review・Profileの件数は変わらない（D105）
7. Learning Reset（全カテゴリ）: Profileは「Reset後」の0件から数え直し、Session Reviewは変わらない。Replayの一覧・元の判断と練習した判断のPass A・Drillの一覧（provenance）は変わらない（D114）
8. serverを再起動しても、Session Review・Profile・Drillの一覧・Replayの一覧・Pass Aの応答が同じ（Hypothesisの`computedAt`は読むたびに作り直す時刻なので除く）。画面のReplayの一覧から保存済みのHandを開ける

- serverの設定は1本目と同じ（`e2e/support/server.ts`）に、`TABLE_SIZE=2`と`FAKE_REVIEW_ASSESSMENT=improvement_suggested`（固定応答のPass Aの段階評価を「改善の余地あり」にする。Leakが無いとDrillの候補が出ないため。既定は`reasonable`）を足します。
- EventからStats / Scoreを作り直せること・Hidden Persona / Learning-only Revealが漏れないことの単体・統合テストは§10に置きます。

### Phase 7のCritical E2E（Issue #144）

Phase 7（Rich Opponent Simulation）の通しは、Fixed CPUとGuestの卓で複数のSessionを遊ぶ流れを別の1本（`e2e/tests/opponent-memory.spec.ts`）で通します。

1. 6人卓で、HeroがCall / Checkだけで打ち、HeroがBustしてSessionが終わるまでPlayする。「新しい Session を始める」で次のSessionを始める
2. 前のSessionのobservable Evidenceを、次のSessionの同じ`cpuProfileId`のCPUがMemoryとして使う: 次のSessionの最初のHandの開始時に、両方のSessionに座ったFixed CPUのMemoryは、前のSessionで同じ卓にいたHandの数だけHeroを見ていて、EvidenceはそのCPUが座っていたHandのAction
3. Guestは次のSessionにMemoryを持ち越さない: 前のSessionのGuestはそのSessionの中ではMemoryを積むが、次のSessionには座らない。次のSessionのGuestは空のMemoryから始まり、Fixed CPUから見た新しいGuestも初対面
4. CPU-to-CPUのPrivate Memoryが第三者のCPUに漏れない: どのObserverのMemoryも、見たHandの数がそのObserverとSubjectが同じ卓にいたHandの数と一致し、EvidenceはObserverが座っていたHandだけ。前のSessionから座るFixed CPU AがFixed CPU Bを見ていても、次のSessionで初めて座るFixed CPU Cから見たBは0
5. TiltはSessionの終わりでResetされる: 前のSessionの終わりにTiltが1以上で、次のSessionにも座るFixed CPUがいて、次のSessionの最初のHandの開始時のTiltは全員0（Memoryは持ち越す）
6. Opponent Memory Reset（`POST /api/opponents/memory-resets`・`{ "scope": "all" }`）の後は、Resetより前のHandをMemoryに使わない（Resetの後の最初のHandは全員が空のMemory、その次のHandはResetより後のHandだけから作る）。User Note / Tag（Resetの前に画面から残したもの）は変わらない
7. Heroの画面と、Playの間に画面が受け取った応答（Handの開始・操作・Note / Tag・進行中のSSEの各Event）と、終わった後のReplay・HandのSSE・Note / TagのAPIの応答に、Memory・Tilt・Table Tendencyの値、PoolのIdentity（`cpuProfileId`・Guestのid・名前）・Persona・`phase7_`のPolicyの版が出ない

- HiddenのMemory・Persona・TiltはHeroの画面・APIに出さない（D105・D107）ので、確認用のAPIを本番に足しません。2〜6はテストプロセス（Node）からserverの一時DBを読み取り専用で開き、serverがHandの開始時に使うのと同じProjectionの関数（`buildOpponentMemoriesFromStore`・`buildTiltsFromStore`。入力はそのHandより前に保存されたHandだけ）で作り直して確かめます（`e2e/support/opponent-memory.ts`）。そのため`pnpm e2e`は`NODE_OPTIONS=--conditions=@proj-poker/source`でPlaywrightを動かし、`apps/server`・Engineをbuildせずに`src`から読みます。
- E2Eが確かめるのは、実際のserverのプロセス・SQLite・画面の経路を通したSessionの流れで、Memory・Tiltの値はEvent Logから作り直したものです。CPUに実際に渡った層の値が、同じ入力からProjectionで作った値と一致すること（評価ハーネスと本番の組み立ての一致）は、本番のHand Orchestratorを使う`apps/server/src/testing/opponent-eval/memory-eval.test.ts`（§5「Opponent MemoryのEval」）と`apps/server/src/memory/memory-reset.test.ts`（Resetの後の注入）で確かめます。
- 進行中のSSEはPlaywrightの応答から本文を読めないので、テストの手順でページの`EventSource`を包み、受け取った`data`を残して検査します（画面の挙動は変えない）。
- serverの設定は1本目と同じ（`e2e/support/server.ts`）に、`POKER_SEED=20261042`を足します。このseedでは、1つ目のSessionが数HandでHeroのBustで終わり、両方のSessionにGuestが座り、2つ目のSessionで初めて座るFixed CPUと、1つ目の終わりにTiltが1以上で2つ目にも座るFixed CPUがいます。編成が変わってこの前提が崩れたら、検査を空振りさせずに前提のassertで落とします（seedを選び直す）。
- 画面は1280×900で動かします。既定の1280×720では、Sessionの終わりの「新しい Session を始める」がHeroの席に覆われて押せません（#158。このE2Eでは直さない）。
- HandはReplayの一覧の並びに頼らず、開始の応答のhandIdで特定します。「次の Hand へ」「新しい Session を始める」の後は、画面が新しいHandに切り替わるまで待ちます（`e2e/support/next-hand.ts`。#133）。

## 9. Property / Fuzz

有効な用途:

- Random Legal Action Sequence
- Side Pot / Chip Conservation
- Random Stack
- Random Player Count
- Deck Uniqueness

Fuzz Testだけで明示的Rule Scenarioを置き換えないでください。

再現できるようにするため、Property Test（fast-check）は共通のパラメータ（`packages/engine/src/testing/property.ts`の`propertyParams`）でseedを1つに決めて流します。失敗したときはfast-checkの出力（`{ seed: …, path: … }`と縮小済みのCounterexample）がCIのログに出るので、`POKER_PROPERTY_SEED=<seed> pnpm --filter @proj-poker/engine test`で同じ入力を再現し、縮小した反例をScenarioへ昇格させます。`POKER_PROPERTY_RUNS_FACTOR=<整数>`でケース数を倍にでき（時間切れも同じ倍率で延びます）、数万ケースの繰り返しに使います。1テストの時間切れは30秒です（既定の5秒だと、負荷の高いCIで時間切れになり、seedも反例も残らないまま落ちるため。#95）。

## 10. Session Learning（Phase 6）のテスト

Phase 6 → 7のGate（`docs/08` §3.2）の項目と、それを確かめるテストの対応です。Stats・Score・Profile・Hypothesisはどれも、Event Logと`reviews`（Pass A）から読むたびに作り直すProjectionです（D37・D113）。

| Gateの項目 | テスト |
|---|---|
| StatsをEventから再計算できる | `packages/engine/src/stats.test.ts`（固定Scenarioの手計算の期待値・全Player・6人卓のPosition・Drill / 進行中のHandを除く・Hole CardsとDeckを差し替えても結果が同じ） |
| ScoreがPolicy Version付きで再計算できる | `apps/server/src/learning/score.test.ts`（「Policy の Version を変えると、同じ Evidence から計算し直せる」等）・`learning-reset.test.ts`（「Policy の Version を変えても、正本（Event Log・reviews）から Reset 後の Evidence だけで計算し直せる」） |
| Confidence / Sample Size / Evidence IDsが保持される | `score.test.ts`（M件中N件・insufficient_evidenceを0点にしない・ConfidenceはWeightだけ・Trend・Confidenceの段階） |
| HypothesisがSupporting / Counter Evidenceから決定論的に更新される | `apps/server/src/learning/hypothesis.test.ts`・`hypothesis-snapshot.test.ts`（Snapshotを消して作り直しても同じ行） |
| Recent / Long-term Profileが自然言語Summaryに依存せず再生成できる | `apps/server/src/learning/profile.test.ts`・`learning-reset.test.ts`（「過去の Snapshot・自然言語の Profile を入力にしない（作り直しの結果は前の状態によらない）」） |
| User Read / Note / TagがHidden Personaと混ざらない | `apps/server/src/routes/notes.test.ts`（CPUの入力に入らない）・`apps/server/src/review/evidence.test.ts`（判断より前の読みだけをprovenance付きでEvidenceへ）・`apps/server/src/routes/learning-leakage.test.ts` |
| Drillが元Handとprovenanceを持ち、Engine Validationを通る | `apps/server/src/drill/drill-plan.test.ts`（Validationを通る候補が無ければDrillを出さない）・`apps/server/src/routes/drills.test.ts`（provenance・決定論・集計から除く） |
| Phase 6のCritical E2Eが通る | `e2e/tests/learning.spec.ts`（§8） |

Hidden Persona / Learning-only RevealのLeakage 0は、経路ごとのテスト（`learning.test.ts`・`session-review.test.ts`・`drills.test.ts`・`evidence.test.ts`の`forbiddenKeys`・`collectCards`）に加え、`apps/server/src/routes/learning-leakage.test.ts`がHand API・User Read・Note / Tag・Pass A / Pass B・Drillを1本の流れで通してから、Heroに返すLearningの応答（Session Review・Profile・Drillの一覧・Note / Tag・読みの後のHeroView・Pass AのEvidenceの読み）にPersonaの語・Pass Bの文・Heroが知り得ない札が無いことを確かめます（#119）。Drillの一覧の`variant` / `change`（`opponent_tendency`のPreset）はDrill自身の設定で、元のCPUのHidden Personaではないので除きます（`docs/07` §7）。

意味上の順序（D117・#132）が壁時計の巻き戻りで崩れないことは、各Storeの`now`を注入して後ろへ戻る時計を作って確かめます（本番の起動に時計をずらす仕組みは足さない）: `apps/server/src/event-store.test.ts`（「壁時計が後ろへ戻っても、listHands・finishedHandIds・sessionHandIds は保存の順、途中の Hand は始めた順で並ぶ」「後に Hand が終わった Session の時刻の方が古くても、latestSessionProjection はその Session を選ぶ」。メモリ内とSQLiteの両方）・`sqlite-event-store.test.ts`（「再起動後のメモリの Hand の開始時刻が保存済みの Hand より前に記録されても、listHands の先頭はメモリの Hand」。#129の再現）・`learning/learning-reset.test.ts`（「Hand の終わりの時刻が Reset より後でも保存が Reset より前なら除き、時刻が前でも保存が後なら入れる」「2 回目の Reset の時刻の方が古くても、追加の順で後の Reset を区切りにする」。#130）・`routes/drills.test.ts`（「Drill の系列の Score の Reset の前後は保存の順で決め、壁時計が戻っても崩れない」）・`db/database.test.ts`（「版 8 の DB に版 9（ordinals）を当てると、既存の行は変えずに Hand と Reset の論理順序を backfill する」）。E2Eは一覧の並び（`hands[0]`）に頼らず、前の段階で取ったhandIdとの差分で対象のHandを特定します（`e2e/tests/session.spec.ts`・`learning.spec.ts`）。

## 11. Rich Opponent Simulation（Phase 7）のテスト

Phase 7 → 8のGate（`docs/08` §3.2）の項目と、それを確かめるテストの対応です。Observation・Hypothesis・Memoryの要約・Tilt・Table Tendencyはどれも、Event Log（正本）と`session_participants`・`opponent_memory_resets`からHandの開始時に作り直すProjectionで、保存しません（D37・D106・D107）。

| Gateの項目 | テスト |
|---|---|
| Fixed CPU IdentityとGuestの寿命がテストされる | `apps/server/src/opponents/cpu-pool.test.ts`（「Fixed CPU は Session を跨いで同じ cpuProfileId、Guest の id は Session ごとに別で次の Session へ持ち越さない」等）・`apps/server/src/memory/observation.test.ts`（「Guest は Observer でも Subject でも、次の Session では読まない」）・`e2e/tests/opponent-memory.spec.ts`（§8の3） |
| Observationがprovenanceを持つ | `apps/server/src/memory/observation.test.ts`（「Observer・Subject・hand_id・seq・ord・Visibility・context を持ち、Subject は席でなく参加者で引く」等） |
| CPU Private MemoryのIsolation Testが通る | `apps/server/src/memory/opponent-hypothesis.test.ts`（「A の B への Hypothesis は A の観察だけから作り、A が座っていない Hand（C の観察）を使わない」等）・`memory-injection-isolation.test.ts`・`table-tendency-isolation.test.ts`・`apps/server/src/opponents/tilt-isolation.test.ts`・`e2e/tests/opponent-memory.spec.ts`（§8の4・7） |
| Learning-only RevealがMemoryに入らない | `apps/server/src/memory/observation.test.ts`（抽出の値に、BoardとShowdownで表にされた札以外のCardが無い）・`observation-isolation.test.ts`・`memory-injection-isolation.test.ts`（Learning-only Revealを参照しない） |
| recency decayを含むHypothesis Projectionが再構築可能 | `apps/server/src/memory/opponent-hypothesis.test.ts`（recencyの減衰・決定論と論理順序）・`apps/server/src/memory/memory-reset.test.ts`（Resetの後のObservation・Hypothesis・注入） |
| Tiltがdeterministic / versioned / transient | `apps/server/src/opponents/tilt.test.ts`（`phase7_tilt_v1`・State Machineの畳み込み・Sessionごとの Reset）・`tilt-isolation.test.ts`・`e2e/tests/opponent-memory.spec.ts`（§8の5） |
| Cash / Tournament contextのStrategy Hypothesisが分離される | `apps/server/src/memory/opponent-hypothesis.test.ts`（「Cash と Tournament の Hypothesis は混ざらない（Raw Observation は共通・Hypothesis は context ごと）」） |
| Phase 7のCritical E2E / Evalが通る | `e2e/tests/opponent-memory.spec.ts`（§8）・`apps/server/src/testing/opponent-eval/memory-eval.test.ts`（§5「Opponent MemoryのEval」） |
