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

CPU Memoryができるまでは、Learning-only Full Reveal（`projectLearningReveal`）でだけ見える札が、どのCPUの`KnowledgeState`（Handの全prefix）にも、判断時点のHero Information Set（Pass Aの入力）にも入らないことで確かめます（`packages/engine/src/hand-summary.property.test.ts`。#78）。Runtime側（#83）では、Hand 1のPass B（全員の札をReview AIに渡す）とそのFollow-upを作った後にHand 2を続け、両HandのClaude OpponentのPromptに入る札がその時点でそのCPUが知ってよい札だけであること・Learning-onlyの印が無いことを確かめます（`apps/server/src/review/learning-reveal-isolation.test.ts`）。Pass Aへの質問（Follow-up）のPromptに、判断時点のHeroが知り得ない札が入らないことも確かめます（`review/reveal.test.ts`・`routes/reviews.test.ts`）。CPU Memory（Phase 7。#139）ができてからは、Pass A / Pass Bを作った後に複数のSessionを進め、ClaudeのCPUの全PromptのMemoryの要約がObserver自身の座っていたHandのpublicのActionだけをEvidenceに持ち、Learning-only Revealの札・文・Heroの弱点のHypothesis・前のSessionのGuestが入らないことも確かめます（`apps/server/src/memory/memory-injection-isolation.test.ts`）。CPUのTilt（Phase 7。#140）は、2つのSessionを進めたClaudeのCPUの全Promptで、Tiltの節がそのCPU自身の席の値だけであること・次のSessionが0から始まること・ReviewのPrompt・Heroへの応答・Event LogにTiltが出ないことを確かめます（`apps/server/src/opponents/tilt-isolation.test.ts`）。Table Tendency（Phase 7。#141）は、Sessionを進めたClaudeのCPUの全Promptで、卓の傾向の節がそのCPUが座っていた、そのHandより前に保存したHandのpublicのEventから作った値だけであること（Handが0なら節が無い）・ReviewのPromptの卓の傾向（D122・#153）がHeroが座って見えた、判断のHandより前に保存したHandのpublicのEventから作った値だけで（十分な項目が無ければ入らない）、CPUのMemoryの要約・Tilt・Persona・PoolのIdentityが入らないこと・Review以外のHeroへの応答とEvent LogにTable Tendencyが出ないこと、Table TendencyのモジュールがHeroの弱点・CPUのPrivate Hypothesis / Memoryの要約・Tiltのモジュールに届かずLearning-only Revealを参照しないことを確かめます（`apps/server/src/memory/table-tendency-isolation.test.ts`）。見えないEvent（Hole Cards・Deck・`system`）を差し替えても結果が変わらないこと・時計が後ろへ戻った記録でも結果が変わらないことは`memory/table-tendency.test.ts`です。Tournament（Phase 8。#188）では、CashのSessionでPass A / Pass Bを作った後にTournamentのSessionを進め、ClaudeのCPUの全Promptで、Public Tournament Contextの節がTournamentのHandにだけあり公開のHandの開始時のStackとSessionの設定から作った値だけであること・TournamentのHandのMemoryが`tournament`のcontextでObserver自身の座ったTournamentのHandのpublicのActionだけをEvidenceに持つこと（CashのHypothesisを混ぜない）・他者の札・Learning-only Reveal・Heroの弱点・他CPUのPersonaが入らないことを確かめます（`apps/server/src/memory/tournament-isolation.test.ts`）。他者の札・Deckを変えてもHandの途中でActionが進んでもContextが変わらないことは`packages/engine/src/tournament-knowledge.test.ts`です。

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
- **ClaudeのCPU**: 既存の録画（`recordings/opponent-eval.json`）の再生が通り続けることを確かめます（代表Spotの入力には層が無いので、Promptの指紋は変わらない）。Memory等の節の入ったPromptは、次の節の録画で測ります（#155）。

### Memory付きPromptのClaudeのEval（Issue #155・D123）

Memory（Hypothesisの要約）・Table Tendency・Tiltの節が入ったPromptで、ClaudeのCPUの判断を録画します。呼び出しは`eval:opponent`と同じ経路（Claude Agent SDK・Claude CodeのOAuth〔サブスク枠〕・`buildClaudeEnv`）だけで、APIキーは使いません（D87・D123）。

