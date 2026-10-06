# Issue #79: 決定論の Equity・Range と Alternative Action の比較を作る

## 概要

Phase 5 の子 Issue。決定論の Math / Equity Engine と Range Model を Engine（純粋関数）に足し、Hero の判断ごとに Pot Odds・Equity・Alternative Action（Fold / Check / Call / Bet / Raise / All-in）の必要 Equity と簡易 EV を、判断時点の Hero Information Set（#78）だけから出せるようにした。web の Pot Odds の重複実装を Engine の 1 か所に寄せた。Event・スキーマ・DB は変えていない。

## 初期調査

- 前提（main 383b450）: `heroInformationSets`（判断時点までの Hero に見える Event と KnowledgeState）・`extractImportantSpots`（`packages/engine/src/hand-summary.ts`）。KnowledgeState の `math`（callAmount / potOdds / effectiveStack / spr）は `projection.ts` の `decisionMath` に Pot Odds の式を直書きしていた。
- web の `apps/web/src/lib/dealer-feedback.ts` に `potOdds` の同じ式があり、`vocabulary.ts` もそれを使っていた。web は Engine の値（`composeChips` 等）を `@proj-poker/source` 条件で src から読める（#62）。
- `evaluateHand`（`hand-evaluator.ts`）は 7 枚なら 21 通りの 5 枚組を全部評価する読みやすさ優先の実装で、Flop から River までの全列挙（Range 全体で 100 万回規模）には遅い。
- `docs/research/02_strategy_and_math.md` は Range の具体的な % を持たない（§8「UTG は常に上位 X% は RULE ではない」）。根拠にできるのは傾向（§8 Early は狭く Late は広い・§9 Action ごとに Range を更新・§10 RFI / Limp / Cold Call / 3-bet / 4-bet の区別）と Pot Odds・Break-even Fold Frequency の式（§2・§5）。
- KnowledgeState の `pot` は全員の `totalCommitted` の合計（`hand-state.ts` の `updatePlayer`）。

## 設計方針

- **Pot Odds は `pot-math.ts` の `potOdds` 1 か所**。KnowledgeState の `math`・Decision Analysis・web の Dealer Feedback / Vocabulary が同じ関数を使う。`breakEvenFoldFrequency`（F = B / (P + B)）も同じ場所。
- **Equity の方式**（`equity.ts`）: 相手 1 人で「Combo 数 × 残りの Board の出方」が `maxExactEvaluations`（120 万）以内なら全列挙（Flop・Turn・River はすべて入る）。Preflop と Multiway は seed 固定の Monte Carlo（既定 seed 1・2 万回。標準誤差は約 0.35%）。乱数は `rng.ts` の seed 付き RNG だけで、同じ入力・同じ seed・同じ回数なら同じ結果。
- **速い役の強さ**（`hand-strength.ts` の `handScore`）: Card を整数コードで持ち、Rank の枚数と Suit ごとの Rank の bit から直接役を決める。返す値は `evaluateHand(...).score` と同じ式で畳み、一致を Property Test で確かめる（Equity の勝敗判定が Hand Evaluator と食い違わないことの担保）。
- **Range Model**（`range.ts` / `range-config.ts` / `range-model.ts`）: Range の略記（`TT+`・`ATs+`・`A5s-A2s`・`random` など）を展開する。Config の `RangeProfile` は Position ごとの open と、limp / call_open / three_bet / call_three_bet / four_bet_plus の Range、Postflop の絞り込みの割合を持つ。標準（standard）に加え、D08 の別想定として狭い（tight）・広い（loose）を同じ形で持つ。中身は暫定値で、根拠（docs/research/02 §8〜§10 と SOURCES の出典）をコメントに書いた。Solver の出力や特定の Chart の転記ではないことも明記した。
- 相手の Preflop の分類は、公開された Action の履歴から「その相手の最後の Preflop の Action と、それより前の Raise の回数」で決める。まだ Action していない相手と BB の Check は絞る材料が無いので `random`。All-in はその時点の最高額を超えれば Raise として数える。
- Postflop は、その相手の Bet / Raise / Call ごとに、その Street の Board（判断時点の Board の先頭 3・4・5 枚）での役の強さの上位を残す（Bet / Raise は 0.5、Call は 0.75。同じ強さは境目でまとめて残す）。Draw は数えない簡易モデルで、Assumption に書く。Hero の札と判断時点の Board を含む Combo は先に除く（Card Removal）。
- **Decision Analysis**（`decision-analysis.ts`）: 入力は `HeroInformationSet` だけ（判断より後の Event・相手の実際の札を受け取れない形）。Alternative Action は Legal Action から作り、Bet は Pot の半分・Pot、Raise は最小・Pot Size（Call 後の Pot 分の上乗せ）、All-in を候補にし、Hero が実際に選んだ額が無ければ足す。
  - 取りうる Pot（`winnablePot`）は「各席の Commit のうち Hero の Commit 以下の部分の合計」。相手が Call しきれない超過分は戻る（Uncalled）ので、Bet / Raise の Hero の Commit は相手の最大の Commit で頭打ちにする。Side Pot は分けない（Assumption に書く）。
  - 簡易 EV は Fold を 0 とした差（Check / Call: Equity × 取りうる Pot − 出す額。この後の Bet が無い前提。Bet / Raise / All-in: 相手全員が Call する前提で Fold Equity を含めず、Break-even Fold Frequency を別に出す）。`evBasis: "simplified"` と Assumption の文（「GTO / Solver の値ではない。D20」を含む）を必ず付ける。
  - `compareRangeProfiles` で、同じ判断を標準・狭い・広いの想定ごとに比べる（D08）。

## 変更内容

