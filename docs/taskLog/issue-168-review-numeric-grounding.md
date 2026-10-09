# Issue #168: Review の自然言語中の数値 Grounding（数値表と参照トークン）

## 概要

Review AI の出力の検証は、参照した Evidence ID の実在と Solver / Observation / ICM の利用条件までで、文の中の数値（Pot・Equity・割合・ICM 等）が Evidence と合っているかは見ていなかった（D125 で Phase 7 の範囲外とし、横断の品質課題として残した）。人間判断（2026-10-09・AskUserQuestion。Issue のコメントが一次情報）で **案 A（数値表＋参照トークン）** を採用し、D131 として記録した。

- Evidence から決定論で「数値表」を作り、Pass A と Pass A への Follow-up の Prompt に添える。Review AI には文の数値を参照（`{N3}`）で書かせる
- grounding 段で、未知の参照と、参照ではない `%` / `pt` / `BB` 付きの数値のうち表の値と（表示の丸めの範囲で）一致しないものを不正にする。単位の無い数は検査しない
- 不正時は既存の Retry の枠（最大 2 回）だけ。Retry の上限は増やさない
- 検証を通った文は参照を決定論の値に置き換えてから保存する（DB スキーマは変えない。#169 の UI の Evidence 直接表示は維持）
- Pass B（Reveal Review）と Pass B への Follow-up は範囲外。Cash / Tournament 共通

## 変更内容

- `apps/server/src/review/numeric-grounding.ts`（新規）
  - `buildNumericTable`: Evidence から数値表を作る。参照キーは表の中の順に `N1` から採番（同じ Evidence なら同じ表）。書式は UI と揃える（額は `formatChips` と同じ桁区切りの Chip の実額・BB 換算は参考として括弧に出すだけで置換値に含めない、比率は `formatPercent` と同じ整数の %、簡易 EV は `SignedAmount` と同じ符号付きの整数、ICM Equity は `equityText` と同じ小数第 1 位の pt、Tournament の % は Evidence の小数第 1 位、賞金は `payoutText` と同じ整数の pt）
  - 対象: 判断時点の卓（SB / BB・席ごとの Stack・Action の額・最高の Bet・選べた Bet / Raise の最小と最大・Hero が出した額）、Math（Pot・Call 額・Pot Odds・有効 Stack・SPR・Equity と勝ち / 引き分け・試行回数・**Equity と Pot Odds の差**・他の Action の出す額 / 取りうる Pot / 必要 Equity / 損をしない Fold 率 / 簡易 EV）、Range（Combo 数・Postflop の絞り込みで残した割合と前後の Combo 数・想定ごとの Equity）、卓の傾向（割合・回数・機会・Hand の数）、Solver（supported のときだけ。Pot・有効 Stack・Bet Tree・頻度・Iteration・Combo 数）、Tournament（参加 / 残人数・Level・Ante・Prize Pool と順位ごとの賞金〔pt と総額に対する %〕・席ごとの ICM Stack / BB 換算 / ICM Equity pt / %・All-in の Chip EV / ICM の必要 Equity と Fold・勝ち・負けの Stack / ICM Equity）
  - `checkNumericGrounding`: 未知の参照・`{}` の無い参照・単位を含む値の参照の後ろの単位の重ね書き・置換後の文の `%` / `pt` / `BB` 付きの数値が表の値（BB は額 ÷ BB）か Evidence の文に書かれた値と一致しないもの、を不正にする（理由は `数値の根拠:` で始める）。一致は「書かれた桁の半分」まで、「約」「前後」等の概数は 1 桁分まで。全角は NFKC で半角にしてから読み、席の表示名（`CPU 3`）の数字は数値として読まない。符号は絶対値で比べる
  - `resolveNumericRefs`: 文の参照を表の値へ置き換える（`evidenceIds` は触らない）
- `review-ai.ts`: System Prompt の数値の指示を「数値表の参照で書く」に変え、Prompt に数値表の節を足し、`checkReviewOutput` の grounding の最後に数値の照合を足した
- `generate.ts`: 検証を通った出力を `resolveNumericRefs` → `sanitizeOutput` の順で置き換えてから保存する
- `followup.ts`: Pass A の Review への質問だけ、Prompt に数値表の節・System Prompt に参照の指示を足し、答えの数値を照合する（Hero の質問に書かれた単位付きの値は一致として扱う）。通った答えは参照を置き換える
- `testing/review-eval/metrics.ts`: `numericGroundingInvalids`（数値の照合で grounding の不正になった呼び出しの数）を足した
- `testing/review-eval/run.ts`: OAuth 以外の経路の変数（`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_USE_BEDROCK` / `VERTEX` / `FOUNDRY` / `ANTHROPIC_BASE_URL`）が親（シェル）か子プロセスの env にあれば呼ばずに止める（`assertOAuthRoute`）。呼び出しを `createCallBudget(24)` で包んだ
- テスト: `numeric-grounding.test.ts`（新規）、`generate.test.ts`（検証を通る出力の数値を参照に直し、置換後の文を確かめる）、`reveal.test.ts`（Pass B への Follow-up には数値表を出さず照合もしない）
- 録画: `recordings/review-eval.json` を取り直した（下記）
- docs: `docs/05`（§6 の卓の傾向・§7 の Follow-up・§8 の実装の節・§10 の Tournament の Grounding）、`docs/09`（テストの項目・Review Eval の指標と再録画）、`docs/decision_log.yaml`（D131）・`docs/10`・`docs/00` の範囲表記