- **置き場所**: `memory-prompt-eval.ts`（Spotと条件・上限・集計）・`memory-prompt-run.ts`（手動の実行）・`memory-prompt-eval.test.ts`（CI）・`recordings/opponent-memory-prompt-eval.json`（録画）。ハーネス（`harness.ts`）は既存のOpponent Evalと同じで、本番のFactory・検証・Retry・Fallbackを通ります。
- **Spotと条件**: 代表Spot 2（`river_facing_big_bet`・`flop_cbet`）× 条件3 × Persona 6 × repeat 1 = 36判断。条件は baseline（層なし。既存の録画と同じPrompt）・loose（Memory Evalの`all_loose`: 相手がLooseと分かるMemory・緩い卓・Tilt 3段）・tight（`all_tight`: 相手がTightと分かるMemory・締まった卓・Tilt 3段）です。looseとtightはTiltが同じなので、両者の差は相手と卓の傾向の向きだけです（Tiltだけの効果はこの3条件では分けられない）。層を足したSpotのHandのIDは元のSpotと同じにします（IDはPromptに入る）。
- **意図した向き**: River（Potを超えるBetに直面）では攻める（Loose）相手ならCallが増え、Flop（C-betするか）ではC-betによく降りる（Tight）相手ならBet（BluffのC-bet）が増える。looseとtightの割合（全Personaの合計）を比べ、同じ条件のRuleBot（400 seed）を参照に並べます。向きの合格ラインは置きません（1条件・1 Personaに1判断で、統計として成立しないため）。
- **上限（D123）**: 判断36・呼び出し（Retryを含む）72を`MEMORY_PROMPT_EVAL_LIMITS`に置き、判断の数は実行の前に確かめ、呼び出しは番人（`createCallBudget`）で上限に達したら呼ばずに止めます。障害（ログイン・利用枠を含む）が出たら残りを打ち切ります。`--dry-run`はモデルを呼ばずに判断・Promptの数と漏れを数え、`--record`は録画が既にあれば実行せず、足りない判断だけを`--resume`で残りの回数の中で集めます。`buildClaudeEnv`が外す`ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`に加え、Bedrock / Vertex / Foundry・別の接続先へ切り替わる変数があれば実行しません。
- **Leakage**: 既存の検査（知ってよい札以外のCard・Deck / seed / `system`のEvent・Persona・他のPresetの名前）に加え、入力のMemoryのSubjectに判断するCPU自身が入っていないこと（他のCPUのMemoryを渡した形）・PromptのMemoryの節が1つだけであること・Promptにreveal / weakness / learningの語が無いことを確かめます。
- **CI**: 録画を本番と同じ経路で再生し、集計が録画時と一致すること・Hidden Information Leakageと障害が0件・上限の中で取ったことを確かめます。Prompt・Optionsが変わると指紋（paramsHash）が合わず再生が失敗します。合格ラインは上の表（`OPPONENT_EVAL_TARGETS`）と同じで、CIで落とすのはLeakageと障害だけです。

録画の結果（2026-10-08・`claude-haiku-4-5`（`opponent_fast`）・Agent SDK 0.3.289・実行1回・呼び出し36回 / 上限72）:

| 指標 | 値 |
|---|---|
| 判断 / 呼び出し | 36 / 36 |
| Structured Output Valid率 / Illegal Action率 / Retry率 / Fallback率 | 1 / 0 / 0 / 0 |
| 障害 / Hidden Information Leakage | 0 / 0 |
| Latency（ms。min / median / p90 / max） | 7694 / 9581 / 11008 / 14280 |
| Persona Differentiation（全体） | 0.667（River 0.733・Flopは0.6。3条件とも同じ値だが、Actionの組は条件で違う） |
| Checkできるのに Fold | 1件（`flop_cbet@tight`のNit） |

向き（見るActionの割合。全Personaの合計 baseline / loose / tight。RuleBotは同じ条件の400 seed）:

| Spot（見るAction・増える向き） | Claude | RuleBot | 意図した向き（Claude） |
|---|---|---|---|
| River（Call・Looseで増える） | 0.5 / 0.333 / 0.5 | 0.22 / 0.269 / 0.138 | ならなかった（loose < tight） |
| Flop（Bet・Tightで増える） | 0.5 / 0.5 / 0.667 | 0.075 / 0.035 / 0.123 | なった（tight > loose） |

- 条件で判断が変わったのは River の LAG（Call → loose で Fold・tight で Raise）と Weak-tight Recreational（Fold → tight で Call）、Flop の Nit（Check → tight で Fold）と Weak-tight Recreational（Check → tight で Bet）だけで、他の Persona は 3 条件で同じ Action でした。1条件・1 Personaに1判断なので、向きの差は偶然の幅に入ります（結論にしない）。

#### Riverの追加測定（Issue #171・D126）

初回のRiverの向き（loose < tight）が少数標本の揺れかを確かめるため、`river_facing_big_bet`の3条件（#155と同じ組み立て）× Persona 6にrepeat 2・3を足して録画し、初回の録画のRiverの分（repeat 1）と合わせてrepeat 3で集計します。経路・番人・dry-run・`--record` / `--resume`は#155と同じで、上限は判断36・呼び出し72（`RIVER_REPEAT_EVAL_LIMITS`）です。

- **置き場所**: `river-repeat-eval.ts`（母集団・上限・Riverの割合の集計）・`river-repeat-run.ts`（手動の実行。`eval:opponent-memory-river`）・`river-repeat-eval.test.ts`（CI）・`recordings/opponent-memory-prompt-river-repeat.json`（追加分だけの録画）。初回の録画（`opponent-memory-prompt-eval.json`）は読むだけで書き換えません。
- **CI**: 初回の録画のRiverの18判断と追加分の36判断を合わせて本番と同じ経路で再生し、合計（54判断）と追加分だけの集計が録画時と一致すること・Leakageと障害が0件・上限の中で取ったことを確かめます。追加分の1回目の指紋は初回の録画の同じSpot・Personaと一致する（同じPrompt・Options）ことも確かめます。

録画の結果（2026-10-08・`claude-haiku-4-5`（`opponent_fast`）・Agent SDK 0.3.289・実行1回・呼び出し36回 / 上限72）:

| 指標 | 追加分（36判断） | 合計（54判断） |
|---|---|---|
| 呼び出し | 36 | 54 |
| Structured Output Valid率 / Illegal Action率 / Retry率 / Fallback率 | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |
| 障害 / Hidden Information Leakage | 0 / 0 | 0 / 0 |
| Latency（ms。min / median / p90 / max） | 7440 / 9736 / 11366 / 12615 | 7440 / 9923 / 11366 / 14280 |
| Persona Differentiation | 0.711 | 0.711（baseline 0.733・loose 0.756・tight 0.644） |

Riverの割合（合計 repeat 3。全Personaの合計。各条件18判断）:

