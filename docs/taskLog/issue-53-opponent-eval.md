# Issue #53: AI Opponent Eval の最小ハーネスを作り、README を Phase 3 の到達点に更新する

## 概要

Phase 3（AI Opponents）の最終 PR。docs/09 §5 の AI Opponent Eval を、代表 Spot の固定 Regression Case と指標の集計で最小限作った。手動の Eval は Claude Code の OAuth（サブスク枠。D87）で実際に呼び、CI は録画済み応答を本番と同じ経路で再生して集計する（Claude を呼ばない）。#51 の残課題（Calling Station が `call` に amount を付けて Retry になる）を Eval で再現し、Prompt の 1 か所を変えて減らした。README を Phase 3 の到達点に更新した。Event の形・`schema_version`・永続化スキーマ・検証（`checkOpponentOutput`）は変えていない。

## 初期調査

- 前提（main 02d5697）: `ClaudeOpponent`（#50）・Persona 6 種（#51）・検証 / Retry / Fallback（#47。Orchestrator の `cpuTurn`）・AI Event 版 4（#48）・障害時の 3 択（#52）。手動の計測は `testing/claude-smoke.ts`（#50）が Hand を頭から進める E2E 型だった。
- E2E 型は前の判断のブレで局面が揃わず、Persona 間の比較ができない（`llm-quality-improvement` harness 1）。Eval は「Engine で判断の直前まで進めた単発の局面」を Spot として持つ形にした。
- Engine の `testing/stacked-deck.ts` は package の exports に無いので、Runtime 側に同じ配布順の小さな関数を置いた。
- 台帳 LC-050（ハーネスと本番の引数組み立ての一致）: CPU は本番の `createClaudeOpponentFactory` で作り、差し替えるのは SDK の `query()` だけにした。再生では実際に渡った引数の指紋を録画と照合する。

## 変更内容

- `apps/server/src/testing/opponent-eval/`（新規。build の対象外）
  - `spots.ts`: 代表 Spot 4 つ（`preflop_open` KTo の UTG Open・`preflop_facing_3bet` AQo が 3-bet に直面・`flop_cbet` AJo の C-bet（K72r）・`river_facing_big_bet` QJs が Pot 23 に 26 の Bet に直面）。本番の既定の卓（6-max・100BB・playerId も同じ）で、積んだ Deck と Action の列で Engine を進め、入力は `projectKnowledgeState` / `getLegalActions` で作る。
  - `harness.ts`: `runOpponentEval`（Spot × Persona × 繰り返し。1 回目が不正なら理由を付けて 1 回だけ再要求、2 回続けて不正なら Fallback、例外は障害。`applyAction` の拒否も legal_action の不正＝Orchestrator と同じ）。漏れ検査は CPU の入力（`leakedCards`・`forbiddenKeys`）と実際に送った Prompt（知ってよい札以外の `"Xx"`・他の Preset の名前）。`hashParams`（Prompt と Options の指紋。env・abortController・cwd は外す）。
  - `metrics.ts`: `summarizeOpponentEval`（指標の定義は docs/09 §5 の表）、入口ガード `assertPopulation`（欠け・重複・余分は例外）、暫定の合格ライン `OPPONENT_EVAL_TARGETS` と `unmetTargets`。
  - `recording.ts`: 録画の形（判断ごとの指紋・出力・所要時間と、録画時の集計）と再生（`replayQueryFor`：SDK の result の形で流す。指紋が違えば例外。仮想の時計で録画の所要時間を再現）。
  - `run.ts`: 手動実行（`pnpm --filter @proj-poker/server eval:opponent [--repeats 3] [--concurrency 1] [--record]`）。障害が 1 件でもあれば録画しない。
  - `recordings/opponent-eval.json`: 下記「変更後」の実行の録画。
  - テスト: `spots.test.ts`（4 局面の Street・Board・Pot・Legal Action・入力に漏れが無い）、`harness.test.ts`（Retry → 成功 / 2 回不正 → Fallback / 例外 → 障害、`call`＋amount は Schema の不正のまま、指紋に入れる・入れない項目、集計の数え方と入口ガード、録画の再生で集計が録画時と一致し漏れと障害が 0）。
- `apps/server/package.json`: script `eval:opponent`。
- `apps/server/src/opponents/claude-opponent.ts`: Legal Action の行のうち `call` / `all_in` に「amount は付けない」を足した（下記「Calling Station の Retry」）。`claude-opponent.test.ts` に行の確認を足した。
- docs: docs/09 §5（実装・指標の定義・暫定の合格ライン・Strategic Incoherence は未測定）、docs/03 §3（call / all_in の行の指示と Eval への導線）、README（Phase 3 の到達点・Claude の CPU の Persona 指定例・Eval のコマンド・1 手の待ち時間）。

## 判断理由

- **合格ラインは測定の前にコードに置いた**（鉄則 2）。Hidden Information Leakage と障害は 1 件でも不合格。ほかは今の Persona・Prompt の目安の暫定値で、docs/09 §5 に暫定と書いた（Open Item の永久確定ではない）。
- **CI で落とすのは Hidden Information Leakage・障害・録画時の集計との一致だけ**。録画は 1 回分のスナップショットなので、Valid 率などの閾値を CI で判定しても「その録画が合格した」ことしか言えない。閾値は手動の Eval の出力で見る。
- **録画は出力だけを持ち、検証・Retry・漏れ検査・集計は再生のたびに今のコードでやり直す**。検証の規則を変えると集計が録画時と食い違って CI が落ち、Prompt・Persona・Schema・単発化の設定を変えると指紋の照合で落ちる（どちらも手動の Eval で録画を取り直す合図）。
- **Strategic Incoherence は測らない**: Judge（人間か LLM）の設計が要る。決定論で数えられる指標だけで最小のハーネスにした。
- **Calling Station の対策は Prompt の行の文言だけ**（1 変更 1 測定）。Schema に `oneOf` で「call は amount 無し」を表す案もあったが、構造化出力の Schema の対応範囲の確認が要り、変更が大きいので見送った。検証（D40）は緩めていない。

