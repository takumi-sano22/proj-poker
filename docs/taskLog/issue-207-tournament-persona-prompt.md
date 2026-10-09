# Issue #207: Tournament の Claude CPU で Persona が Stage・ICM（Bubble Factor）より強く効く戦略品質を改善する

## 目的

#202（D132）の録画で、Tournament Context は Prompt に入っていても Persona が判断を支配した（Nit は「Preflop Looseness 0.15 だから範囲外」、Maniac は「規律が低いので ICM / Bubble Factor を無視」）。人間判断（Issue の依頼文。D133 に記録）に従い、Tournament の Claude Prompt の中での Persona の読み方だけを変え、#202 と同じ母集団で 1 回だけ再測定した。

## 変更内容

- `apps/server/src/opponents/claude-opponent.ts`: `TOURNAMENT_PERSONA_LINE`（「リスク許容度」と「規律」に合わせる 1 行）を `TOURNAMENT_PERSONA_GUIDE` に置き換えた。Persona の節があるときだけ Tournament の節に入る。内容は ①Tournament Context（stackBb・Position・stage・payout・icmEquity・bubbleFactors）が性格に関わらず考慮する戦略上の基準 ②Skill はその基準を反映する精度（低くても Context を使わずに決めてよいわけではない） ③ほかの傾向は基準からの偏り（リスクの許容・規律は境界の倒れ方、攻撃性・Bluff は額と攻め方） ④Preflop Looseness は固定の Hand Range ではなく、浅い Stack・少人数・後ろの Position で参加範囲が大きく変わり得る ⑤Bubble Factor > 1 の相手との All-in は慎重になる圧力で、無視せず理解したうえで境界を広めに取る ⑥rationale に使った状況を書く。Memory・Table Tendency・Tilt の節があるときだけ「後の節はこの基準と性格の上で調整する」1 行を足す（構造ゲート）
- `claude-opponent.test.ts`: 新しい読み方が Persona のあるときだけ Tournament の節の末尾に入ること・Cash には入らないこと・Push/Fold / Nash / GTO / Solver の語が無いこと・層の 1 行が層のあるときだけ入ること・Memory の節の文字列が変わらないこと
- `testing/opponent-eval/tournament-eval.ts`: 今の録画を `opponent-tournament-eval-v2.json`（`TOURNAMENT_RECORDING_URL`）にし、#202 の録画を `TOURNAMENT_BASELINE_RECORDING_URL` として残した
- `tournament-eval.test.ts`: ベースラインの母集団の確認・S0 だけ今のコードで再生して一致・S1〜S6 だけ paramsHash が変わったこと（意図した drift）
- `tournament-run.ts`: dry-run に新しい読み方と層の 1 行の数を出す
- 録画: `recordings/opponent-tournament-eval-v2.json`（新規。#202 の録画は書き換えていない）
- docs: `decision_log.yaml` に D133、`docs/05` §10 の Claude CPU の説明、`docs/09` §5 に結果、`docs/00`・`docs/10`・README・skill 2 つの範囲表記を D01〜D133 に

## 判断理由

- Persona の節（`describePersona`）は Cash と共通なので触らず、Tournament の節の側で読み方を上書きした（Cash の Prompt・既存の Cash の録画の指紋を変えない）
- `TOURNAMENT_GUIDE`（#188 の説明）は変えず、Persona があるときだけ後ろに足した（Persona なしの Tournament の Prompt は #188 のまま）
- Persona の数値（`PERSONA_PRESETS`）・RuleBot・KnowledgeState・ICM は D133 の範囲外。Push/Fold の Range は足さない（D130）
- 録画は 1 回だけ。結果を見て Prompt を直して録り直さず、残った課題は #212 に分けた（1 変更 1 測定）

## 実行した確認

