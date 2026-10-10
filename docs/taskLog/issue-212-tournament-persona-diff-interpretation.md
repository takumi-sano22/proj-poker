# Issue #212: Tournament の Claude CPU で Bubble Factor の高い Call の Spot に Maniac が慎重側へ寄りすぎた結果の扱いを決める

## 目的

#207（D133）の再測定で、S5 / S6（Bubble・Bubble Factor 2.75 で Chip Leader の Shove に A9o で Call するか）の Nit と Maniac がともに Fold し、Spot 別の Persona Differentiation と Layer Effect が 0 になった。この結果をどう読むかを人間判断（Issue の依頼文。D134 に記録）として確定し、Decision と docs を同期する。Prompt の再修正・実モデルの呼び出し・再録画はしない。

## 変更内容

- `docs/decision_log.yaml`: D134 を追加した（D133・D132 は変えていない）。先頭の範囲表記を D01〜D134 に
- `docs/05_AI_OPPONENTS_AND_REVIEW.md` §10: Tournament の Claude CPU の説明の下に「Tournament の Persona の差の読み方（#212・D134）」を追加した
- `docs/09_TEST_STRATEGY.md` §5: 指標の表の Persona Differentiation の合格ラインに「Spot を平均した値で判定・Spot 別は診断用」を足し、「Tournament の Claude CPU の Persona Differentiation の解釈（Issue #212・D134）」の節を追加した（#207 の節の記録は書き換えていない）
- `docs/10_DECISION_TRACEABILITY.md`: D134 の行を追加・範囲表記
- 範囲表記 D01〜D134: `docs/00`・README（採用済み判断の行のみ。現在地・主要制約は変わらないので他は触っていない）・`.claude/skills/sync-check`・`.claude/skills/test-and-review`

## 判断理由

- Persona Differentiation の定義（`metrics.ts` の `summarizeOpponentEval`）は Spot ごとの TVD の平均をさらに Spot で平均した aggregate で、合格ライン `OPPONENT_EVAL_TARGETS.minPersonaDifferentiation = 0.2` もその値に当てている。Spot 単位の Gate は元々無く、D134 はそれを明文化したもので、コードの合格ラインは変えていない
- Persona は状況を無視する理由ではなく境界判断の偏りという D133 の意味論から、強い Tournament pressure の Spot で Persona が同じ Action に収束するのは許容される
- repeat 2 の少数標本と、Push/Fold Solver / Nash Range を持たない構成（D109・D130）では、S5 / S6・S1 / S2・S4 の Action の正誤を判定できない。そこへ Prompt を合わせると過学習になる
- production code・録画・`TOURNAMENT_PERSONA_GUIDE`・`PERSONA_PRESETS`・RuleBot・KnowledgeState・ICM・Engine・Eval の合格ラインは変えていない

## 実行した確認

- 録画から再導出（`python3` で 2 つの録画の `cases[].attempts[-1].output.action` を数え、`metrics.ts` / `tournament-eval.ts` と同じ TVD で計算）:

| 指標 | #202 `opponent-tournament-eval.json` | #207 `opponent-tournament-eval-v2.json` |
|---|---:|---:|
| 判断 / 呼び出し / 実行 | 28 / 28 / 1 | 28 / 28 / 1 |
| Retry / Leakage / Valid / Illegal / Fallback | 0 / 0 / 1 / 0 / 0 | 0 / 0 / 1 / 0 / 0 |
| Persona Differentiation（全体） | 1 | 0.571 |
| Spot 別（S0〜S6） | 1 / 1 / 1 / 1 / 1 / 1 / 1 | 1 / 0.5 / 0.5 / 1 / 1 / 0 / 0 |
| Context Effect（Nit / Maniac / 合計） | 0 / 1 / 0.5 | 0 / 1 / 0.5 |
| Layer Effect（Nit / Maniac / 合計） | 0 / 0.5 / 0.25 | 0 / 0 / 0 |
| Latency median（ms） | 8681 | 10190 |

  録画の `summary` に保存された値・`docs/09` §5 の #207 の表と一致した
- `git diff --stat a08f961 61b69bb -- …/recordings/`: #207 で追加されたのは v2 だけで、#202 の録画は変わっていない
- `OPPONENT_EVAL_TARGETS.minPersonaDifferentiation = 0.2`（`metrics.ts`）を確認
- D134 は未使用の次番号（D133 が最後）。範囲表記 `D01〜D133` の残りが無いことを grep で確認
- `pnpm format:check`
- モデルの呼び出し: 0 回（Prompt の変更なし）

## 残課題

- Tournament で Persona 差が体感できないかは #203（人間の実機受け入れテスト）等の Playtest で見る。問題が出たら別 Issue で、Prompt・Persona Policy・決定論の Tournament Policy・Solver / Range のどこを直すかを人間判断してから進める（D134）
