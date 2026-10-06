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
- **CI**（`harness.test.ts`）: Claudeを呼ばず、録画した出力を本番と同じ経路で再生して集計し直し、録画時の集計と一致すること・Hidden Information Leakageと障害が0件であることを確かめます。録画は判断ごとに渡した引数（Prompt・Options）の指紋を持ち、Prompt・Persona・Schema・単発化の設定が変わると再生が失敗します（手動のEvalで録画を取り直す）。

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

## 9. Property / Fuzz

有効な用途:

- Random Legal Action Sequence
- Side Pot / Chip Conservation
- Random Stack
- Random Player Count
- Deck Uniqueness

Fuzz Testだけで明示的Rule Scenarioを置き換えないでください。
