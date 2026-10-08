# Issue #155: Memory 付き Prompt の Claude CPU の Opponent Eval を録画する

## 概要

#139〜#142 で Claude の CPU の Prompt に入るようになった Memory（Hypothesis の要約）・Table Tendency・Tilt について、実モデルの品質を Opponent Eval の録画で測った。人間判断 D123 のとおり、`eval:opponent` と同じ経路（Claude Agent SDK・Claude Code の OAuth〔サブスク枠〕・`buildClaudeEnv`）だけで呼び、API キーは使っていない。上限は判断 36・呼び出し 72 で、コードで強制した。CI は録画の再生だけで回る。本番の CPU / Review の Prompt・経路・合成の挙動、既存の録画、マイグレーションは変えていない。

## 初期調査

- 既存の Opponent Eval（#53）は `spots.ts` の代表 Spot に層（Memory・Tilt・Table Tendency）が無く、録画（`recordings/opponent-eval.json`）の Prompt にもその節が無い。
- RuleBot の Opponent Memory の Eval（#142）は、代表 Spot の入力に本番と同じ形の層を足す `withLayers` と、条件（`LAYER_CONDITIONS`）を既に持っている。Claude の Eval でも同じ値を使えば、RuleBot と同じ条件で向きを並べて比べられる。
- `buildClaudeEnv` は `ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN` を外す（`claude-opponent.test.ts` にテストがある）。Bedrock / Vertex / Foundry・別の接続先へ切り替わる変数（`CLAUDE_CODE_USE_BEDROCK` 等）は外さないが、本番の経路なので変えない。
- KnowledgeState の `handId` は Prompt に入るので、層を足した Spot の Hand の ID を元の Spot と同じにすれば、baseline の Prompt は既存の録画と同じになる。

## 設計方針

- **Spot と条件**: 代表 Spot 2（`river_facing_big_bet`・`flop_cbet`。memory-eval の (1) と同じ）× 条件 3（baseline = 層なし、loose = memory-eval の `all_loose`、tight = `all_tight`）。loose / tight は相手（Subject）の Memory と卓の傾向が逆向きで、Tilt はどちらも 3 段（最大）。両者の差は相手と卓の傾向の向きだけになる。Tilt だけの効果は、この 3 条件では分けて測れない（baseline との差に混ざる）。
- **向き**: River の Pot を超える Bet では、攻める（Loose）相手なら Call が増えるのが意図した向き。Flop の C-bet では、C-bet によく降りる（Tight）相手なら Bet（Bluff の C-bet）が増えるのが意図した向き。比べるのは loose と tight の割合（全 Persona の合計）で、同じ条件の RuleBot（400 seed）の割合を参照に並べる。
- **ハーネス**: 既存の `runOpponentEval`（本番の Factory・`checkOpponentOutput` → `applyAction`・1 回の Retry・Fallback）をそのまま使う。`EvalSpot` に `baseSpotId`（Hand の ID の元）と `withLayers`（入力に層を足す）を足し、`buildSpot` が層を足した入力を返す。漏れの検査には、入力の Memory の Subject に自分が入っていないか（他の CPU の Memory を渡した形）・Prompt の Memory の節が 1 つだけか・Prompt に reveal / weakness / learning の語が無いか、を足した。
- **上限（D123）**: `MEMORY_PROMPT_EVAL_LIMITS`（判断 36・呼び出し 72）。判断の数は実行の前に `assertDecisionLimit` で確かめ、モデルの呼び出しは `createCallBudget` の番人で包んで、上限に達したら下の `query()` を呼ばずに例外にする。障害（ログイン・利用枠を含む）が出たら番人を閉じ、残りの判断は呼ばない。
- **1 回だけ**: `--record` は録画が既にあれば実行しない。足りない判断だけを `--resume` で、録画に残した呼び出しの合計（`modelCalls`）を引いた残りの回数の中で集める。
- **dry-run**: `--dry-run` は `query()` を Fake（Schema の check か fold を返す）にしてハーネスの全経路を通し、判断・Prompt の数・節の入り方・漏れを数える（呼び出し 0 回）。
- **CI**: `memory-prompt-eval.test.ts` が録画（`recordings/opponent-memory-prompt-eval.json`）を本番と同じ経路で再生し、集計が録画時と一致すること・Leakage と障害が 0 件・上限の中で取ったことを確かめる。Prompt・Options が変わると paramsHash が合わず再生が失敗する（既存の仕組み）。

## 変更ファイル

- `apps/server/src/testing/opponent-eval/spots.ts`: `EvalSpot` に `baseSpotId`・`withLayers`。既存の Spot は値を持たないので、入力と Hand の ID は変わらない
- `apps/server/src/testing/opponent-eval/harness.ts`: 判断を絞る `only`、Memory の Subject・Memory の節の数・reveal / weakness / learning の漏れの検査
- `apps/server/src/testing/opponent-eval/recording.ts`: `replayQueryFor` の引数を `cases` だけ要る形に（型だけ）
- `apps/server/src/testing/opponent-eval/memory-prompt-eval.ts`（新規）: Spot と条件・上限・番人・dry-run の Fake・向きの集計・足りない判断
- `apps/server/src/testing/opponent-eval/memory-prompt-run.ts`（新規）: 手動の実行（`--dry-run` / `--record` / `--resume`）
- `apps/server/src/testing/opponent-eval/memory-prompt-eval.test.ts`（新規）: Spot と条件・上限の番人・dry-run・漏れの検査の空振りの確認・録画の再生
- `apps/server/src/testing/opponent-eval/recordings/opponent-memory-prompt-eval.json`（新規）: 録画
- `apps/server/package.json`: `eval:opponent-memory-prompt`
- `docs/09_TEST_STRATEGY.md` §5: Memory 付き Prompt の Claude の Eval と結果

