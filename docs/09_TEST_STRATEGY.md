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

CPU Memoryができるまでは、Learning-only Full Reveal（`projectLearningReveal`）でだけ見える札が、どのCPUの`KnowledgeState`（Handの全prefix）にも、判断時点のHero Information Set（Pass Aの入力）にも入らないことで確かめます（`packages/engine/src/hand-summary.property.test.ts`。#78）。Runtime側（#83）では、Hand 1のPass B（全員の札をReview AIに渡す）とそのFollow-upを作った後にHand 2を続け、両HandのClaude OpponentのPromptに入る札がその時点でそのCPUが知ってよい札だけであること・Learning-onlyの印が無いことを確かめます（`apps/server/src/review/learning-reveal-isolation.test.ts`）。Pass Aへの質問（Follow-up）のPromptに、判断時点のHeroが知り得ない札が入らないことも確かめます（`review/reveal.test.ts`・`routes/reviews.test.ts`）。

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
- **出力の検証と生成**（`generate.test.ts`）: Schema（形・enum・文字数）とGrounding（実在しないEvidence ID・Solverの結果が無いのに`solver`・Observationが無いのに`observation`）の不正、1回のRetry、2回続けて不正ならInsufficient Evidence（失敗の記録）、Evidence Sufficiency GateでReview AIを呼ばないこと、`depth`ごとのModel Role、Claudeの呼び出しの失敗を例外のまま伝えること。
- **保存とAPI**（`review-store.test.ts`・`review-service.test.ts`・`routes/reviews.test.ts`）: Versionの追記と上書きの拒否（メモリ内とSQLiteの両方）、非同期の生成（202・pending）、二重の要求で1回だけ作ること、上限の超過（timeout）・アプリの終了で子プロセスを止めること、生成を1つずつ順に進めること、失敗の種類だけを返すこと、404 / 409 / 400。

### Review Eval の最小形（Issue #82）

- **置き場所**: `apps/server/src/testing/review-eval/`（buildの対象外。AI Opponent Evalと同じ形）。`hands.ts`（積んだDeckとActionの列で最後まで進めた固定Hand）・`harness.ts`（判断ごとにReviewを作る）・`metrics.ts`（集計・合格ライン）・`recording.ts`（録画と再生）・`run.ts`（手動実行）。
- **代表の判断**: BTNのHeroがUTGのOpenにCall（Preflop）・同じHandのRiverの大きいBetへのCall（Important Spot）・SBのHeroがHUのTurnで最初にBet（SolverのRoot）・3人のFlopでBetにCall（Multiway）の4つ。
- **本番と同じ経路**: Evidenceは`buildReviewEvidence`、生成は`generateReview`（`ReviewService`と同じ関数）で、差し替えるのはSDKの`query()`だけです。Solverは録画の再生で結果が揃うよう未導入に固定します（Supported のSolver Evidenceを渡したReviewは`--solver`の手動実行で確かめる。録画には使わない）。
- **手動の Eval**: `pnpm --filter @proj-poker/server eval:review [--repeats 1] [--depth standard|deep] [--solver] [--record]`。Claude CodeのOAuth（サブスク枠。D87）で呼び、指標と合格ラインを表示し、`--record`で録画（`recordings/review-eval.json`）に書きます（障害が1件でもあれば書かない）。
- **CI**（`harness.test.ts`）: Claudeを呼ばず、録画した出力を本番と同じ経路で再生して集計し直し、録画時の集計と一致すること・Hindsight Leakと障害が0件であることを確かめます。Evidence・Prompt・Schema・KBが変わると引数の指紋が合わず、再生が失敗します（手動のEvalで録画を取り直す）。

指標の定義（`metrics.ts`）:

| 指標 | 定義 | 合格ライン（暫定） |
|---|---|---|
| Structured Output Valid率 | 呼び出し（Retryを含む）のうち検証（Schema・Grounding）を通った割合 | 0.9以上 |
| Retry率 / Fallback率 | 判断のうち1回目が不正だった割合 / 2回続けて不正でInsufficient Evidenceにした割合 | Fallback率 0.05以下 |
| Insufficient Evidence率 | Gate・Fallback・Review AI自身の判断のすべて | 表示のみ |
| Hindsight Leak | EvidenceかPromptに判断時点のHeroが知り得ない情報が入っていた判断の数 | 0件（1件でも不合格） |
| Math Grounding率 | Review AIが書いた判断のうち、Math EvidenceのIDを根拠に挙げた割合 | 0.9以上 |
| KB Grounding率 | Review AIが書いた判断のうち、KBの項目（実在するID）を根拠に挙げた割合 | 0.5以上 |
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

## 9. Property / Fuzz

有効な用途:

- Random Legal Action Sequence
- Side Pot / Chip Conservation
- Random Stack
- Random Player Count
- Deck Uniqueness

Fuzz Testだけで明示的Rule Scenarioを置き換えないでください。
