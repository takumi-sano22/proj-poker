# Issue #139: CPU 自身の Memory だけを KnowledgeState と Prompt に注入する（P7-4）

## 概要

決める側の CPU（Observer）自身の観察から作った Private Hypothesis（#138）を、上限付きの構造化した要約（`OpponentMemorySummary`）にして、その CPU の `KnowledgeState` に `memory` として足した。Claude の CPU は Prompt の「あなたの記憶」の節で受け取り、RuleBot は同じ要約を決定論で使う。人間判断 D28・D40・D106・D117・D118・D121 の具体。表・列・Event の形・`schema_version` は足していない。LLM の呼び出しの回数・経路は変えていない。

## 初期調査

- `KnowledgeState` は Engine（`packages/engine/src/projection.ts`）の Hand 単位の Projection。Memory は保存済みの Hand をまたぐ server 側の Projection なので、Engine の型は変えず、server の `OpponentInput.knowledge` を `KnowledgeState` を広げた `CpuKnowledgeState`（`memory?`）にした。
- `buildOpponentHypothesesFromStore`（#138）は Observer ごとに全ての保存済み Hand を読む。CPU ごとに呼ぶと同じ Hand を CPU の数だけ読むので、1 回の計算の間だけ読み出しを使い回す。
- Opponent Eval（`testing/opponent-eval/`）の Spot は `projectKnowledgeState` の結果をそのまま使うので、Memory の無い入力の Prompt を #139 より前と同じ文字列に保てば、録画の `paramsHash` は変わらない（再録画は不要。API キーも使わない）。
- 既存の `learning/learning-isolation.test.ts` は `learning/` の中にあり、本 Issue では `learning/` を触らないので、同じ考え方の検査を `memory/` に新設した。

## 設計方針

- **作る時点（決定論）**: Hand Orchestrator の `startHand` で、その Hand を Event Store へ書く前に、座っている CPU ごとに作る（入力は保存済みの Hand だけ）。Hand の間は同じ要約（再要求・Fallback・Emergency Bot も同じ）。順序は `ordinals.ord`・`events.seq`（D117）。
- **Observer / Subject**: Observer は `session_participants` の参加者（Fixed CPU / Guest）。参加者の行の無い CPU（v10 より前の Session・Drill）には作らず、`memory` を項目ごと持たない（Prompt を変えない）。Subject は今の Hand の他の参加者を席順に、その席の `playerId`（この Hand の中だけの対応）・参加者の参照・見た Hand の数で並べる。cash の Hypothesis だけ。
- **上限（`phase7_memory_injection_v1`）**: Subject ごとに機会のある項目を重み付きの機会の多い順に 5 つまで（D121）。項目は割合（小数第 2 位で丸める）・重み付きの機会の数・機会の数・十分か・Evidence の全件数・新しい Evidence ID（`<hand_id>#<seq>`）3 件まで（3 は OI-011 の暫定値）。
- **Skill**: Observer の Persona の Skill（Fixed CPU は Pool の Persona、Guest は席の Persona、無ければ平均 0.5）。
- **Claude の Prompt**: `memory` を Hand の情報の節から外し、ある時だけ「あなたの記憶」の節（固定の読み方の説明＋構造化データのままの JSON）に入れる。使う強さは Persona の Adaptability / Opponent Reading Quality に任せる。
- **RuleBot（`phase7_rulebot_memory_v1`。係数は OI-011 の暫定値）**: 読みの強さ＝Persona の Skill・Adaptability・Opponent Reading Quality の平均（Persona なしは 0 で Memory を読まない＝D71 の挙動のまま）。ずらすのは 2 つのしきい値だけ: medium の手の Call（この Street で最後に額を上げた相手の `aggression_frequency`、基準 0.35）と、Postflop の weak の手の Bluff（降りていない相手全員の `fold_to_cbet_flop` の最小、基準 0.45）。幅は最大 0.15 × 読みの強さ。十分な Sample の項目だけを読み、乱数の引き方は変えない。Action は Legal Action の中から選ぶので Illegal にならない（D40）。

## 変更ファイル

- `apps/server/src/memory/memory-summary.ts`（新規）: `summarizeOpponentMemory`・`buildOpponentMemoriesFromStore`・`PHASE7_MEMORY_INJECTION_V1`
- `apps/server/src/memory/observation.ts`: `participantRefOf` を export、Store の引数を読み出しに使う部分（`ObservationStore`）に絞った（挙動は不変）
- `apps/server/src/memory/opponent-hypothesis.ts`: 同上の型だけ
- `apps/server/src/opponents/opponent-agent.ts`: `CpuKnowledgeState`
- `apps/server/src/opponents/claude-opponent.ts`: 「あなたの記憶」の節
- `apps/server/src/opponents/rule-bot.ts`: `memoryReadingOf`・`memoryAdjustedTuning`・`RULEBOT_MEMORY_V1`
- `apps/server/src/hand-orchestrator.ts`: Hand の開始時に Memory を作り、CPU の入力に足す
- テスト: `memory/memory-summary.test.ts`・`memory/memory-injection-isolation.test.ts`（新規）、`opponents/claude-opponent.test.ts`・`opponents/rule-bot.test.ts`（追加）
- docs: `docs/03`（opponents・memory・Claude の呼び方・KnowledgeState）・`docs/04` §5・§12・`docs/05` §1・§5・`docs/09` INV-TEST-008・`docs/11` OI-011（暫定値の置き場所の追記。確定はしない）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 640 件・engine 363 件・web 141 件）
- Isolation（必須の 4 点）:
  1. 静的: `opponents/`・`hand-orchestrator.ts`・`memory/memory-summary.ts` から import をたどって `learning/` に届かず、Learning-only Reveal を参照しない（陽性: Orchestrator から `memory-summary.ts` に届くこと）
  2. 動的: Fake の `query()` で Pass A（Hero の弱点の Hypothesis）と Pass B を作った後に 2 Session・計 7 Hand を進め、Claude の CPU の全 Prompt で、他者の札・Pass B の文・Hero の Hypothesis の id / type・他 CPU の Persona の名前が出ず、Memory の全 Evidence が Observer 自身の座っていた Hand の Subject の public の `ACTION_TAKEN` であること
  3. Guest: 前の Session の Guest の id が次の Session の Prompt に出ない／Guest が Observer・Subject の Evidence は今の Session の Hand だけ（Prompt と Store の両方）
  4. Observer が座っていなかった Hand（Bust・別の Session）の Evidence が出ない（Store から・メモリ内 / SQLite）
- 変異の確認（手元で入れて戻した）: 全 CPU の Memory を最初の CPU の観察から作るようにすると、Isolation のテスト 3 件が落ちる
- Prompt の目視: Memory の節が構造化データのまま入り、札・Persona の語を含まないことを 1 回出力して確認した
- Opponent Eval: 録画の再生テスト（`harness.test.ts`）は変更なしで通る（Memory の無い入力の Prompt は同じ文字列）

## 残課題

- Opponent Eval の Spot は Memory の無い入力だけで、Memory を使う Prompt の品質はまだ測っていない（測るなら API キー不要の OAuth の手動 Eval で、Spot に Memory を足して録画を取り直す。別 Issue）。
- Hand の開始ごとに保存済みの全 Hand を読む（CPU 間では使い回す）。遅くなったら Cache を別 Issue で足す（D111 と同じ方針）。
- Opponent Memory Reset（#143）の区切りは未対応（#143 で入力の Hand を区切る）。