| 条件 | Call | Fold | Raise | RuleBotのCall（400 seed） |
|---|---|---|---|---|
| baseline | 0.389 | 0.389 | 0.222 | 0.22 |
| loose | 0.389 | 0.389 | 0.222 | 0.269 |
| tight | 0.389 | 0.389 | 0.222 | 0.138 |

PersonaごとのCallの割合（baseline / loose / tight。各3判断）: TAG Regular 0.667 / 1 / 0.667・LAG 0.667 / 0.333 / 0.333・Calling Station 1 / 1 / 1・Nit 0 / 0 / 0・Maniac 0 / 0 / 0（Raise 1 / 1 / 0.667）・Weak-tight Recreational 0 / 0 / 0.333。

- 初回のloose < tight（0.333 < 0.5）は、repeat 3では続きませんでした（3条件とも0.389で同じ。追加分だけでは0.333 / 0.417 / 0.333）。逆向きではなく、ClaudeのRiverのCallの割合には、相手と卓の傾向の向き（loose / tight）による差が見えない、というのが合計のサンプルでの事実です（RuleBotはloose > tight）。同じ条件の中でも判断が揺れたPersona（TAG Regular・LAG・Maniac・Weak-tight Recreational）があり、初回の1判断だけでは条件の効果と揺れを分けられなかったことが分かります。Calling Station・Nitは9判断とも同じActionでした。
- 「CheckできるのにFold」（初回の`flop_cbet@tight`のNit）はFlopの判断なので、Riverだけのこの測定では再現を確かめていません（D126の範囲外）。Tiltだけの効果も、この3条件では分けられないままです。
- 結果を見てPrompt / Policyは変えていません（D126）。


### TournamentのClaude CPUのEval（Issue #202・D132）

TournamentのHandのPublic Tournament Context（D130・#188。Stack BB・Stage・ICM Equity・Bubble Factor）が入ったPromptで、ClaudeのCPUの判断を録画します。経路・番人・dry-run・`--record` / `--resume`は#155と同じで、呼び出す前にシェルと子プロセスのenvの両方に`ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`CLAUDE_CODE_USE_BEDROCK` / `VERTEX` / `FOUNDRY`・`ANTHROPIC_BASE_URL`が無いことを確かめます（`assertShellRoute`・`assertOAuthRoute`）。

- **置き場所**: `tournament-eval.ts`（Spot・Persona・上限・Stageごとの集計）・`tournament-run.ts`（手動の実行。`eval:opponent-tournament`）・`tournament-eval.test.ts`（CI）・`recordings/opponent-tournament-eval.json`（録画）。`spots.ts`の`buildSpot`は、Tournamentの局面（席・Button・Level・Sessionの設定）を本番と同じ`tableConfigForLevel`と`projectKnowledgeState(…, { tournament })`で作れるようにしました（CashのSpotのPromptは変わらず、既存の録画の指紋はそのまま）。
- **Spot（標準6-max STT・Level 5の75 / 150・BBA 150）**: S0 対照（S2と同じ札・Stack・BlindでContextなし）／S1 Bubbleの前（5人）／S2 Bubble（4人）／S3 In the Money（3人）／S4 Heads-Up は、判断するCPUが10BB（1,500）・Q6oで前が全員FoldのOpen Shoveの判断にそろえ、Stageだけを変えます（残人数が変わるので席はBTN → Heads-UpのSB）。S5 BubbleでChip Leader（4,000）のShoveにBBの2,500がA9oでCallするか（Chip Leaderに対するBubble Factor 2.75・1,000のShort Stackがいる）、S6 S5にMemory（`tournament`のHypothesis）・Table Tendency・Tiltの層（`all_loose`）を足したもの。S0とS2・S5とS6はHandのIDが同じで、違いはContext・層の有無だけです。S0のPromptはS2の入力からContextを外したものと同じ文字列で、System PromptはCashと同じであることをunit testで確かめます。
- **Persona**: Nit（リスク許容0.2・規律0.8）とManiac（0.9・0.15）。Tournamentの節の読み方の指示が「リスク許容度」と「規律」を指すので、その2軸が両端に近い組にしました。
- **上限（D132）**: 判断28（7 Spot × 2 Persona × repeat 2）・呼び出し56（`TOURNAMENT_EVAL_LIMITS`）。

録画の結果（2026-10-09・`claude-haiku-4-5`（`opponent_fast`）・Agent SDK 0.3.289・実行1回・呼び出し28回 / 上限56）:

| 指標 | 値 |
|---|---|
| 判断 / 呼び出し | 28 / 28 |
| Structured Output Valid率 / Illegal Action率 / Retry率 / Fallback率 | 1 / 0 / 0 / 0 |
| 障害 / Hidden Information Leakage | 0 / 0 |
| Latency（ms。min / median / p90 / max） | 6829 / 8681 / 10802 / 12016 |
| Persona Differentiation | 1（全Spotで1。NitとManiacが全Spotで別のActionを選んだ） |

StageごとのAction（Nit / Maniac。各2判断）:

| Spot | Nit | Maniac | 見るActionの割合（合計） |
|---|---|---|---|
| S0 対照（Contextなし） | Fold 2 | Raise 2（3BB） | All-in 0 |
| S1 Bubbleの前 | Fold 2 | Raise 1・All-in 1 | All-in 0.25 |
| S2 Bubble | Fold 2 | All-in 2 | All-in 0.5 |
| S3 In the Money | Fold 2 | All-in 2 | All-in 0.5 |
| S4 Heads-Up | Fold 2 | Raise 1・All-in 1 | All-in 0.25 |
| S5 Bubbleの大StackのShoveへのCall | Fold 2 | All-in 1・Call 1 | Call / All-in 0.5 |
| S6 S5 + 層 | Fold 2 | Call 2 | Call / All-in 0.5 |

