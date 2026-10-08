# Issue #142: Persona・Memory・Table Tendency・Tilt を合成し Opponent Eval を足す（P7-7）

## 概要

RuleBot の 4 つの層（Persona・Tilt・Table Tendency・Memory）の合成を `composeTuning` の 1 か所にまとめ、順序（Persona → Tilt → Table Tendency → Memory）と合計のずれの上限（確率のしきい値ごとに Persona だけのしきい値から ±0.2。`phase7_rulebot_composition_v1`。OI-011 の暫定値）を一意にした。RuleBot の決定論だけで回す Opponent Memory の Eval（CI の Vitest と手動の計測スクリプト）を足した。API キーは使わない。D27・D40・D106・D107・D117・D119・D121 の具体化。マイグレーション・Event の型・`schema_version`・LLM の呼び出しの回数・経路は変えていない。

## 初期調査

- #139〜#141 の時点で、RuleBot の `choose` は Tilt（`tiltedPersona`）→ Table Tendency（`tableTendencyAdjustedTuning`）→ Memory（`memoryAdjustedTuning`）の順に当てていたが、各層の上限だけで、合計のずれの上限は無かった。Table Tendency（最大 0.1）と Memory（最大 0.15）は同じ 2 つのしきい値（medium の Call・weak の Bluff）をずらすので、Adaptability と読みの強さが 1 の Persona では 0.25 ずれる。
- 今の 6 つの Preset では、読みの強さの最大は TAG Regular の約 0.7・Adaptability の最大は LAG の 0.7 で、ずれの合計は最大 0.1725。Tilt は 3 段でも 1 つのしきい値を最大 0.12（weakLimp）しか動かさない。±0.2 の上限は Preset では届かない。
- 既存の Opponent Eval（#53）は Claude の CPU の録画の再生で、代表 Spot の入力は `projectKnowledgeState` だけ（層が無い）なので、Prompt の指紋は #142 で変わらない。
- Orchestrator の層の組み立て（`opponentMemories` / `opponentTilts` / `opponentTableTendencies`）は private。Eval で同じ入力を作る場合、写しが本番と一致するかを実測で確かめる必要がある（LC-050）。

## 設計方針

- **合成**: `composeTuning(persona, knowledge)` を `rule-bot.ts` に置き、`RuleBot.choose` はこれだけを呼ぶ。Persona なしは `DEFAULT_TUNING` を返す（D71 のまま、どの層も読まない）。上限は Persona だけのしきい値（`tuningFromPersona`）を基準に、確率のしきい値ごとに ±`maxTotalShift` に丸め、0〜1 も保つ。参加 Range（`preflopRange`）は Tilt だけが変えるのでそのまま。乱数を引かず、選ぶ Action は Legal Action の中から（D40）。
- **Eval の置き場**: 既存の `apps/server/src/testing/opponent-eval/` に `memory-eval.ts`（仕組み）・`memory-eval.test.ts`（CI）・`memory-run.ts`（手動の計測）を足した。`metrics.ts` の `distance` / `meanPairwiseDistance` / `entropy` を export して同じ定義で集計する。
- **代表 Spot**: 既存の `river_facing_big_bet`（medium の Call が Memory の `aggression_frequency` で動く）と `flop_cbet`（weak の Bluff が `fold_to_cbet_flop` で動く）を使い、Subject の傾向（Loose / Tight。D121 の上限 5 項目）を本番と同じ形の `OpponentMemorySummary` で足す。
- **Session を跨ぐ Eval**: 本番の `HandOrchestrator`（`createRuleBot`・メモリ内の Event Store）で 2 Session を進め、CPU に渡った入力をそのまま記録する。Session の区切りは CPU の障害 → Session 終了（本番の D86 の経路）。Hero は Check か Fold（Bust で Session が勝手に終わらないように）。Hand の最初の追記に渡った Session の文脈（Persona・参加者）を記録する Store の派生クラスで、Orchestrator と同じ入力から層を作り、CPU に渡った値と一致することを毎判断で確かめてから計算時間を測る。
- **合格ライン**: 測定の前に決めた暫定値（`MEMORY_EVAL_TARGETS`。OI-011）: Illegal 0・Check できるのに Fold 0・Persona Differentiation と Action Diversity が層なしの 0.75 倍以上・攻撃性の順序（Maniac > Nit・LAG > Nit・Maniac > Calling Station）。

## 変更ファイル