- unit: `claude-opponent.test.ts` 17 件・`testing/opponent-eval/` 53 件（Cash の録画 `opponent-eval.json`・Memory 付き Prompt・River の再生を含む）
- dry-run: `pnpm --filter @proj-poker/server eval:opponent-tournament --dry-run` → モデル 0 回・判断 28・Prompt 28（異なる 14）・Tournament の節 24・新しい読み方 24・層の 1 行 4（S6 だけ）・Leakage 0・`withinLimits: true`
- 経路: シェル / 子プロセスの env に `ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・Bedrock / Vertex / Foundry・`ANTHROPIC_BASE_URL` が無いこと（実行ログの「なし」）
- 録画: `--record` を 1 回。判断 28/28・呼び出し 28/56・Retry 0・障害 0。`合格ライン（既存の OPPONENT_EVAL_TARGETS）: すべて届いた`
- 品質チェック: 下記「品質チェック」

## 結果（Before = #202 / After = #207）

| 指標 | Before | After |
|---|---:|---:|
| Structured Output Valid | 1 | 1 |
| Illegal | 0 | 0 |
| Retry | 0 | 0 |
| Fallback | 0 | 0 |
| Leakage | 0 | 0 |
| Persona Differentiation | 1 | 0.571（S0 1 / S1 0.5 / S2 0.5 / S3 1 / S4 1 / S5 0 / S6 0） |
| Context Effect（S0→S2 合計） | 0.5（Nit 0・Maniac 1） | 0.5（Nit 0・Maniac 1） |
| Layer Effect（S5→S6 合計） | 0.25（Nit 0・Maniac 0.5） | 0（Nit 0・Maniac 0） |

### S0〜S6 の Action と rationale（全 28 判断）

| Spot | Persona | # | Before Action | Before rationale | After Action | After rationale |
|---|---|---|---|---|---|---|
| S0 対照 | nit | 1 | fold | Qh6oは弱いハンドで、高い規律と限定的なプリフロップ参加基準により、ボタン位置でもフォールドが正当化される。 | fold | Qh6cは低いPreflop参加率（0.15）と高い規律性（0.80）を持つNitプレイヤーにとって、フォールドすべき弱い手である。 |
| S0 対照 | nit | 2 | fold | Q6oは弱すぎてタイトなプレイヤーのレンジに入らず、Nit スタイルに合った規律的なフォールドです。 | fold | Nit スタイルで preflop 参加率が極めて低く、Q6o は規律に基づいてフォールドすべき弱い手です。 |
| S0 対照 | maniac | 1 | raise（450） | マニアックスタイルの極めて高い攻撃性を活かし、ボタンからの積極的レイズで相手をプレッシャーをかける。 | raise（600） | Maniacスタイルの極度な攻撃性とBluff傾向に従い、Buttonからの強気なレイズでポットを奪いにいく。 |
| S0 対照 | maniac | 2 | raise（450） | Maniacキャラの非常に高い攻撃性とブラフ傾向、Buttonの広い参加範囲から、弱い手でも強気にレイズして主導権を握る。 | raise（450） | Maniacスタイルで高い攻撃性とBluff傾向を表現し、ボタンポジションから弱いハンドでも積極的にレイズで相手に圧力をかける。 |
| S1 Bubble 前 | nit | 1 | fold | Q-6oはNitの極めて低いPreflop Loosenesでは参加対象外であり、規律を優先して弱い手を降ろす。 | fold | Bubble 前で複数の高い Bubble Factor の相手がいる中、10BB の浅い Stack では規律を優先し、Qh6c という弱い hand は fold すべき。 |
| S1 Bubble 前 | nit | 2 | fold | Nit プレイヤーの参加基準では Q6o は手薄く、Bubble 前で bubble factor が高い状況下でのリスク回避が重要。 | fold | 10BBの浅いstackで弱いQ6oはbubble factorが大きい相手（hero 1.71、cpu1 1.64）との衝突コストが高く、very tightな性格と低いrisk toleranceから参加は控える。 |
| S1 Bubble 前 | maniac | 1 | raise（450） | 攻撃性0.95、Bluff傾向0.90の Maniac として、弱いハンドでもボタンからのレイズで主導権を握り、ブラフを仕掛ける | fold | 10BB の浅い Stack で Q6o は最弱手。Bubble Factor 1.7 の hero 相手への敗退は ICM 上の痛みが大きく、攻撃性が高くても必要勝率に足りないため折る。 |
| S1 Bubble 前 | maniac | 2 | all_in | Maniac キャラの極度の Looseness と Aggression により、弱い手でも All-in を仕掛けるプレイスタイルに一貫している。 | all_in | 10BB の短 Stack、Button position、超高い攻撃性と Bluff 傾向により、fold を狙って all-in で攻撃的に動く。 |
| S2 Bubble | nit | 1 | fold | Qh6cは弱すぎて、bubble factorが高い状況での規律あるNitプレイとして参加価値がない。 | fold | 10BB浅Stack Button ですが Bubble 段階で bubbleFactor が 1.66～1.76 と高く、Q6o の勝率では All-in の必要期待値がマイナス、規律と慎重さから折ります。 |
| S2 Bubble | nit | 2 | fold | Bubble stage の最小 Stack で Q6o という最弱手は、自分の高い規律性とリスク許容度の低さから絶対に参加すべきではない。 | fold | 10BBの浅いStack、Bubble段階での強いICM圧力、Q6oという非常に弱い手、そして超低い参加範囲と高い規律のNit性格から、フォールドが最適です。 |
| S2 Bubble | maniac | 1 | all_in | Bubble での短いスタック、極度の攻撃性と高いリスク許容度、広いプリフロップ参加範囲、ブラフ傾向の高さから、ボタンでの All-in ショブが Maniac プレイヤーの典型的な判断。 | fold | 10BB のボタン、Bubble ステージで Q♥6♣ の弱い手、Hero との Bubble Factor 1.76 の高さとリスク・リターンが見合わない。 |
| S2 Bubble | maniac | 2 | all_in | Buttonからの超攻撃的なManiacスタイルで、敵を圧倒し敗北を強要するブラフオール・イン。 | all_in | 浅いStack(10BB)・Button位置・低実力で攻撃性が非常に高く、Bubble Factorの警告を理解しながらも広い参加範囲で All-in で圧力をかけるのが性格一貫。 |
| S3 ITM | nit | 1 | fold | Qh6cはプリフロップで参加範囲外の弱い手札で、Nitスタイルの高い規律に合致しているため明確にフォールドします。 | fold | 10BB浅いスタックでQ6oはボタンでも弱く、Bubble Factor 1.2超の相手との対戦は規律と低いリスク許容から回避すべき。 |
| S3 ITM | nit | 2 | fold | Q6o は Nit スタイルの Preflop Looseness 0.15 では参加対象外の弱いハンドであり、規律を優先して fold します。 | fold | 弱いハンド(Q6o)、10BBの浅いStack、In the moneyステージで入賞確定済み、Bubble Factorが1を超える状況では、Nit の高い規律(0.80)と低いリスク許容(0.20)に従い、無理な勝負を避けるべき。 |
| S3 ITM | maniac | 1 | all_in | 短いスタックで弱い手でも、Maniacスタイル（Aggression 0.95、Bluff 0.90、Risk Tolerance 0.90、Discipline 0.15）に一貫して、規律を無視してボタンからアグレッシブにAll-inで勝負する。 | all_in | 10BB 浅いスタック・Button 後ろポジション・規律 0.15 ・攻撃性 0.95 の Maniac は、Bubble Factor 1.2+ の相手でも All-in でプレッシャーをかけるクセが優先される傾向が強い。 |
| S3 ITM | maniac | 2 | all_in | Maniacのキャラクターとして攻撃性と規律の低さから、短いStackを活かしてAll-inでプレッシャーをかけるのが一貫したプレイスタイル。 | all_in | 10BBの浅いStack + Button位置 + 高い攻撃性とBluff傾向により、相手へのプレッシャーでFoldを狙う；Bubble Factorの圧力は理解するも、Stack再建の急務が優先される。 |
| S4 Heads-Up | nit | 1 | fold | Preflop Looseness が 0.15 の Nit として Q6o は参加範囲外であり、規律の高さに従いフォールドすべき。 | fold | 10BB heads-up の SB で Q6o は参加範囲外；規律高く、リスク許容低い性格として、より強い手の到来を待つ方が一貫している。 |
| S4 Heads-Up | nit | 2 | fold | Preflop Looseness が極めて低く、規律が高い Nit として Q-6o は fold する弱い手であり、次の hand でより良い hand を待つべき。 | fold | Heads-up 10BB の浅い Stack でも、Q6o は著しく弱く、自分の Nit スタイル（Discipline 0.80・Risk Tolerance 0.20・Preflop Looseness 0.15）に合わない手のため Fold。 |
| S4 Heads-Up | maniac | 1 | raise（450） | Maniac のゴリ押し性格と高い攻撃性から、短 Stack での Heads-up preflop で弱い手でも積極的にレイズして相手に圧力をかける。 | all_in | 10BB のヘッズアップで広い Range を参加する Maniac として、攻撃性とリスク許容度の高さから Q6o での All-in が一貫したプレイ。 |
| S4 Heads-Up | maniac | 2 | all_in | Maniacスタイルのオーバーアグレッシブなプレイで、弱いハンドでもボタンからのAll-inシーベットで相手をプレッシャーにかける。 | all_in | Heads-upで10BB、Button位置、高い攻撃性とBluff傾向の性格から、Qh6cで相手を圧倒する全力のシャイブが一貫したプレイ。 |
| S5 BF 2.75 Call | nit | 1 | fold | A9o は bubble stage の high bubble factor 対戦で必要勝率に達しておらず、規律重視の Nit スタイルでは折るべき。 | fold | Bubble 段階で cpu1 との Bubble Factor が 2.75 と極めて高く、Ah9c は弱い手のため、規律の高い Nit は敗退リスクを避けてフォールドするべき。 |
| S5 BF 2.75 Call | nit | 2 | fold | A9o は Nit のプリフロップ参加基準に達しておらず、Bubble stage での不利な状況で弱手をコールする規律を欠いたプレイになるため。 | fold | Bubble段階でcpu1のbubbleFactorが2.75と極めて大きく、弱いハンド(Ah9c)で浅いStackを失うリスクが高すぎるため、規律を優先してfold。 |
| S5 BF 2.75 Call | maniac | 1 | all_in | Maniac の極度な攻撃性と低い規律により、A9o で Bubble ステージの ICM リスクを無視して勝負を仕掛ける。 | fold | Bubble stage で Bubble Factor が 2.75 と極めて高く、Ah9c の弱い手では ICM 圧力を考慮すると fold が正当。 |
| S5 BF 2.75 Call | maniac | 2 | call | マニアックなキャラクターとして Preflop の広すぎる参加範囲と攻撃性により、弱い Ah9c でも相手の bluff を信じてコールする。 | fold | Ah9c は cpu1 の all-in range に対して勝率が低く、bubbleFactor 2.75 で call の必要勝率が高い；自分の skill が低く、hand strength を過大評価するリスクがあり、規律の低さも考慮すると fold が最適。 |
| S6 S5 + 層 | nit | 1 | fold | Bubble での高い規律（0.80）と Nit なプレイスタイル、弱いハンド（Ah9c）、Bubble Factor 2.75 による負けの痛み、リスク許容度の低さ（0.20）から、ここは無条件で Fold するべき。 | fold | Ah9cは弱い手で、16.7BB浅スタックのBubble局面、相手のbubbleFactor=2.75という高い敗退リスク下では、超厳格な規律と低リスク許容度で folding が標準的です。 |
| S6 S5 + 層 | nit | 2 | fold | Ah9c は Preflop Looseness 0.15 の Nit には参加基準外の弱い手で、Discipline 0.80 で Bubble ステージの不利な All-in Call は回避する。 | fold | Bubble段階でbubbleFactor 2.75の高い圧力があり、弱いAH9CではCall時の勝率がrequired winrateを下回るため、高い規律とリスク回避傾向に基づきFoldが最適。 |
| S6 S5 + 層 | maniac | 1 | call | Maniac スタイルで Discipline が極めて低く、A9o でも広く参加する傾向にあり、Risk Tolerance 0.90 で高リスク選択を好むため、All-in された相手に対してコールする。 | fold | Bubble 局面で Bubble Factor 2.75 と非常に高く、Ah9c の弱さと 16.7BB の浅い Stack では、攻撃的性格でも敗退の賞金喪失圧力に抗えない。 |
| S6 S5 + 層 | maniac | 2 | call | Maniac スタイルで攻撃性が高く、規律が低いため Bubble stage の bubbleFactor を無視して、既に Pot に入った状況で All-in に Call する。 | fold | Bubble stage で bubbleFactor 2.75 は敗退の痛みが大きく、Ah9c では pot odds 33.5% に対して必要勝率 35-40% を満たさず、攻撃的性格でも敗退リスクを正当化できない。 |

### 読み取り

- **Short Stack（S1〜S4）**: Before の Nit は S1・S3・S4 の 5 判断で「Looseness 0.15 だから範囲外」だけで結論していた。After の Nit 8 判断はすべて 10BB・Button / Heads-Up・Stage・Bubble Factor のどれかを理由に挙げた。ただし S4 の 2 判断は状況を挙げたうえで「Q6o は参加範囲外 / Nit スタイルに合わない」と性格の範囲で締めており、改善は部分的。Action は全 Fold のまま（Push/Fold Solver が無いので失敗とはしない）
- **Bubble Factor（S5・S6）**: Before の Maniac の「ICM リスクを無視」「bubbleFactor を無視」は 0 件になり、After の 8 判断すべてが BF 2.75 を「Call の必要勝率が上がる圧力」として扱った。一方で Maniac が 4 判断とも Fold し、Persona の差（1 → 0）と層の効果（0.25 → 0）が消えた（慎重側へ寄りすぎ）。t5/maniac/2 は低 Skill・低規律を Fold の理由に読んだ
- **Persona Differentiation**: 全体では 0.571 で消えてはいない（S0・S3・S4 は 1）。Nit と Maniac の Action は同一化していないが、S5・S6 では同じになった
- **S0（Prompt が変わらない対照）**: Before / After とも Nit Fold 2・Maniac Raise 2 で、モデルの揺れの目安としても安定

## 残課題

- S5・S6 の Maniac の寄りすぎ・S1/S2 の割れ・S4 の Nit の扱いは #212 で人間判断（1 変更 1 測定のため再修正・再録画はしていない）
- repeat 2 の少数標本。他 Persona の Action 分布は未実測（今回の Scope 外）
- #203（人間の実機受け入れテスト）は触っていない