## 実行した確認

- `pnpm --filter @proj-poker/server eval:opponent-memory-prompt --dry-run`（モデルの呼び出し 0 回）: 判断 36・Prompt 36（すべて異なる）・Memory / Table Tendency / Tilt の節は 24 の Prompt（loose / tight）に入り、baseline の 12 には入らない・Leakage 0・上限の中。
- `pnpm --filter @proj-poker/server eval:opponent-memory-prompt --record`（1 回だけ。2026-10-08、WSL2 のローカル環境）: 子プロセスの env の表示は「ANTHROPIC_API_KEY なし / ANTHROPIC_AUTH_TOKEN なし」（親の env にも無い）。36 判断を集め、障害なしで終了（終了コード 0）。録画の `modelCalls` は 36・`runs` は 1。`--resume` は使っていない。
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 59 files / 754 tests・engine 363・web 141）。既存の録画（`opponent-eval.json`）の再生も通過。baseline の Prompt・Options の指紋は、既存の録画の同じ Spot・Persona の 1 回目と一致する（テストで確認）。

### 結果（録画の集計。`claude-haiku-4-5`・Agent SDK 0.3.289）

(1) 戦略への反映の向き（見る Action の割合。全 Persona の合計 baseline / loose / tight。RuleBot は同じ条件・400 seed）:

| Spot（見る Action・増える向き） | Claude | RuleBot | Claude は意図した向きか |
|---|---|---|---|
| River（Call・Loose で増える） | 0.5 / 0.333 / 0.5 | 0.22 / 0.269 / 0.138 | ならなかった（loose < tight） |
| Flop（Bet・Tight で増える） | 0.5 / 0.5 / 0.667 | 0.075 / 0.035 / 0.123 | なった（tight > loose） |

Persona ごとの Action（baseline / loose / tight）:

| Persona | River | Flop |
|---|---|---|
| TAG Regular | call / call / call | bet / bet / bet |
| LAG | call / fold / raise | bet / bet / bet |
| Calling Station | call / call / call | check / check / check |
| Nit | fold / fold / fold | check / check / fold |
| Maniac | raise / raise / raise | bet / bet / bet |
| Weak-tight Recreational | fold / fold / call | check / check / bet |

36 判断のうち、条件で Action が変わったのは 4 つの Persona × Spot だけ。River は LAG と Weak-tight Recreational が意図と逆向き（Loose の相手に Fold、Tight の相手に Call / Raise）、Flop は Weak-tight Recreational が意図どおり（Tight の相手に Bet）で、Nit は Tight の相手に Check できるのに Fold した。1 条件・1 Persona に 1 判断なので、向きの差は偶然の幅に入る（結論にしない）。

(2) Structured Output Valid 率 1・Illegal Action 率 0・Retry 率 0・Fallback 率 0（呼び出し 36 回すべて 1 回目で合法）。既存の合格ライン（`OPPONENT_EVAL_TARGETS`）にはすべて届いた。

(3) Persona Differentiation 0.667（River の 3 条件とも 0.733・Flop の 3 条件とも 0.6。Action の組は条件で違うが、同じ Action の Persona の組の数が偶然同じ）。Action Diversity（bit）: TAG 1・LAG 1.792・Calling Station 1・Nit 0.918・Maniac 1・Weak-tight 1.918。

(4) Hidden Information Leakage 0（入力と実際に送った Prompt の両方。他者の Hole Cards・Future Cards・Deck / seed・他の Preset の名前・reveal / weakness / learning の語・Memory の Subject に自分・Memory の節が 2 つ以上、のどれも無い）。

(5) Latency（呼び出しごと。子プロセスの起動を含む）: min 7694 ms・中央値 9581 ms・p90 11008 ms・最大 14280 ms。

(6) 実際の呼び出し 36 回（上限 72）。判断 36（上限 36）。実行は 1 回。

## 判断理由

- 条件は RuleBot の Memory Eval の `all_loose` / `all_tight` をそのまま使った。D123 の条件は最大 3 つで、Memory・Table Tendency・Tilt の 3 つの節を Prompt に入れたうえで、loose と tight の差を相手と卓の傾向の向きだけにするため（Tilt は両方 3 段）。RuleBot と同じ値なので、向きを並べて比べられる。
- 向きの合格ラインは置かなかった。1 条件・1 Persona に 1 判断（D123 の上限）では統計として成立しないため。Valid 率等は既存の合格ラインで見た。新しい暫定値は置いていないので、`docs/11` は変えていない。
- `buildClaudeEnv`（本番の経路）は変えず、Bedrock / Vertex / Foundry・別の接続先へ切り替わる変数は Eval の実行側で「あれば実行しない」にした。

## 残課題

- River の向きが意図と逆で、Flop の Nit は Check できるのに Fold した（Strategic Incoherence の候補 1 件）。1 判断ずつの観察なので、Memory が Claude の判断に効くかの結論には、repeat を増やした測定が要る（呼び出しの回数は人間判断。D123 の上限は初回分）。Prompt の改善はこの Issue の範囲外。
- Tilt だけの効果は 3 条件では分けて測れていない。
