# Issue #171: Memory 付き Prompt の Claude CPU の Eval を River で repeat を増やして測り直す

## 概要

#155（PR #170）の初回の実モデル Eval（D123・36 Decision）では、River の Call の割合が baseline / loose / tight で 0.5 / 0.333 / 0.5 と、意図と逆の loose < tight になった。1 条件・1 Persona に 1 判断しかないため、少数標本の揺れかを確かめる。人間判断 D126 のとおり、`river_facing_big_bet` の 3 条件 × Persona 6 × 追加 repeat 2（最大 36 Decision・Retry を含めて最大 72 呼び出し）を、#155 と同じ経路（Claude Agent SDK・Claude Code の OAuth〔サブスク枠〕・`buildClaudeEnv`。API キー不使用）で 1 回だけ録画した。D123 の録画は書き換えず、追加分を別の録画に置き、CI は再生だけで回る。本番の CPU / Review の Prompt・Policy・合成・経路は変えていない。

## 初期調査

- `memory-prompt-eval.ts`（#155）の `MEMORY_PROMPT_EVAL_SPOTS` は、代表 Spot 2 × 条件 3 の Spot を持つ。River の 3 つをそのまま使えば、条件の組み立ては #155 と同じになる。
- ハーネスの `runOpponentEval` は repeat 1〜N を回し、`only` で判断を絞れる。`repeats: 3`・`only: repeat が 2 か 3` にすれば、追加分だけを呼べる。
- Spot の入力は決定論なので、repeat 2・3 の Prompt・Options の指紋（paramsHash）は D123 の録画の repeat 1 と同じになるはず。再生の `replayQueryFor` は判断ごとのキー（Spot/Persona/repeat）で引くので、D123 の録画の River の 18 判断と追加分を合わせて渡せば、合計を本番と同じ経路で再生できる。
- 集計の入口ガード（`assertPopulation`）は repeat が 1 から始まる前提。追加分だけの集計では repeat 2・3 を 1・2 と数え直す必要がある。
- OAuth 以外の経路へ切り替わる変数（`CLAUDE_CODE_USE_BEDROCK` 等）の検査は `memory-prompt-run.ts`（スクリプトの本体）にあり、他のスクリプトから使えなかった。

## 設計方針

- **追加分は別の録画**: `recordings/opponent-memory-prompt-river-repeat.json`。追加分の 36 判断（repeat 2・3）だけを持ち、`summary` は D123 の録画の River の分（repeat 1）と合わせた合計（54 判断）、`addedSummary` は追加分だけの集計。D123 の録画は読むだけ。
- **上限（D126）**: `RIVER_REPEAT_EVAL_LIMITS`（判断 36・呼び出し 72）。判断の数は実行の前に `assertRiverDecisionLimit` で確かめ、呼び出しは #155 の番人（`createCallBudget`）で包む。`--record` は録画が既にあれば実行しない（1 回だけ）。障害が出たら残りを打ち切り、足りない分だけを `--resume` で残りの回数の中で集める（今回は使っていない）。
- **経路**: `buildClaudeEnv` は本番の経路なので変えない。OAuth 以外の経路へ切り替わる変数の検査を `memory-prompt-eval.ts` の `assertOAuthRoute` / `describeRouteEnv` に移し、#155 と #171 の両方の実行スクリプトから使う（表示は変数の有無だけで、値は出さない）。
- **集計**: `riverRateReport` が Persona ごと・条件ごとの Call / Fold / Raise（All-in は分けて数える）の割合と、#155 の `directionReport` の River の行（RuleBot の参照値）を出す。
- **CI**: `river-repeat-eval.test.ts` が、合計と追加分だけの集計が録画時と一致すること・Leakage と障害が 0 件・上限の中で取ったこと・追加分の 1 回目の指紋が D123 の録画と一致することを確かめる。Prompt・Options が変われば指紋が合わず再生が失敗する（drift の検出）。D123 の録画の再生（`memory-prompt-eval.test.ts`）はそのまま通る。

## 変更ファイル

- `apps/server/src/testing/opponent-eval/river-repeat-eval.ts`（新規）: 母集団（River × 条件 3 × Persona 6 × repeat 2・3）・上限・録画の形・D123 の録画の River の取り出し・repeat の数え直し・River の割合の集計
- `apps/server/src/testing/opponent-eval/river-repeat-run.ts`（新規）: 手動の実行（`--dry-run` / `--record` / `--resume`）
- `apps/server/src/testing/opponent-eval/river-repeat-eval.test.ts`（新規）: 母集団と上限・dry-run（呼び出し 0 回・指紋の一致・漏れ 0）・経路の検査・録画の再生
- `apps/server/src/testing/opponent-eval/recordings/opponent-memory-prompt-river-repeat.json`（新規）: 追加分の録画
- `apps/server/src/testing/opponent-eval/memory-prompt-eval.ts`: `OTHER_ROUTE_ENV_KEYS`・`assertOAuthRoute`・`describeRouteEnv` を `memory-prompt-run.ts` から移した（挙動は同じ）
- `apps/server/src/testing/opponent-eval/memory-prompt-run.ts`: 上の関数を使う形に（挙動は同じ）
- `apps/server/package.json`: `eval:opponent-memory-river`
- `docs/09_TEST_STRATEGY.md` §5: #155 の節に「River の追加測定」を追記
- `README.md`: Phase 7 の記述（D126 の「実施待ち」→ 結果）