- Contextの有無（S0 → S2）の分布の差（Total Variation Distance）: Nit 0・Maniac 1（Raise → All-in）・合計0.5。層の有無（S5 → S6）: Nit 0・Maniac 0.5・合計0.25。
- 所見: Contextは形式・合法性・漏れの面では正しく使われ、Rationaleにも`Bubble Factor 2.75`等の値が出ますが、判断はPersonaが支配的でした。NitはHeads-UpのSB 10BBのQ6o（Chip EVでもICMでもほぼShoveの局面）を含む14判断すべてでFoldし、ManiacはBubble Factor 2.75のShoveにA9oで「ICMのリスクを無視して」Callしました。Context・Stageによる差はManiacのSizing（3BBのRaiseかAll-inか）にだけ出ています。結果を見てPrompt / Policyは変えていません（D132）。戦略品質の改善は#207に分けました。
- CI: 録画を本番と同じ経路で再生し、集計が録画時と一致すること・Hidden Information Leakageと障害が0件・上限の中で取ったこと・録画に資格情報が無いことを確かめます。

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
- **Table Tendencyの表示（D122・#169）**（`apps/web/src/components/review.test.tsx`・`review-table-tendency.test.ts`・`e2e/tests/review-tendency.spec.ts`）: 根拠の欄が保存済みのEvidenceの値（割合・分子 / 分母・機会があったHand・十分か保留か）をそのまま出すこと、`unavailable`は「卓の傾向はありません」、`opponentObservation`の無い古い記録は欄を出さずエラーにしないこと、Evidenceに紛れたPersona・Memory・Tilt・Revealの値が画面に出ないこと（項目を読む実装の検査）、APIが返す保存済みのReview（status・version）の応答に、作った時のTable Tendencyがそのまま入り、Memory・Hypothesis・Tilt・Personaを指す語と判断時点に見えない札が無いこと、E2E（Heroが毎Hand Foldして11 Hand以上を重ね、Handは`handId`で特定）で画面の値がAPIのEvidenceと一致し、375×667・320×568・1280×720で横スクロールと項目の重なりが無いこと。
- **出力の検証と生成**（`generate.test.ts`）: Schema（形・enum・文字数）とGrounding（実在しないEvidence ID・Solverの結果が無いのに`solver`・Observationが無いのに`observation`）の不正、1回のRetry、2回続けて不正ならInsufficient Evidence（失敗の記録）、Evidence Sufficiency GateでReview AIを呼ばないこと、`depth`ごとのModel Role、Claudeの呼び出しの失敗を例外のまま伝えること。
- **文の中の数値のGrounding（#168・D131）**（`numeric-grounding.test.ts`・`generate.test.ts`・`reveal.test.ts`）: 数値表が同じEvidenceから同じ表になり（`N1`から採番）、書式がUIと揃うこと（整数の%・Chipの実額とBB換算・符号付きの簡易EV・TournamentのICMのptと小数第1位の%・賞金のptと割合）、PromptとSystem Promptの指示、照合の誤検知の回帰（参照・丸め・小数・「約」「前後」・全角％・3-Bet・6-max・50/30/20・BB併記・空白なしのBB・席の表示名の数字・Evidenceの文の値）、不正の検出（表に無い%・丸め違い・自分で計算した差・表に無いBB / pt・未知の参照・`{}`の無い参照・単位の重ね書き・額の参照の後ろのBB）、Follow-upでHeroの質問の値を一致として扱うこと、不正なら既存のRetryの枠で1回だけ再要求し2回続けて不正ならInsufficient Evidence（3回目は呼ばない）、通った文は参照を置き換えて保存すること、Pass BへのFollow-upには数値表を出さず照合もしないこと。
- **保存とAPI**（`review-store.test.ts`・`review-service.test.ts`・`routes/reviews.test.ts`）: Versionの追記と上書きの拒否（メモリ内とSQLiteの両方）、非同期の生成（202・pending）、二重の要求で1回だけ作ること、上限の超過（timeout）・アプリの終了で子プロセスを止めること、生成を1つずつ順に進めること、失敗の種類だけを返すこと、404 / 409 / 400。

### Review Eval の最小形（Issue #82）

