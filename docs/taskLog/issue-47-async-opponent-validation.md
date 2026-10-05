# Issue #47: OpponentAgent の非同期化と、出力の検証・1 回 Retry・Fallback・障害

## 概要

Phase 3（AI Opponents）の 2 つ目の子 Issue。LLM の Opponent を差し込めるよう `OpponentAgent.decide` を Promise を返す形にし、Orchestrator に CPU 出力の検証（Schema → Legal Action → Amount Range）・Correction 付きの 1 回 Retry・RuleBot による Deterministic Fallback（D41）と、応答時間の上限・例外を「障害」として Hand を止める扱い（D86 の前段）を入れた。Event の形・`schema_version`・永続化スキーマは変えていない。Claude API SDK は入れていない（Fake Model だけで検証）。

## 初期調査

- `hand-orchestrator.ts` の `advance()` / `cpuTurn()` は同期で、`botDelayMs > 0` のときだけ `setTimeout` で 1 手ずつ予約していた。出力は `applyAction` だけで検証し、拒否・例外は Check / Fold の Safe Fallback にしていた。
- `startHand` / `heroAction` を呼ぶのは `routes/hands.ts` と、テスト（`hand-orchestrator.test.ts`・`sqlite-event-store.test.ts`）。
- D41（不正出力は 1 回 Retry → Deterministic Fallback）、D86（API エラー・タイムアウトは Hand を止めてユーザーに選ばせる。Invalid Output は対象外）、D83（Event への記録は #48）、OI-001（Latency Policy は未確定）。

## 変更内容

- `opponents/opponent-agent.ts`: `decide(input): Promise<unknown>`。期待する形 `OpponentOutput`（`action`・bet / raise だけの `amount`・任意の `rationale`）と、再要求で渡す `correction`（段と理由）を足した。
- `opponents/opponent-output.ts`（新規）: `checkOpponentOutput(raw, legal)`。Schema（オブジェクト・知らない項目なし・action の種類・amount の有無と整数・rationale の型）→ Legal Action → Amount Range の順に検証し、最初に引っかかった段と理由を返す。
- `opponents/rule-bot.ts`: 同期の `choose`（判断の本体。Fallback が直接使う）と、それを `OpponentOutput` にして返す `decide` に分けた。判断は変えていない。
- `hand-orchestrator.ts`:
  - `startHand` / `heroAction` を async に。`botDelayMs === 0` なら CPU の手番が尽きるまで待って返す（従来と同じ応答）、`> 0` なら待たずに返して SSE で 1 手ずつ届ける（従来と同じ）。
  - CPU を進める処理を Hand ごとに 1 本だけにした（`running`）。待ち（思考待ち・判断待ち）の後に Log が進んでいれば、その判断を捨てる（従来の seq の規律を維持）。
  - 1 手: 判断を求める → 検証 → `applyAction`。不正なら `correction` 付きで 1 回だけ再要求、再度不正ならそのCPU と同じ seed の `RuleBot.choose` で続ける。不正な出力・Fallback は運用 Metadata（`invalidOutputsOf` / `fallbacksOf`）と logger に残す。
  - 障害: `decide` の例外（同期の throw・reject）と上限超過は `outage`（`outageOf`）として保持し、その Hand の CPU を止める。Retry も RuleBot への切り替えもしない。上限の後に届いた判断は捨てる。`close()` は待ちを打ち切る。
- `config.ts`: `DEFAULT_OPPONENT_TIMEOUT_MS = 15000`（暫定値）と `parseOpponentTimeoutMs`。`index.ts`・`app.ts` で `OPPONENT_TIMEOUT_MS` から配線。
- `routes/hands.ts`: ハンドラを async にして `await`。
- テスト: `opponent-output.test.ts`（各段の不正・境界値・段の順）、Orchestrator の Fake Model テスト（不正 → 正常、不正 → 不正 ×3 段、常に不正なら RuleBot と同じ Event Log、例外〔reject・同期 throw〕、不正 → 例外、遅延〔上限超過・上限以内〕、判断待ち中の close）、`config.test.ts`・`rule-bot.test.ts` の追加。既存テストは async 化に合わせた。
- docs: docs/03 §1（Orchestrator・opponents の説明）・§5（実装の節）、docs/04 §3 の運用 Metadata の記述、docs/11 OI-001 に Latency の暫定値、README の環境変数表。

## 判断理由

- `decide` の戻り値を `unknown` にした: LLM の出力は形も信用できないため、Adapter ごとに検証させず Orchestrator の 1 か所で Schema から検証する。期待する形は `OpponentOutput` として型で示す。
- 例外を「障害」に寄せた: 従来は例外も Safe Fallback だったが、D86 は API エラー・タイムアウトを Hand の一時停止にしている。例外は API 障害の現れ方なので、不正な出力（D41 の自動 Fallback）とは分けた。
- 応答時間の上限は decide の 1 呼び出しごと（Retry は別に数える）。上限の暫定値 15 秒は、Haiku 級の応答に余裕を持たせつつ、D65（長いときだけ技術状態を表示）の「長い」に当たる値として置いた仮の値。
- Fallback の RuleBot は CPU の Agent と別インスタンスで、同じ seed から作る。Fallback だけが乱数を消費するので、常に不正な CPU は通常の RuleBot と同じ Event Log になる（決定論をテストで確認）。
- 検証を通った出力を Engine が拒否した場合も不正（Legal Action）として扱う。合法性の最終判断は Engine（D40）。
- Schema は余分な項目・bet / raise 以外の `amount` を不正とした（Hero の API の schema と同じ厳しさ）。LLM の出力の正規化が要るなら Model Adapter（#50）の側で行う。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）: すべて成功（engine 155 件・server 87 件・web 31 件）
- server を `BOT_THINK_DELAY_MS=50`・`POKER_DB_PATH=:memory:` で起動し、`POST /api/hands` が待たずに返り（CPU の手番で `in_hand`）、SSE の View が CPU 3 手の後に Hero の手番になっていることを確認した（起動したプロセスは `timeout` で終了済み）

## 残課題

- Event への記録（`AI_ACTION_INVALID` / `AI_FALLBACK_USED`・版 4）は #48。運用 Metadata の `invalidOutputsOf` / `fallbacksOf` を置き換える。
- 障害で止まった Hand の続け方（Retry / Emergency Bot / Session 終了）の API / UI と、障害状態の Hero への通知は #52。今は止まった Hand が CPU の手番のまま残る。
- Claude API の Model Adapter は #50。
