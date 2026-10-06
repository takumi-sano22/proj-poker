# Issue #82: Review AI（Pass A）・Evidence Sufficiency Gate・Version 付きの Review を作る

## 概要

Phase 5 の子 Issue。保存済みの Hand の Hero の判断ごとに、判断時点の情報だけで作った Evidence（Decision Context / Math / Range / Opponent Observation / Solver / Knowledge）を Review AI（Claude。`review_standard` / `review_deep`）に渡して Pass A の Decision Review を作り、`reviews` テーブルに Version 付きで追記する（上書きしない）。生成は非同期で、API は待ちの状態を返す（UI は #84）。Claude の呼び出しは Opponent の `query()` の部分を共通の関数に切り出して両方から使う。Review Eval の最小形（固定 Hand・録画の再生）も置いた。

## 初期調査

- 前提（main 17471be）: #78 の `heroInformationSets` / `extractImportantSpots`、#79 の `analyzeDecision` / `compareRangeProfiles` / `villainRange`、#80 の `searchKb`（hit は `evidenceId`）、#81 の Solver Adapter（`supports` → `analyze`。Unsupported は正常系）。Claude の呼び出しは `opponents/claude-opponent.ts` の `decide` に直書き。
- 根拠: docs/05 §6〜§10・§13、docs/03 §3・§7・§8、docs/04 §8、docs/09 §6、D05・D07・D19・D22・D24・D39・D87・D94・D95・D97、OI-001。ガイダンス llm / ai-boundary / db / async、台帳 LC-001・LC-022・LC-030・LC-050。
- Solver は Street の最初の判断（OOP）の戦略しか返さない（`node.actor: "oop"`）。Hero 側の Range を作る関数が Engine に無かった（`villainRange` は Hero を拒否し、Hero の札を Card Removal する）。
- 既存の `testing/leaks.ts` の `forbiddenKeys` は語 "Persona" を禁止語として見るが、Curated KB の本文には「Secret Persona を根拠にしない」という文がある（静的な文で Hidden Information ではない）。

## 設計方針

- **呼び出しの共通化**（`claude/structured-query.ts`）: `runStructuredQuery` に単発化の設定・env・AbortSignal・失敗の分け方を移し、`ClaudeOpponent` は `ClaudeCallError` を `ClaudeOpponentError` に包み直すだけにした。Options の並びは Opponent Eval の録画の指紋に入るので変えない（再生が通ることで確認）。`maxTurns` だけ引数にし、既定 1（Opponent は変わらない）。
- **Evidence**（`review/evidence.ts`）: 入力は `HeroInformationSet` だけ。`KnowledgeState` をそのまま渡さず whitelist で写す（席の札は持たず Hero の札は 1 回だけ）。Monte Carlo の seed は入れない。Range の想定の比較（D08）は Important Spot だけ（計算が重い）。KB は判断時点の Spot の特徴で上位 4 項目。Opponent Observation は記録が無いので `unavailable`、User Read は `not_collected`。Card は Card の形のまま持ち、Prompt で表記にする（既存の `leakedCards` で検査できるように）。
- **Solver**（`review/solver-evidence.ts`）: 構造（人数・Street・Side Pot・Rake 0・Bet Tree）で `supports` を通し、Unsupported はその理由のまま。HU で Hero がその Street の最初の手番のときだけ解く（Bet への直面・IP は `not_applicable`）。Range は相手が `villainRange`、Hero は Engine に足した `heroRange`（相手から見た Hero の Range。Board だけを除き、Hero の札は使わない）。失敗の本文・未導入の理由（パス）は Evidence に入れない。Hand Class の頻度は Class の Combo を合わせたものという前提を足す。
- **Gate**（`review/sufficiency.ts`）: 判断時点の卓が読めない・Equity も Supported の Solver も無い・KB の項目が無い のどれかで Review AI を呼ばずに Insufficient Evidence。Web へは進まない（D94）。
- **Review AI**（`review/review-ai.ts`・`generate.ts`）: 構造化出力は平らな項目（`assessment` / `confidence` / `practical` / `theoryBasis` / `theory` / `exploitBasis` / `exploit` / `assumptions` / `conclusionChangers` / `evidenceIds`）。`theoryBasis: solver` と `evidenceIds` の候補は Schema の enum でその Evidence に絞り（条件付きの指示を文で書かない）、検証でも Schema → Grounding の順に確かめる。不正なら理由を付けて 1 回だけ再要求、2 回続けて不正なら Insufficient Evidence にして失敗を残す。Claude の呼び出しの失敗は例外のまま（Review を作らない）。
- **保存**（`review/review-store.ts`・マイグレーション v3）: `reviews` テーブル（D95 で承認済み）。`UPDATE` は Trigger で拒否、`(hand_id, decision_index, pass, version)` は一意、Version の採番と追記は `BEGIN IMMEDIATE` の 1 トランザクション（LC-022）。`hand_id` は `hands` を参照。DB は Event Store と共有（`index.ts` で 1 回開く）。
- **非同期**（`review/review-service.ts`・`routes/reviews.ts`）: POST で生成を始めて 202 と pending を返し、GET で状態を読む。同じ判断を生成中なら新しく始めない（LC-030）。生成は 1 つずつ順に進める。Claude の呼び出しには `REVIEW_TIMEOUT_MS` を掛け、アプリの終了で Claude・Solver の子プロセスを止める。失敗は種類だけを返す（本文はログ）。`buildApp` の既定の Review AI は「呼ぶと失敗する query」で、テストが Claude を呼ばない（D87）。