- **置き場所**: `apps/server/src/testing/review-eval/`（buildの対象外。AI Opponent Evalと同じ形）。`hands.ts`（積んだDeckとActionの列で最後まで進めた固定Hand）・`harness.ts`（判断ごとにReviewを作る）・`metrics.ts`（集計・合格ライン）・`recording.ts`（録画と再生）・`run.ts`（手動実行）。
- **代表の判断**: BTNのHeroがUTGのOpenにCall（Preflop）・同じHandのRiverの大きいBetへのCall（Important Spot）・SBのHeroがHUのTurnで最初にBet（SolverのRoot）・3人のFlopでBetにCall（Multiway）の4つ。
- **本番と同じ経路**: Evidenceは`buildReviewEvidence`、生成は`generateReview`（`ReviewService`と同じ関数）で、差し替えるのはSDKの`query()`だけです。Solverは録画の再生で結果が揃うよう未導入に固定します（Supported のSolver Evidenceを渡したReviewは`--solver`の手動実行で確かめる。録画には使わない）。
- **手動の Eval**: `pnpm --filter @proj-poker/server eval:review [--repeats 1] [--depth standard|deep] [--solver] [--record]`。Claude CodeのOAuth（サブスク枠。D87）で呼び、指標と合格ラインを表示し、`--record`で録画（`recordings/review-eval.json`）に書きます（障害が1件でもあれば書かない）。API課金・別の経路（Bedrock / Vertex / Foundry・別の接続先）へ切り替わる変数が親（シェル）か子プロセスのenvにあれば、呼ぶ前に止めます（`assertOAuthRoute`）。1回の実行の呼び出しは番人（`createCallBudget`）で24回までで、Retryを含めた最悪の呼び出しの数（判断 × repeat × 2）が24を超える`--repeats`は呼ぶ前に拒否します（#168・D131）。
- **CI**（`harness.test.ts`）: Claudeを呼ばず、録画した出力を本番と同じ経路で再生して集計し直し、録画時の集計と一致すること・Hindsight Leakと障害が0件であることを確かめます。Evidence・Prompt・Schema・KBが変わると引数の指紋が合わず、再生が失敗します（手動のEvalで録画を取り直す）。
- **Table Tendency（D122・#153）**: 代表の判断は前のHandを持たない固定Handなので、Opponent Observationは`unavailable`のままで、#153では録画の指紋が変わらず、取り直していません（#168で数値表を足したときに取り直した。下記）。卓の傾向が入るPromptとGroundingは、Fakeと決定論のテストで確かめます（上の「Table Tendency」）。卓の傾向が入ったReviewの実モデルの品質（説明が数値を作らない・個々の相手の傾向として断定しない等）は、まだ録画で測っていません。
- **Tournament（#189）**: `hands.ts`にTournamentの固定Hand（標準6-max STTの4人残り＝Bubble・Level 5。BTNのHeroの10BBのShove〔`BUBBLE_SHOVE`〕と、BBのHeroのBTNのShoveへのCall〔`BUBBLE_CALL`〕）を足し、`harness.ts`の`TOURNAMENT_REVIEW_EVAL_CASES`にしました。本番と同じく`reviewSpotReasons`とSessionの情報を`buildReviewEvidence`へ渡します。CashのReview Evalの母集団（`REVIEW_EVAL_CASES`）には入れず、固定の応答（Fake）で本番と同じ経路（Evidence・Prompt・Grounding・Retry・漏れの検査）を通します（`harness.test.ts`）。CashのEvidence・Prompt・Schemaは変えていないので、既存の録画の指紋はそのままです。実モデルの録画は#202で別の母集団・別の録画として取りました（下の「TournamentのReview Eval」）。

- **文の中の数値のGrounding（#168・D131）**: Promptに数値表を足したので引数の指紋が変わり、CashのReview Eval（上の4判断 × repeat 3 = 12 Review）を取り直しました（2026-10-09・`claude-sonnet-5-5`・Claude Agent SDK 0.3.289・OAuth。Claudeの呼び出し12回〔上限24〕）。Structured Output Valid率1・Retry率 / Fallback率0・数値Groundingの不正0・Math / KB Grounding率1・Hindsight Leak・障害・識別子の残存0で、合格ラインにすべて届きました。12件の出力の文には参照（`{N3}`）が計155個あり、参照を使わない単位付きの数値は2個（どちらも表の値と一致）でした。Tournamentのケースは別の録画です（下の「TournamentのReview Eval」）。

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
| 数値Groundingの不正（#168・D131） | 呼び出しのうち、文の中の数値が数値表と一致しない・数値表に無い参照でGroundingの不正になった数（`numericGroundingInvalids`） | 表示のみ（Structured Output Valid率・Fallback率に含まれる） |
| Exact GTOの言及 | 説明に「Exact GTO」「厳密なGTO」を含む判断の数（否定の文脈も数える） | 表示のみ（人が読んで確かめる） |
| Latency | 呼び出しごとの所要時間のmin / median / p90 / max | 表示のみ（上限は`REVIEW_TIMEOUT_MS`。OI-001） |

- Mathの正しさはEvidenceがEngineの値そのものであることで担保し（LLMに計算させない）、Uncertaintyの表現とAssumptionを変えたときのRecommendationの変わり方はJudge（人間かLLM）が要るため、まだ測りません。Human-reviewed HandのRegression Caseは、人がReviewを読んで固定するまで置きません。

### TournamentのReview Eval（Issue #202・D132）

- **置き場所**: `apps/server/src/testing/review-eval/`の`tournament-eval.ts`（判断・Follow-up・上限・Tournamentの指標）・`tournament-run.ts`（手動の実行。`eval:review-tournament [--dry-run] [--record]`）・`tournament-eval.test.ts`（CI）・`recordings/review-tournament-eval.json`（録画。CashのReview Evalの録画とは別）。`hands.ts`に`ITM_SHORT_CALL`（3人残り・Pay Jump・BBの8BBのHeroがChip LeaderのShoveにK7oでCall）と`TOURNAMENT_TURN_BET`（5人残り・Level 3・All-inの関わらないTurnの最初のBet）を足しました。
- **判断**: BubbleのShove（`bubble_shove/d0`）・BubbleのAll-inへのCall（`bubble_call/d0`）・In the MoneyのShort StackのCall（`itm_short_call/d0`）・All-inでない通常の判断（`tournament_turn_bet/d2`。Tournamentでは Solver が`mode`でUnsupported）× repeat 2 = 8 Review。Follow-upは`bubble_shove/d0#1`と`bubble_call/d0#1`に固定の質問を1つずつ（本番の`generateFollowUp`。対象はReviewServiceと同じく保存するReviewのEvidenceと説明）。
- **上限（D132）**: Retryを含めて最大20回（`TOURNAMENT_REVIEW_LIMITS`）。最悪の呼び出しの数（(Review + Follow-up) × 2）が20を超える構成は呼ぶ前に拒否し、呼び出しは番人（`createCallBudget`）で止めます。経路の確認はCPUのEvalと同じです。`--dry-run`は検証を通らない出力を返すFakeで全経路を通し、Gateで止まる判断が無く最悪20回になることを確かめます（モデルは0回）。
- **指標**: `ReviewEvalSummary`に加え、数値Grounding（D131）の不正の一覧、Chip EVとICMの混同の疑い（文の中の必要Equityの値の直前の語が逆の種類。近似なので一覧を人が読む）、Shoveの条件付きの前提（1人にCallされほかはFold・Fold Equityを含まない）がassumptionsにあるか、Solver UnsupportedのReviewのGTOへの言及、PromptへのCPUのPrivateな情報（CPUのPromptの節・Personaの ID・Memoryの項目名）の漏れ、Follow-upの答え・不正・漏れ（`tournamentReviewReport`）。