## 判断理由

- 照合を置換の後の文に対して行う: 「`{N3}` BB」のように額の参照の後ろに BB を書く誤り（24 BB と読める）も、値として照合すれば捕まる
- Evidence の文（前提・注記・KB の本文）に書かれた値も一致として扱う: 例えば「Made Hand の上位 50% を残す」は Evidence の前提の言い換えで、作り話ではない。表の行に入れるより誤検知が少ない
- Equity と Pot Odds の差を表に入れた: 前回の録画の文に「必要 Equity を大きく上回る」が多く、差を数値で書くと計算になるため、決定論で出した
- `ポイント` は単位として読まない: ICM の pt と、% の差（ポイント）とを区別できないため
- Pass B は範囲外: 人間判断。Pass B への Follow-up の Evidence も Pass B の Evidence なので同じく外した

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`: 通過
- `pnpm test`: 録画を取り直す前は `harness.test.ts` の録画の再生だけが指紋の不一致で失敗（想定どおり）。取り直した後に全体を再実行（結果は PR の Test plan に記載）
- 数値表の目視: BTN vs UTG の River（57 行）と Tournament の Bubble の Shove（85 行）・Call の表を出力し、書式（`30%`・`55（27.5 BB）`・`+6（+3.1 BB）`・`116.2pt`・`19.4%`・`600pt`）と内部の playerId が説明に出ないことを確認した
- 情報境界: 数値表は Evidence の値だけから作るので、Evidence に無い情報（他者の札・後の Board・Persona）は入らない。Review Eval の漏れの検査（Evidence と Prompt の札・語）は 0 件

### Review Eval の再録画（実際の Claude・OAuth・D87 / D131）

条件: `pnpm --filter @proj-poker/server eval:review --repeats 3 --record`・review_standard（`claude-sonnet-5-5`）・Claude Agent SDK 0.3.289・Solver なし・Cash の固定 4 判断 × repeat 3。実行前にシェルの env に `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` / `ANTHROPIC_BASE_URL` が無いことを確かめ、`run.ts` の表示でも子プロセス・親の env のどちらにも無いことを確認した。指標は `metrics.ts` が出した値（録画の `summary`）。

| 指標 | 前の録画（2026-10-06・#153 時点） | 今回（2026-10-09） |
|---|---|---|
| reviews / calls | 12 / 12 | 12 / 12（上限 24） |
| Structured Output Valid 率 | 1 | 1 |
| Retry 率 / Fallback 率 | 0 / 0 | 0 / 0 |
| 数値 Grounding の不正（`numericGroundingInvalids`） | （指標なし） | **0** |
| Math / KB Grounding 率 | 1 / 1 | 1 / 1 |
| Hindsight Leak・障害・識別子の残存 | 0・0・0 | 0・0・0 |
| Exact GTO の言及 | 0 | 0 |
| Latency median / p90（ms） | 12,283 / 19,209 | 14,093 / 20,278 |

- Claude の呼び出しの実績: **12 回**（上限 24。Retry 0）。録画に資格情報が入っていないこと（`sk-ant` / `ANTHROPIC_API_KEY` / `Bearer` の文字列が無い）を確認した
- 12 件の出力の文に参照（`{N3}`）が計 155 個。参照を使わずに書かれた単位付きの数値は 2 個（`3 BB`・`50%`）で、どちらも表の値と一致した
- 数値 Grounding の不正の内訳: 0 件（未知の参照・表と一致しない % / pt / BB・単位の重ね書きのどれも無し）
- 置き換えた後の文の例（btn_vs_utg/d3#1）: 「Pot 55 に対して CPU 3 が 24 を Bet し、Call に必要な額は 24、Pot Odds は 30% です。標準の Range 想定での Equity は 38%（勝ち 29%、引き分け 18%）で、Pot Odds との差は 8% あります。簡易 EV は Call が +6」
- 前の録画との比較の注意: Latency の差は 1 回ずつの実測の揺れを含み、数値表の分だけ Prompt が長くなった影響と分けて測っていない

## 残課題

- Tournament の実モデルの録画は #202（この Issue では録画しない）
- #168 より前に保存された Review の説明は、置き換えの無い平文のまま（作り直さない）。その Review への Follow-up では、Review の説明の数値を答えに繰り返すと、表と一致しなければ grounding の不正になる（表の値なら通る）
- Bet の大きさを Pot に対する割合で書く表現（「Pot の 44% の Bet」）は表に無い（Action ごとの Bet 前の Pot を Evidence に持たない）。今回の録画では出なかった。出るようなら別 Issue で表に足すか決める
- `README.md` と `.claude/skills/`（test-and-review・sync-check）の D 番号の範囲表記（D01〜D130）は、この Issue の触らない領域なので更新していない（親へ返す）