- `packages/engine/src/pot-math.ts`（新規）: `potOdds` / `breakEvenFoldFrequency`。
- `packages/engine/src/projection.ts`: `decisionMath` の Pot Odds を `potOdds` に置き換えた（値は同じ）。
- `packages/engine/src/hand-strength.ts`（新規）: `cardCode` / `cardFromCode` / `handScore`。
- `packages/engine/src/range.ts`（新規）: `parseRange` / `comboKey` / `Combo`。不正な表記（逆順の `KA`・両端の揃わない範囲など）は例外にする。
- `packages/engine/src/range-config.ts`（新規）: `RangeProfile` / `PositionName` / `PreflopSpot` と `STANDARD_RANGE_PROFILE` / `TIGHT_RANGE_PROFILE` / `LOOSE_RANGE_PROFILE` / `RANGE_PROFILES`（暫定値）。
- `packages/engine/src/range-model.ts`（新規）: `positionName` / `classifyPreflop` / `villainRange`（Assumption = Profile・Position・Preflop の分類と表記・Postflop の絞り込みの各段の Combo 数・最終の Combo 数）。
- `packages/engine/src/equity.ts`（新規）: `equityVsRanges` / `DEFAULT_EQUITY_OPTIONS`（結果に method・trials・seed を含む）。
- `packages/engine/src/decision-analysis.ts`（新規）: `analyzeDecision` / `compareRangeProfiles`。
- `packages/engine/src/index.ts`: 上記を公開。
- `apps/web/src/lib/dealer-feedback.ts` / `vocabulary.ts`: web の `potOdds` を消し、Engine の `potOdds` を使う。`apps/web/vite.config.ts` のコメント（ブラウザが使う Engine の値）を更新した。
- テスト（新規）:
  - `hand-strength.property.test.ts`: 5〜7 枚のランダムな札と、1 Suit 寄りの 7 枚で `handScore` = `evaluateHand(...).score`。
  - `equity.test.ts`: 既知の値（River の勝ち数・引き分けの等分・Turn の Flush Draw vs Set = 7/44・Flop の Set vs Set = 947/990・Preflop の AA vs KK ≈ 82%・AKs vs QQ ≈ 46%・3-way の AA vs KK vs QQ）、Card Removal、Monte Carlo と全列挙の近さ、決定論（同じ seed で同じ・seed が効く）、不正な入力、性能の上限 3 本。
  - `equity.property.test.ts`: Flop・Turn・River の Hand vs Hand で Equity の和が 1。
  - `range.test.ts`: 表記ごとの Combo 数（手計算）・不正な表記・全 Profile の展開・標準の open が Early → Late で広がる・どの Spot でも tight < standard < loose。
  - `range-model.test.ts`: 2〜8 人の席の名前、Preflop の分類（open / call_open / three_bet / call_three_bet / four_bet_plus / limp / check_option / not_acted・Short All-in）。
  - `decision-analysis.test.ts`: 6-max の Hand（CO の Open に Hero〔BTN〕が Call、Flop で CO の Bet に Call）で、Pot・Pot Odds・Range の Assumption・全列挙・Alternative Action の risk / 取りうる Pot / 必要 Equity / 簡易 EV / Break-even Fold（手計算）・決定論。Hindsight Leak が無いこと（相手の札・判断後の Board と Action を変えても、判断の直後で切っても分析が同じ）。Preflop の Multiway（まだ Action していない Blind は random・Monte Carlo）。`compareRangeProfiles`。Postflop で残した Combo が外した Combo より弱くないこと。
- docs: `docs/05` §6（Math / Range Evidence の作り方）、`docs/03` §1（web が Engine から使う表示用の関数に `potOdds`）・§7（Deterministic Math と Range Analysis の入口）、`docs/09` §6（Math / Equity / Range のテスト）。

## 判断理由

- Equity を全列挙と Monte Carlo の切り替えにしたのは、Flop〜River は全列挙でも上限内（実測で Flop の全 1326 Combo が約 160ms）に収まり誤差なく出せる一方、Preflop（残り 5 枚・約 171 万通り × Combo）と Multiway は全列挙が上限を超えるため。Monte Carlo も seed と回数を結果に残すので再現できる。
- `evaluateHand` を書き換えず `handScore` を別に足したのは、既存の Hand Evaluator（Showdown の裁定に使う）を変えずに済ませるため。両者の一致は Property Test で縛る。
- 標準 Range は docs/research に具体値が無いので、§8 の傾向に沿った暫定値として Config に置き、狭い・広いの想定と並べて差を比べられるようにした（D08）。永久仕様にしない（Open Item の確定もしていない）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`: 通過。
- `pnpm test`: engine 323・web 109・server 195 件が通過。engine のテストは 3 回続けて実行し、すべて通過（Property Test・性能の上限を含む）。
- 性能の実測（vitest の各テストの所要時間）: Flop の手札 vs 全 1326 Combo の全列挙 約 160ms、Preflop の手札 vs BTN の Open Range（Monte Carlo 2 万回）約 10ms、Flop の 3-way（Monte Carlo 2 万回）約 20ms。上限は 500ms。
- web を `vite build` し、バンドルに Engine の Equity・Range のコードが入っていないこと（Pot Odds の関数だけ）を確かめた。

## 残課題

- 標準 Range・Postflop の絞り込みの割合は暫定値。Review の品質評価（`llm-quality-improvement`）と運用で見直す。
- Postflop の絞り込みは Made Hand の強さだけで Draw を数えない。Draw を Range に残す必要が出たら、別の Issue で扱う。
- 簡易 EV は Side Pot を分けず、Implied Odds・Rake・Equity Realization を含まない。Review AI（#82）では Assumption と並べて目安として扱う。
- Decision Analysis を Review の Evidence に組み込むのは #82、UI での表示は #84。