録画の結果（2026-10-09・`claude-sonnet-5-5`（`review_standard`）・Agent SDK 0.3.289・OAuth・呼び出し11回 / 上限20〔Review 9・Follow-up 2〕）:

| 指標 | 値 |
|---|---|
| Review / 呼び出し | 8 / 9 |
| Structured Output Valid率 / Retry率 / Fallback率 / Insufficient Evidence率 | 0.889 / 0.125 / 0 / 0 |
| 数値Groundingの不正 | 1（`bubble_shove/d0#2`の1回目: 単位を含む値の参照の後ろに単位を重ねた。Retryで通った） |
| Math / KB Grounding率 | 1 / 0.75 |
| Hindsight Leak / CPUのPrivateな情報の漏れ / 障害 / 識別子の残存 | 0 / 0 / 0 / 0 |
| Shoveの前提をassumptionsに書いた | 2 / 2 |
| Chip EVとICMの混同の疑い | 0（判定は値の直前の同じ節〔読点・括弧で区切った範囲〕の語で行い、節に語が無い値は判定しない。初版は文の単位で見て「ICMの必要EquityはChip EVの必要Equityより高い（今回は60.5%と45.5%…）」の並べ方を2件の疑いと誤検知した〔Codexの指摘〕ので、録画の出力は変えずに定義を直して集計し直した。8件の文を読んだ範囲でも実際の混同は0） |
| Solver UnsupportedのReviewのGTOへの言及 | 1件（「Solverの結果は無く、GTOの値ではない」。否定でExact GTOとは書いていない。Exact GTOの言及は0） |
| Latency（ms。min / median / p90 / max） | 13275 / 14280 / 23254 / 23254 |
| 段階評価 | Bubble Shove: mixed_marginal 2・Bubble Call: improvement_suggested 2・ITMのCall: mixed_marginal 2・Turn Bet: reasonable 2 |
| Follow-up | 2件ともanswered（1回で検証を通過）・数値Groundingの不正0・漏れ0 |

- 合格ライン（`REVIEW_EVAL_TARGETS`）はStructured Output Valid率（0.889 < 0.9）だけ届きませんでした（9回中1回の数値Groundingの不正。Retryで回復しFallbackは0）。8件ともChip EVとICMの必要Equityを別の値として並べ、Bubble / ITMで「Chip EVではCall、ICMでは損寄り」と書き分けました。
- 失敗経路: `bubble_call/d0#2`のassumptionsに`{481} Combo`（`N`の無い波括弧）が残りました。数値Grounding（D131）は`{N3}`の参照と単位付きの数値だけを見るので通り、保存する文に波括弧が残ります（値は数値表のCombo数と一致）。検査を変えると録画の出力が不正になり再録画が要るので、この Issue では変えず#208に分けました。#208で、検査は変えずに保存の前の置換（`resolveNumericRefs`）で波括弧だけを外すようにしたので、録画の出力・再生のsummaryは変わりません。
- 結果を見てPrompt / Policyは変えていません（D132）。CI（`tournament-eval.test.ts`）は録画を本番と同じ経路で再生し、集計（`summary`）とTournamentの指標（`report`）が録画時と一致すること・Hindsight Leak・Privateな情報の漏れ・障害が0件・上限の中で取ったこと・録画に資格情報が無いことを確かめます。

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

### Reviewの根拠の欄の卓の傾向のE2E（Issue #169）

`e2e/tests/review-tendency.spec.ts`（1本。Review AIは固定応答）は、Heroが毎Hand Foldして6人卓の1つのSessionで11 Hand以上を重ね、Reviewの根拠の欄の卓の傾向（D122）を確かめます。

1. Heroが判断した最初のHand（前のHandが無い）のReview: 根拠の欄「卓の傾向（Table Tendency）」は「卓の傾向はありません」と出し、項目は出さない（APIのEvidenceは`unavailable`）
2. 十分なHandを重ねた後の、Heroが判断したHandのReview: 項目（VPIP・PFR・攻めの頻度・Showdown）ごとの割合と分子 / 分母・機会があったHandの数・十分か保留かが、`/api/reviews/hands/<handId>/decisions/0`が返す保存済みのEvidenceの値と一致する（HandはhandIdで特定し、説明文から値を拾わない）
3. 画面とAPIの応答に、Persona・Memory・Tilt・Hypothesisの語が無く、Pass B（全員の札）に切り替えていない
4. 1280×720・375×667・320×568で、横スクロールが無く、項目が画面の中に収まり、項目同士・項目の中の要素同士が重ならない