## 実行した確認

- `pnpm --filter @proj-poker/server eval:opponent-memory-river --dry-run`（モデルの呼び出し 0 回）: 子プロセスの env は `ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`CLAUDE_CODE_USE_BEDROCK`・`CLAUDE_CODE_USE_VERTEX`・`CLAUDE_CODE_USE_FOUNDRY`・`ANTHROPIC_BASE_URL` がすべて「なし」（親の env にも無い）。判断 36・Prompt 36（異なるのは 18 = 3 条件 × 6 Persona）・D123 の録画との指紋の不一致 0 件・Leakage 0・上限の中。
- `pnpm --filter @proj-poker/server eval:opponent-memory-river --record`（1 回だけ。2026-10-08、WSL2 のローカル環境）: env の表示は dry-run と同じ。36 判断を集め、障害なしで終了（終了コード 0）。録画の `modelCalls` は 36・`runs` は 1。`--resume` は使っていない。

### 結果（`claude-haiku-4-5`（`opponent_fast`）・Agent SDK 0.3.289）

(1) River の割合（合計 repeat 3。全 Persona の合計。各条件 18 判断。RuleBot は同じ条件・400 seed）:

| 条件 | Call | Fold | Raise | RuleBot の Call |
|---|---|---|---|---|
| baseline | 0.389 | 0.389 | 0.222 | 0.22 |
| loose | 0.389 | 0.389 | 0.222 | 0.269 |
| tight | 0.389 | 0.389 | 0.222 | 0.138 |

追加分だけの Call は 0.333 / 0.417 / 0.333（baseline / loose / tight）。初回は 0.5 / 0.333 / 0.5。

Persona ごとの Action（repeat 1 / 2 / 3）:

| Persona | baseline | loose | tight |
|---|---|---|---|
| TAG Regular | call / call / fold | call / call / call | call / fold / call |
| LAG | call / raise / call | fold / raise / call | raise / raise / call |
| Calling Station | call / call / call | call / call / call | call / call / call |
| Nit | fold / fold / fold | fold / fold / fold | fold / fold / fold |
| Maniac | raise / raise / raise | raise / raise / raise | raise / raise / fold |
| Weak-tight Recreational | fold / fold / fold | fold / fold / fold | call / fold / fold |

- 初回の loose < tight は repeat 3 では続かなかった（3 条件とも 0.389）。逆向きが続いたのではなく、Claude の River の Call の割合に、相手と卓の傾向の向き（loose / tight）による差が見えない、というのが合計のサンプルでの事実（RuleBot は loose > tight）。
- 同じ条件の中でも判断が揺れた Persona（TAG Regular・LAG・Maniac・Weak-tight Recreational）があり、初回の Weak-tight Recreational の tight での Call、LAG の loose での Fold は 2・3 回目では再現しなかった。Calling Station・Nit は 9 判断とも同じ Action。

(2) Structured Output Valid 率 1・Illegal Action 率 0・Retry 率 0・Fallback 率 0（追加分の 36 呼び出しすべて 1 回目で合法。合計 54 も同じ）。既存の合格ライン（`OPPONENT_EVAL_TARGETS`）にはすべて届いた。

(3) Persona Differentiation: 追加分 0.711・合計 0.711（合計の条件別は baseline 0.733・loose 0.756・tight 0.644）。

(4) Hidden Information Leakage 0（入力と実際に送った Prompt の両方。#155 と同じ走査: 他者の Hole Cards・Future Cards・Deck / seed・他の Preset の名前・reveal / weakness / learning の語・Memory の Subject に自分・Memory の節が 2 つ以上）。

(5) Latency（呼び出しごと。子プロセスの起動を含む）: 追加分 min 7440 ms・中央値 9736 ms・p90 11366 ms・最大 12615 ms。合計 min 7440・中央値 9923・p90 11366・最大 14280 ms。

(6) 実際の呼び出し 36 回（上限 72）。判断 36（上限 36）。実行は 1 回。

### 品質チェック

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 61 files / 775 tests・engine 363・web 141）。D123 の録画（`opponent-memory-prompt-eval.json`）と既存の録画（`opponent-eval.json`）の再生も通過。

## 判断理由

- 追加分は別の録画にした（D126: D123 の録画は残す）。合計の集計は、D123 の録画の River の判断と追加分を合わせて再生して出すので、D123 の録画が変われば合計の再生も失敗して気づける。
- 向きの合格ラインは置かなかった（#155 と同じ。repeat 3 でも 1 条件・1 Persona に 3 判断で、統計の検定には足りない）。新しい暫定値は置いていないので、`docs/11` は変えていない。
- 結果は「逆向きが続く」ではなく「差が見えない」だったので、D126 の「逆向きが続くなら新しい Issue」には当たらないと判断した。Prompt / Policy は変えていない。
- 経路の検査を共有の関数に移したのは、#171 のスクリプトにも同じ検査が要り、写すと片方だけ古くなるため（挙動は変えていない）。

## 残課題

- Claude の River の Call の割合に、Memory・Table Tendency の向きによる差が見えない（合計 repeat 3）。Prompt の改善が要るかは人間判断（D126 の範囲外）。
- 初回の「Check できるのに Fold」（`flop_cbet@tight` の Nit）は Flop の判断なので、River だけの今回の測定では再現を確かめていない。
- Tilt だけの効果は 3 条件では分けて測れていない（#155 から変わらず）。
