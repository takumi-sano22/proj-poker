# Issue #188: Tournament の KnowledgeState と CPU の適応を作る（P8-6）

## 概要

Tournament の Hand でだけ、CPU の `KnowledgeState` に Public Tournament Context（`tournament`）を足し、Claude の CPU の Prompt と RuleBot がそれを使うようにした。CPU の Memory は、Tournament の Hand の Observation を `tournament` の context で抽出し、Tournament の Hand では `tournament` の Hypothesis を要約に使う。Cash の `KnowledgeState`・Prompt・RuleBot の判断は変えていない。Event・テーブル・列・`schema_version` は足していない（Observation の Cache の抽出の Version だけを上げた。D124 の範囲）。

## 初期調査

- 前提（main 5956566）: 判断の正本は D106（Raw Observation は共通・Hypothesis は context で分離）・D109（Public Tournament Context を KnowledgeState へ。ICM は決定論で LLM を正本にしない）・D121（Memory の注入）・D130（全席の Stack と BB 換算・ICM Equity・Stage・相手ごとの Bubble Factor）。docs/02 §7・docs/05 §10・docs/04 §5 / §12。
- P8-5（#187）の `icmEquities` / `bubbleFactors`、P8-4（#186）の `payoutsByPlace` / `prizePoolOf`、P8-2（#184）の `HAND_STARTED.tournament`（Level と経過）・`ante` を使える。
- `memory/observation.ts` は context を常に `"cash"` で返し、`memory/memory-summary.ts` は `cash` の Hypothesis だけを通していた。Cache（v12・`phase7_observation_v1`）の行の `observed` に context が入っている。

## 設計方針

- **置き場所**: Tournament Context は Hand の Event（public の `HAND_STARTED`）と Session の設定（`SESSION_STARTED` の Snapshot）から作る Projection なので Engine に置いた（`tournament-knowledge.ts` の `tournamentKnowledgeOf`）。`projectKnowledgeState` に省略できる第 3 引数（`{ tournament: TournamentSessionInfo }`）を足し、渡したときだけ `tournament` を持たせる（省略時は今と同じ値で、Cash の Prompt を変えない）。
- **入力**: viewer に見える Event の `HAND_STARTED`（席順・Hand の開始時の Stack・Blind / Ante・Level と経過）と、Session の設定・参加人数だけ。Hand Orchestrator が Hand の開始時に `TournamentSessionInfo` を作り（参加人数は Session の最初の Hand に座った人数）、`HandRuntime` に持って CPU の手番ごとに渡す。Drill・Cash は null。
- **Stack の時点**: Hand の開始時（Blind・Ante を払う前）。Pot に入った Chip の持ち主を決めずに済み、Hand の間は値が変わらない（Memory・Table Tendency と同じく Hand の開始時に決まる）。Hand の途中の Stack・Pot は既存の `seats`・`pot` にある。Review の Evidence（#189）は判断時点で取る。人間判断を経ていないので OI-007 の暫定 Policy（版 `phase8_tournament_knowledge_v1`）。
- **Stage**: D130 の 3 つ（bubble / in the money / heads-up）に当たらない段階が要るので `before_bubble` を足した（OI-007 の暫定 Policy）。
- **数値**: `KnowledgeState` の値は倍精度のまま（RuleBot は丸める前の値で判定）。Prompt に出すときだけ BB 換算・Equity（pt と %）を小数第 1 位、Bubble Factor を小数第 2 位に丸める（docs/02 §7 の表示の丸め）。
- **Prompt**: Tournament の Hand だけ System Prompt の 1 行目をトーナメントの卓にし、「トーナメントの状況」の節（固定の説明と JSON）を足す。説明は「計算済みの値を計算し直さずに使う」で、Push/Fold の Range は渡さない。Memory の節は `tournament` のときだけ 1 行足す。どれも KnowledgeState の有無で出し分ける構造ゲート（条件付きの指示を文で書かない）。LLM の呼び出しの回数・経路は変えない。
- **RuleBot**: 層の合成（`composeTuning`）の最後（Memory の後）に Tournament の層を足した。最後に額を引き上げた相手との Bubble Factor が 1 より大きいときだけ、medium の手の Call のしきい値を `Skill × 0.15 × min(1, BF − 1)` 下げる（版 `phase8_rulebot_tournament_v1`。OI-007 の暫定 Policy）。乱数の引き方・Legal Action の中から選ぶことは変えない。Persona なしの RuleBot は読まない（D71）。既存の合成の上限（±0.2）に入る。
- **Memory の context**: Observation の context を Hand が属する Session の mode（Session の最初の保存済みの Hand の `SESSION_STARTED` の Snapshot）で決める（`sessionContextOf`）。Hand の `HAND_STARTED.tournament` で決めないのは、版 9 の Tournament の Hand（Level を持たない）も Tournament として読むため。Cache に行のある Hand は読み直さず、Cache に無い Hand を抽出するときだけ Session の最初の Hand を読む（1 回の計算の間は Session ごとに使い回す）。v1 の Cache の行は Tournament の Hand も `cash` なので、抽出の Version を `phase8_observation_v2` に上げて作り直させる（表・列は変えない。D124）。