- `apps/server/src/opponents/rule-bot.ts`: `RULEBOT_COMPOSITION_V1`・`composeTuning`。`RuleBot` は合成をこれに一本化（`tuning`・`reading` のフィールドを削除）
- `apps/server/src/opponents/rule-bot.test.ts`: 合成のテスト（Persona なしは変えない・Preset は #141 までと同じ・全軸 1 の Persona で上限が効く差・合法・再現性）
- `apps/server/src/testing/opponent-eval/memory-eval.ts`（新規）・`memory-eval.test.ts`（新規）・`memory-run.ts`（新規）
- `apps/server/src/testing/opponent-eval/metrics.ts`: 集計の関数 3 つを export（中身は不変）
- `apps/server/package.json`: `eval:opponent-memory`
- docs: `docs/03`（RuleBot の合成）・`docs/05` §5（層の合成と Eval）・`docs/09` §5（Opponent Memory の Eval）・`docs/11` OI-011（新しい暫定値を未確定の側に追記）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 55 files / 698 tests）
- 既存の Claude の CPU の録画の再生（`harness.test.ts`）: 通過（Prompt の指紋は変わらない）
- 変異の確認（手元で入れて戻した）: Orchestrator が cpu1 に cpu2 の Memory を渡すようにすると、「層の値が本番と一致」と「(6) Leakage 0」の 2 つのテストが落ちる
- 手動の計測 `pnpm --filter @proj-poker/server eval:opponent-memory`（既定 200 + 200 Hand・中央値 5 回。WSL2 のローカル環境）の結果:

代表 Spot の割合（Persona ごと。Memory なし / Loose / Tight）:

| Persona | River の Call | Flop の C-bet（Bluff） |
|---|---|---|
| TAG Regular | 0.175 / 0.240 / 0.135 | 0.072 / 0.022 / 0.125 |
| LAG | 0.217 / 0.278 / 0.155 | 0.138 / 0.095 / 0.200 |
| Calling Station | 0.420 / 0.445 / 0.410 | 0.000 / 0.000 / 0.020 |
| Nit | 0.102 / 0.138 / 0.090 | 0.000 / 0.000 / 0.028 |
| Maniac | 0.270 / 0.307 / 0.247 | 0.242 / 0.225 / 0.273 |
| Weak-tight Recreational | 0.135 / 0.150 / 0.113 | 0.000 / 0.000 / 0.020 |

層の条件ごとの Persona Differentiation（層なし 0.226）: Memory Loose 0.222・Tight 0.229・保留 0.226・Tilt 3 段 0.22・卓が緩い 0.225・締まっている 0.225・全部 Loose 0.211・全部 Tight 0.229。Illegal・Check できるのに Fold はどの条件も 0。Action Diversity は層なしの 0.9 倍以上。

Latency（Hand の開始時の計算時間。CPU 5 人分。ミリ秒。Session 1 が 200 Hand・Session 2 が 200 Hand。全体 400 Hand・CPU の判断 1915 回で 17.8 秒）:

| 保存済みの Hand（全 Session） | 今の Session の Hand | Memory | Tilt | Table Tendency |
|---|---|---|---|---|
| 0 | 0 | 0.03 | 0.01 | 0.01 |
| 10 | 10 | 1.63 | 0.10 | 0.22 |
| 25 | 25 | 1.57 | 0.15 | 0.21 |
| 50 | 50 | 2.67 | 0.29 | 0.31 |
| 100 | 100 | 2.34 | 0.37 | 0.43 |
| 150 | 150 | 3.26 | 0.47 | 0.39 |
| 300 | 99 | 8.42 | 0.56 | 0.50 |
| 400 | 199 | 12.35 | 1.20 | 0.67 |

Memory は保存済みの Hand の全体（Fixed CPU は前の Session も読む）にほぼ比例して伸び、Tilt と Table Tendency は今の Session の Hand に比例する。400 Hand で Hand ごとに約 14 ms（#150 の材料）。

## 残課題

- **Memory 等の節の入った Claude の CPU の録画は取っていない**: API の呼び出しが要るため。Claude の CPU については、既存の録画（層の無い代表 Spot）の再生が通り続けることだけを確かめた。Memory / Table Tendency / Tilt の節の入った Prompt の品質（Persona Differentiation・Leakage）を測るなら、手動の Eval に層付きの Spot を足して録画を取り直す。
- 合成の上限（±0.2）と Eval の合格ラインは OI-011 の暫定値。今の Preset では上限に届かないので、Playtest で層の係数を上げるときに見直す（変えるときは Version を上げる）。
- Memory の計算は保存済みの Hand の全体に比例して伸びる（400 Hand で約 12 ms）。Hand 数がさらに増えたときの扱いは #150 で見る。