- Heroは毎HandのFoldで、Stackをほぼ減らさずSessionを続ける（Call / Checkだけだと数HandでBustしうる）。Heroが判断しないHand（BBで全員がFoldした等）は、判断のあるHandまで進めてからReviewする。
- `pnpm e2e --repeat-each=10`で10回続けて通ることを、作業ログ（`docs/taskLog/issue-169-review-tendency-ui.md`）に残しています。

### Phase 8（Tournament）のCritical E2E（Issue #191）

Phase 8の通しは、標準の6-max STT（`stt6_hand_count`。D127の値のまま）を1本（`e2e/tests/tournament.spec.ts`）で最後まで遊びます。

1. 最初の画面で「Tournament（10 Hand ごと）」を選んで始める: 6人の卓・見出しとTournamentの欄にLevel 1・10 / 20・BB Ante 20・次のLevel（11 Hand目から）・残り6 / 6人。進行ログのAnteの行はBBの席の1つだけ（D128）。全員がStarting Stack 1,500から始まる
2. Blind / Ante: 10 HandでLevel 2（15 / 30・BB Ante 30）に上がる（12 Hand目まで進める）
3. Resume: 12 Hand目の後にserverを止めて同じDBで起動し直し、画面を読み込み直して同じPresetで「Handを始める」と、同じTournamentの13 Hand目（Level 2・残人数と順位が同じ）として始まり、Stackを持ち越す（Chipの総量9,000は変わらない）
4. Elimination: CPUのBustで残人数が減り、脱落した順に6位から順位が付く（欄の見出しに脱落の人数、6位のPayoutは0pt）
5. Heads-Up: 残り2人になると、次のHandは2人の席で始まる
6. 終了とPayout / Result: Heads-UpでHeroがAll-inして決着させ、Tournamentが終わる。Heroの順位は1位か2位で、順位の決まったPlayerのPayoutはその順位の賞金（50 / 30 / 20%の300 / 180 / 120pt、入賞の外は0pt）と完全に一致する。Heroが優勝なら全員の順位が決まりPayoutの合計は600pt、Heads-UpでBustしたら残ったCPU 1人の順位とPayoutは未決（D129）で合計は300pt。Heroの欄の案内（順位とPayout）とTournamentの欄のResult（未決の注記）
7. ICMのReview: 最後のHandのHeads-UpのAll-inの判断（Important Spotの理由にShort Stack）のReview（Pass A）で、Mathの見出しが「Chip で計算」、Tournamentの欄（ICM / Prize EquityとChip EV）が別の項目として出る。ICM Equityの表（2人の合計はHeads-Upで争う480pt）と、Chip EVの必要EquityとICMの必要Equityの別の列。固定応答はICMの必要EquityのidをEvidenceとして挙げる
8. Replay: 最後のHandのReplayでImportant Spotへジャンプする
9. Restart: 卓に戻り、Heroの欄の選択でTournamentを選んで「新しい Session を始める」と、新しいTournament（1 Hand目・Level 1・6人。前のTournamentのStackを持ち越さず全員1,500）が始まる

- serverの設定は1本目と同じ（`e2e/support/server.ts`。`POKER_SEED`・RuleBot・固定応答で、Claudeを呼ばない。D98）。本番のPresetの値は変えず、テスト用の短いBlind表も足しません。
- HeroはHeads-UpまではCheck / Foldだけで打ってStackを守り（CPU同士のEliminationで残人数が減る）、Heads-UpではAll-in（できなければCall）で決着を早めます。経路はseed・RuleBot・再起動の位置で決まります（再起動するとseedの並びは先頭から使い直す）。この方針と12 Hand目の後の再起動で、Heroは51 Hand目でHeads-Upに入り、52 Hand目で終わります（UIで20秒ほど）。RuleBot・Engineの変更でHeroがHeads-Upの前にBustするようになったら、前提のassert（「Hero は Heads-Up の前に Bust しない」）で落ちるので、再起動の位置かseedを選び直します。
- 進行の判定（残人数・順位・Payout）は`GET /api/hands/:handId/tournament`の値で読み、画面の表示はその値と照らして確かめます。HandはhandIdで特定し、「次の Hand へ」の後は画面が新しいHandに切り替わるまで待ちます（`e2e/support/next-hand.ts`）。
- `--repeat-each=10`を2回続けて通ることを、作業ログ（`docs/taskLog/issue-191-tournament-e2e.md`）に残しています。既存のCashのE2E（`session`・`session-end-layout`・`table-layout`・`learning`・`opponent-memory`・`review-tendency`）はそのまま通します（Cash Regression）。

## 9. Property / Fuzz

有効な用途:

- Random Legal Action Sequence
- Side Pot / Chip Conservation
- Random Stack
- Random Player Count
- Deck Uniqueness

Fuzz Testだけで明示的Rule Scenarioを置き換えないでください。

再現できるようにするため、Property Test（fast-check）は共通のパラメータ（`packages/engine/src/testing/property.ts`の`propertyParams`）でseedを1つに決めて流します。失敗したときはfast-checkの出力（`{ seed: …, path: … }`と縮小済みのCounterexample）がCIのログに出るので、`POKER_PROPERTY_SEED=<seed> pnpm --filter @proj-poker/engine test`で同じ入力を再現し、縮小した反例をScenarioへ昇格させます。`POKER_PROPERTY_RUNS_FACTOR=<整数>`でケース数を倍にでき（時間切れも同じ倍率で延びます）、数万ケースの繰り返しに使います。1テストの時間切れは30秒です（既定の5秒だと、負荷の高いCIで時間切れになり、seedも反例も残らないまま落ちるため。#95）。