## 変更内容

- `apps/server/src/claude/structured-query.ts`（新規）・`opponents/claude-opponent.ts`（共通化。re-export で既存の import 先は維持）
- `apps/server/src/review/`（新規）: `types.ts`・`evidence.ts`・`solver-evidence.ts`・`sufficiency.ts`・`review-ai.ts`・`generate.ts`・`review-store.ts`・`review-service.ts` とテスト 5 本
- `apps/server/src/routes/reviews.ts`（新規）とテスト、`app.ts`（Review の組み立て）、`index.ts`（DB を 1 回開いて Event Store と Review Store で共有・KB・Solver・SDK の query）
- `apps/server/src/db/database.ts`: マイグレーション v3（`reviews`・Trigger）。`database.test.ts` に v2 → v3・追記だけのテスト
- `apps/server/src/config.ts`: `MODEL_ROLES` に `review_standard: claude-sonnet-5-5`・`review_deep: claude-opus-5-5`（D97）、`REVIEW_TIMEOUT_MS`（暫定 120000）、`SOLVER_TIMEOUT_MS` の既定を 20000 → 60000
- `packages/engine/src/range-model.ts`: `heroRange` を追加（`villainRange` と同じ作り方を共通の関数に寄せた。`villainRange` の挙動は不変）とテスト
- `apps/server/src/testing/review-eval/`（新規）: `hands.ts`（固定 Hand 3 つ）・`harness.ts`・`metrics.ts`・`recording.ts`・`run.ts`・`harness.test.ts`・`recordings/review-eval.json`、`package.json` に `eval:review`
- docs: `03` §3・§7・§8、`04` §8・§10・§11、`05` §6・§8、`09` §6、`11` OI-001、README（環境変数の表・Claude の認証）

## 判断理由