## 変更内容

- Engine（`packages/engine`）
  - `src/tournament-knowledge.ts`（新規）: `tournamentKnowledgeOf`・`tournamentStageOf`・`TOURNAMENT_KNOWLEDGE_VERSION` と型（`TournamentKnowledge`・`TournamentSessionInfo` 等）。
  - `src/projection.ts`: `KnowledgeState.tournament?`・`projectKnowledgeState` の第 3 引数（`KnowledgeStateOptions`）。
  - `src/index.ts`: export。
  - `src/tournament-knowledge.test.ts`（新規）: 4 人残りの Bubble の Scenario（Payout・BB 換算・ICM Calculator と同じ Equity / Bubble Factor・Σ Equity = 600）、viewer ごとの Bubble Factor、Heads-Up、Stage の表、Cash（引数なし）で項目が無いこと、他者の札・Deck を変えても Action が進んでも値が変わらないこと、入力の拒否。
- Server（`apps/server`）
  - `hand-orchestrator.ts`: `HandRuntime.tournament`・`tournamentSessionOf`、CPU の手番で `projectKnowledgeState` に Session の情報を渡す、Memory の要約に Session の mode を渡す。
  - `memory/observation.ts`: `ObservationSourceHand.context`・`sessionContextOf`・`ObservationStore` に `sessionHandIds`。
  - `memory/observation-cache.ts`: `OBSERVATION_EXTRACTION_VERSION` を `phase8_observation_v2` に。Cache に無い Hand の抽出で context を決める。
  - `memory/memory-summary.ts`: 要約の context を入力で受け取る（省略は cash）。
  - `opponents/claude-opponent.ts`: `systemPromptOf`・「トーナメントの状況」の節・Tournament の Memory の 1 行。
  - `opponents/rule-bot.ts`: `tournamentAdjustedTuning`・`RULEBOT_TOURNAMENT_V1`・合成に Tournament の層。
  - `opponents/opponent-agent.ts`: コメント。
  - テスト: `memory/tournament-isolation.test.ts`（新規。Fake の `query()` で Cash の Session〔Pass A / Pass B を作る〕の後に Tournament の Session を進め、全 Prompt の境界を確かめる）、`memory/observation-cache.test.ts`（Session の mode による context・Cache の有無で同じ・context ごとの要約）、`opponents/claude-opponent.test.ts`（Tournament の節・System Prompt・Persona の行・Memory の行）、`opponents/rule-bot.test.ts`（Tournament の層）。
- e2e: `support/opponent-memory.ts` の Store に `sessionHandIds` を足した（型の追従）。
- Docs: docs/02 §7（実装と暫定 Policy）、docs/03（KnowledgeState・Prompt・RuleBot・Observation の context）、docs/04 §5 / §12（`tournament` の形・Observation の context・Cache の Version）、docs/05 §5 / §10（Memory の context・Prompt・RuleBot・境界のテスト）、docs/09（境界のテスト）、docs/11 OI-007（#188 の暫定 Policy）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（worktree のルート）: すべて成功（engine 476 件・web 147 件・server 811 件）。
- Cash の回帰: 既存のテストの期待値は変えていない。Opponent Eval の録画（`opponent-eval.json`・`opponent-memory-prompt-eval.json`・`opponent-memory-prompt-river-repeat.json`）の再生（Prompt・Options の指紋の照合を含む）が通る＝Cash の Prompt は #188 より前と同じ文字列。
- 境界のテストの空振りの確認: Memory の要約に Session の mode を渡す行を一時的に `"cash"` に戻すと `memory/tournament-isolation.test.ts` が失敗することを確かめ、元に戻した。
- 実モデル（Claude）を呼ぶ Eval・録画はしていない（OAuth の利用枠を使う判断は人間判断。Tournament の Prompt は決定論のテストで確かめた）。

## 残課題

- Tournament の Prompt の実モデルでの品質（ICM の使い方・Bubble での Call の絞り方）の Eval は未実施（人間判断）。
- Stack の時点（Hand の開始時）・`before_bubble`・Prompt の丸め・RuleBot の係数は人間判断を経ていない暫定 Policy（OI-007）。
- Review の Evidence（判断時点の ICM・必要 Equity）は #189、画面は #190。