## 手動の Eval（実際に Claude を呼んだ結果）

- 条件: 2026-10-06、`claude-haiku-4-5`（`opponent_fast`）、Agent SDK 0.3.289、claude.ai でログイン済み（`claude auth status` の `loggedIn: true`・`authMethod: claude.ai`）、`ANTHROPIC_API_KEY` は子プロセスの環境から外す（`buildClaudeEnv`）。4 Spot × 6 Persona × 4 回 = 96 判断、同時 4 本（`--repeats 4 --concurrency 4`）。変更前と変更後は同じ条件で各 1 回。
- 数値は録画 JSON から集計スクリプトで出した（手で書いていない）。変更前の録画は採用せず、作業用に退避した。

| 指標 | 変更前（ベースライン） | 変更後（録画） |
|---|---|---|
| 判断 / 呼び出し | 96 / 98 | 96 / 96 |
| Structured Output Valid 率 | 0.98 | 1 |
| Illegal Action 率 | 0 | 0 |
| Retry 率 | 0.021 | 0 |
| Fallback 率 | 0 | 0 |
| 障害 | 0 | 0 |
| Hidden Information Leakage | 0 | 0 |
| Latency ms（min / median / p90 / max） | 5909 / 7720 / 9635 / 21767 | 6015 / 7668 / 9532 / 10578 |
| Persona Differentiation | 0.642 | 0.675 |

- 暫定の合格ラインには変更前・変更後とも全部届いた（`run.ts` の出力「合格ライン: すべて届いた」）。
- Latency は 4 本同時に呼んだときの値（1 本ずつの #50・#51 の実測 5.5〜15.5 秒と同程度）。変更前の max 21767ms は 1 回だけの外れ値で、変更後は 10578ms。

変更後の最終 Action（Claude の判断。4 回ずつ）:

| Persona | preflop_open | preflop_facing_3bet | flop_cbet | river_facing_big_bet | Action Diversity（bit） |
|---|---|---|---|---|---|
| tag_regular | call 1, fold 3 | call 3, raise 1 | bet 4 | call 3, fold 1 | 1.772 |
| lag | fold 1, raise 3 | raise 4 | bet 4 | call 2, raise 2 | 1.592 |
| calling_station | call 4 | call 4 | check 4 | call 4 | 0.811 |
| nit | fold 4 | call 3, raise 1 | check 4 | fold 4 | 1.703 |
| maniac | raise 4 | all_in 1, raise 3 | bet 4 | raise 4 | 1.122 |
| weak_tight_recreational | call 1, fold 3 | call 1, fold 3 | bet 1, check 3 | fold 4 | 1.502 |

### Calling Station の Retry（#51 の残課題）

- 再現: 変更前の実行で、`preflop_facing_3bet/calling_station` の 4 回中 2 回が `{"action":"call","amount":18}`（18 は 3-bet の to 額）を返し、Schema の不正（`call に amount は付けない`）→ 再要求で `call` だけを返して通った。他の Persona・Spot では 0 回。
- 変更: Prompt の Legal Action の行を `- call（追加で 12 出す。amount は付けない）`・`- all_in（この Street の累計が 200 になる。amount は付けない）` にした（bet / raise・System Prompt・Schema・検証は変えていない）。
- 結果: 変更後は全 96 判断で不正 0・Retry 0。
- 限界: 各 1 回（n=96、Calling Station の該当 Spot は 4 回）の比較で、2/4 → 0/4 は偶然の差を否定できる大きさではない（ガイダンスの「3 回以上」は満たしていない）。変更は指示を足しただけで戦略の指示は変えていないが、Persona の選び方は変更前後で動いている（例: Nit の `preflop_facing_3bet` は fold 3 → call 3）。n=4 のばらつきの範囲と見ており、Persona の差の改善とは言わない。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）: すべて exit 0。`pnpm test` は engine 158・web 39・server 154 件が通過。Claude は呼ばない（録画の再生と Fake の `query`）。
- 録画の再生が本番の引数と一致することの確認: 変更前の録画に対して、録画したときの Prompt（`claude-opponent.ts` の main の版）で `harness.test.ts` が 15 件通り、Prompt を変えると全判断が「渡した引数が録画のときと違う」で落ちることを確かめた（その後、変更後の録画に差し替えた）。

## 残課題

- Strategic Incoherence（明らかに筋の悪い判断。例: Nit が AQo で 3-bet に call / 4-bet、TAG が KTo の UTG を call）は未測定。Judge の設計（`llm-quality-improvement` の measurement-ops）で扱う。
- 合格ラインと Spot は暫定。Persona の数値（OI-005）と合わせて Playtest で見直す。Persona Differentiation の改善を語るには、同じ条件で 3 回以上の測定とばらつきの把握が要る。
- `llm-quality-improvement` skill の「Eval の実装場所・コマンドは未確定」の記述は、親が同じブランチで更新する（`.claude/` は本 PR の範囲外）。