- **Solver を Root の判断だけに当てる**: Solver の結果は Street の最初の判断（OOP）の戦略だけなので、Bet への直面・IP の判断に当てると別の Node の戦略を Hero の判断の根拠にしてしまう（不変条件 5 の誠実さ）。`not_applicable` として理由を前提に渡す。
- **Hero 側の Range を Engine に足した**: Solver は両者の Range が要る。相手から見た Hero の Range は相手と同じ公開情報の作り方で作れ、Server で Engine の処理を複製しない方が一貫する。Hero の実際の札を Range から除いたり足したりしない（相手は知らない）。
- **Schema を平らにし、`maxTurns: 2`**: 実測（下記）で、入れ子の `theory: { basis, text }` を Sonnet 5.5 が JSON として壊し（`"theory": Solver の結果は…` と引用符なし）、`maxTurns: 1` では SDK の直しのターンが使えず全件 `error_max_turns` になった。平らにして直しの 1 ターンを許したら 12 回中 12 回が 1 回目で検証を通った。
- **SOLVER_TIMEOUT_MS を 60 秒に**: #81 の 20 秒は #76 の狭い固定 Range の実測からで、Range Model の広い Range（SB の Call 221 Combo 対 BTN の Open 449 Combo・SPR 約 14）の Turn は約 33 秒で 20 秒では Timeout した。Review は非同期なので待てる。暫定値（OI-001 / OI-002 の範囲。永久仕様にしない）。
- **失敗した生成は行を作らない**: Claude の障害で Insufficient Evidence を保存すると「根拠不足」と「呼べなかった」が混ざる。障害は状態だけを返して再要求を待ち、不正な出力（モデルの問題）だけを Insufficient Evidence として保存して失敗を残す（LC-001）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 328・web 109・server 361）/ `pnpm format:check`: 通過。
- Opponent の既存テストと Opponent Eval の録画の再生: 共通化の後も通過（引数の指紋が一致）。
- **Review Eval（手動・実際の Claude）**: 2026-10-06、`claude-sonnet-5-5`、SDK 0.3.289、Claude Code 2.1.291 のログイン（`ANTHROPIC_API_KEY` 未設定）。4 判断（BTN の Preflop の Call / River の大きい Bet への Call / SB の HU Turn の最初の Bet / 3 人の Flop の Call）。
  - 1 回目（入れ子の Schema・`maxTurns: 1`）: 8 回の呼び出しすべてが構造化出力を返せず（JSON の崩れ → `error_max_turns`）、4 件とも Insufficient Evidence（Fallback）。Latency 12.9〜22.4 秒。→ Schema を平らにし `maxTurns: 2` に変更。
  - 2 回目・3 回目（`--record`）・Solver あり（`--solver`）: 12 回すべて 1 回目で検証を通過（Retry 0・Fallback 0・Hindsight Leak 0・障害 0・Math / KB Grounding 1.0）。1 回あたり 12.5〜24.3 秒（2 回目 12.5〜16.6・3 回目 14.5〜24.3・Solver あり 14.0〜20.7）。段階評価は mixed_marginal / improvement_suggested / reasonable に分かれた。
  - Solver あり（`POKER_SOLVER_HOME` に #81 のビルド）: SB の HU Turn の Bet が `supported`（Range 全体 Check 約 71%・Bet 50% 約 29%、98s は Bet 約 55%）。説明は「Hand Class の頻度で 9h8h 単体ではない」「Bet Tree に 50% Pot しかない」「Exact GTO ではなく近似」と前提を添えた。River の Bet への Call は `not_applicable`（Root の後）、3 人の Flop は `unsupported: player_count`。Turn の Solve は Evidence の組み立て全体で約 33 秒（1 回の実測）。
  - 気になった出力: SB の Turn の Review で、Board のハートが 1 枚なのに「Hero 自身がハートのドローを持つ」と書いた回があった（Judge が無いので数値化していない。Uncertainty・誤読は Judge の設計で扱う）。BTN の Preflop は、まだ動いていない Blind の Range を `random` とする #79 の Range Model の前提を、Review AI 自身が「Equity を過小評価している可能性」と指摘した。
- **API の通し（手動）**: 一時 DB（`POKER_DB_PATH`）・Solver あり・RuleBot の卓で server を起動し、HTTP で Hand を進めて Important Spot の判断 3 つ（3 Hand）に POST → GET。3 件とも 202（pending）→ `review_ai` で保存（Version 1・`claude-sonnet-5-5`・KB 1.0.0）。POST から保存まで 13.6 / 14.5 / 27.6 秒。段階評価は strong / improvement_suggested / mixed_marginal。DB の `user_version` は 3、server のログに error / warn なし。

## 残課題

- UI（Review の表示・「詳しく」・Jump to Important Spot）は #84、Pass B（Reveal Review）は #83。
- Uncertainty の表現・Assumption を変えたときの Recommendation の変わり方・説明の誤読（上のハートの例）は Judge が要り未測定（docs/09 §6）。Human-reviewed Hand の Regression Case も未設定。
- Opponent Observation（相手の傾向の記録）が無いので Exploit は常に `none`。記録ができたら Schema の enum に `observation` が入る。
- 生成の状態（pending / failed）はサーバーのメモリだけで、再起動で消える（行は残る）。
- `review_deep`（Opus）の Latency は未測定。