Propertyは「任意の入力で不変条件が崩れない」だけを担当します。「River まで進むHand・Out-of-Turnの拘束・打ち切りなど、その種類のHandを検査に通したか」の網羅は、randomなseedに期待せず固定Scenarioで担当します（seedによってはそのHandが1つも出ず、Engineが正しくてもCIが赤になるため。#167）。例として`hand-summary`は、検査を`testing/hand-summary-checks.ts`にまとめ、Propertyと`hand-summary.test.ts`の固定Scenarioが同じ検査を共有します。

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

## 12. Tournament（Phase 8）のテスト

Phase 8のDefinition of Done（#107）の項目と、それを確かめるテストの対応です。Tournamentの順位・Payout・ResultはEvent Logから都度計算するProjectionで、保存しません（D129）。ICMは決定論のCalculatorで計算し、LLMに計算させません（D130）。

| DoDの項目 | テスト |
|---|---|
| 既存Hand Engineを再利用して6-max STTを完走 | `packages/engine/src/tournament.test.ts`（「Rule Profile は Cash と共有し、Blind と Ante を Level の額にする」）・`apps/server/src/tournament-session.test.ts`（「Tournament は Preset の Starting Stack と 1 Level 目の Blind で始め、設定の Snapshot を SESSION_STARTED に残す」）・`e2e/tests/tournament.spec.ts`（§8。開始からHeads-Up・終了まで） |
| Blind / AnteがVersioned Configで動く | `packages/engine/src/tournament.test.ts`（標準Preset・`validateTournamentConfig`・SESSION_STARTEDのSnapshot）・`packages/engine/src/hand-engine.test.ts`（「startHand の Ante と Tournament の Level」）・`hand-engine.property.test.ts`（「Ante（per_player / big_blind_ante）・不均等 Stack … でも Hand は最後まで進み」）・`apps/server/src/tournament-session.test.ts`（「hand_count: Session の Hand の数で 10 Hand ごとに Level を上げ、その Level の Blind と Big Blind Ante で始める」・Resume後のLevelの再構築） |
| time-base / hand-count-baseの契約がある | `packages/engine/src/tournament.test.ts`（「hand_count は Session の Hand の数で handsPerLevel ごとに 1 つ上げ」「time_base はプレイ時間の累計で levelDurationMs ごとに 1 つ上げ」）・`apps/server/src/tournament-session.test.ts`（time_baseの累計・時計の巻き戻り）・`apps/server/src/tournament-table.test.ts`（次のLevelまでの残り） |
| 標準Presetはhand-count + BBA | `packages/engine/src/tournament.test.ts`（「標準 6-max STT は Starting Stack 1,500・10/20 から 10 Hand ごと・BBA の額は BB・50/30/20・参加費 100pt」）・`e2e/tests/tournament.spec.ts`（§8の1・2） |
| Elimination / Placement / Payoutがdeterministic | `packages/engine/src/tournament-standings.test.ts`（同じHandの複数Bust・Heads-Upへの移行・HeroのBust・打ち切り）・`tournament-payout.test.ts`・`tournament-payout.property.test.ts`（端数・同順位・Σ = Prize Pool）・`apps/server/src/tournament-session.test.ts`（Elimination と順位）・`e2e/tests/tournament.spec.ts`（§8の4〜6） |
| 50 / 30 / 20 Presetが動く | `packages/engine/src/tournament-payout.test.ts`（「標準 6-max STT は 100pt × 6 = 600pt を 50 / 30 / 20 で 300 / 180 / 120」）・`e2e/tests/tournament.spec.ts`（§8の6） |
| ICM Calculatorがdeterministicで2〜8人を扱う | `packages/engine/src/icm.test.ts`（手計算のScenario・「8 人を扱える」・「2〜8 人以外 … は拒否する」・Bubble Factor・All-inの必要Equity）・`icm.property.test.ts`（Σ Equity・単調性・対称性） |
| Chip EVとICMを別EvidenceとしてReviewできる | `apps/server/src/review/tournament-evidence.test.ts`（「Chip EV（Pot Odds と同じ）と ICM の必要 Equity を別の id で並べる」等）・`review-tournament.test.ts`（Grounding: ICMの必要Equityのidを挙げない出力は不正）・`apps/web/src/components/tournament.test.tsx`（TournamentEvidenceView）・`e2e/tests/tournament.spec.ts`（§8の7） |
| Tournament ContextがCPU KnowledgeStateにPublic情報として入る | `packages/engine/src/tournament-knowledge.test.ts`（「Session の情報を渡すと、viewer から見た Tournament Context を持つ」「Tournament の値に Hole Cards・Deck は入らない」）・`apps/server/src/opponents/rule-bot.test.ts`（「RuleBot と Tournament Context」）・`claude-opponent.test.ts`（「Tournament の Prompt」） |
| Phase 7 Private MemoryのIsolationがTournamentでも維持 | `apps/server/src/memory/tournament-isolation.test.ts`（Promptの動的な走査）・`observation-cache.test.ts`（「Tournament の context」: 要約はcontextのHypothesisだけ） |
| Push/Fold Nash SolverをPhase 8完了条件にしない | `apps/server/src/review/review-tournament.test.ts`（「Tournament の Spot は Solver の Capability Gate に mode: tournament で渡り、Unsupported（mode）の正常な Fallback になる」）。Tournament Solverは置かない（D102・`docs/08` §4） |
| Tournament Critical E2EとCash Regressionが通る | `e2e/tests/tournament.spec.ts`（§8）と、既存のCashのE2E 11本（`session`・`session-end-layout`・`table-layout`・`learning`・`opponent-memory`・`review-tendency`） |
