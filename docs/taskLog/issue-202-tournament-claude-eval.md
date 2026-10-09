# Issue #202: Tournament の Claude CPU / Review を実モデルで録画する

## 概要

Phase 8 で Tournament の CPU Prompt（Public Tournament Context。#188・D130）と Review（ICM / Chip EV の Evidence。#189）を実装したが、実モデルの Eval / 録画は無かった。人間判断（2026-10-09・AskUserQuestion。Issue コメント https://github.com/takumi-sano22/proj-poker/issues/202#issuecomment-6079749001 が一次情報）で上限を決め、D132 として記録したうえで録画した。

- CPU: 7 Spot × 2 Persona × repeat 2 = 最大 28 Decision / 56 calls（Retry 込み）
- Review: 4 判断 × repeat 2 = 8 Review + Follow-up 2 = 最大 20 calls
- 経路は Claude Agent SDK + Claude Code OAuth + buildClaudeEnv のみ。結果を見て Prompt / Policy を調整しない

## 変更内容

- `apps/server/src/testing/opponent-eval/spots.ts`: `EvalSpot.tournament`（Session の設定・参加人数・Level・Hand 番号・Button・席・Context の有無）を足し、`buildSpot` が本番と同じ `tableConfigForLevel` と `projectKnowledgeState(…, { tournament })` で Tournament の局面を作れるようにした。`stackedDeck` は席と Button を引数で受ける（Cash の Spot の出力は変わらず、既存の録画の指紋も一致）
- `opponent-eval/tournament-eval.ts`（新規）: S0〜S6 の Spot・Persona（Nit / Maniac）・上限（`TOURNAMENT_EVAL_LIMITS` 28 / 56）・`assertTournamentDecisionLimit`・Stage ごとの分布と Context / 層の有無の差（`tournamentReport`）
- `opponent-eval/tournament-run.ts`（新規）・`package.json` の `eval:opponent-tournament`: `--dry-run` / `--record` / `--resume`（memory-prompt-run と同じ形）
- `opponent-eval/memory-prompt-eval.ts`: `assertShellRoute`（シェルの env に API 課金・別経路の変数があれば止める。値は出さない）を足した
- `review-eval/hands.ts`: `ITM_SHORT_CALL`（3 人残り・Pay Jump・BB の 8BB の Hero が Chip Leader の Shove に K7o で Call）と `TOURNAMENT_TURN_BET`（5 人残り・Level 3・All-in でない Turn の最初の Bet）
- `review-eval/harness.ts`: `onDraft`（作った Review の Draft を受け取る。Follow-up の対象にする）。`TOURNAMENT_REVIEW_EVAL_CASES` のコメントを更新
- `review-eval/recording.ts`: `replayReviewQueryFor` の引数を `Pick<ReviewEvalRecording, "records">` に緩めた（Follow-up の録画の再生に流用）
- `review-eval/tournament-eval.ts`（新規）: 録画する判断・Follow-up（質問文は固定）・上限（`TOURNAMENT_REVIEW_LIMITS`）・本番の `generateFollowUp` を通す `runTournamentFollowUps`・Prompt の CPU の Private な情報の検査・Tournament の指標（`tournamentReviewReport`: 数値 Grounding の不正・Chip EV と ICM の混同の疑い・Shove の前提・Unsupported Solver の GTO への言及・漏れ・Follow-up）
- `review-eval/tournament-run.ts`（新規）・`package.json` の `eval:review-tournament`: `--dry-run`（検証を通らない Fake で最悪 20 回を通す）/ `--record`
- テスト: `opponent-eval/tournament-eval.test.ts`・`review-eval/tournament-eval.test.ts`（新規）
- 録画: `opponent-eval/recordings/opponent-tournament-eval.json`・`review-eval/recordings/review-tournament-eval.json`（新規。既存の録画は触っていない）
- docs: `docs/09` §5・§6 に結果と制約、`docs/05` §10 の「実モデルの録画はまだ無い」を更新、`docs/decision_log.yaml` に D132、`docs/00`・`docs/10` の範囲表記を D01〜D132 に

## 判断理由

- **Persona の選択（Nit / Maniac）**: Tournament の節の読み方の指示が「リスク許容度」と「規律」を指す（`TOURNAMENT_PERSONA_LINE`）ので、その 2 軸が両端に近い組にした（Nit 0.2 / 0.8・Maniac 0.9 / 0.15）。他の組（TAG / Calling Station 等）は片方の軸が中間になる
- **Spot の設計**: S1〜S4 は判断する CPU の Stack（10BB）・札（Q6o）・「前が全員 Fold」を固定して Stage だけを変える（残人数が変わるので席は BTN → Heads-Up の SB になる）。Q6o は Chip EV と ICM で結論が割れやすい境目の手。S5 は Chip Leader の Shove に Bubble Factor 2.75 の A9o（Chip EV では Call 寄り・ICM では Fold 寄り）。S0 / S2・S5 / S6 は Hand の ID を同じにし、違いを Context・層の有無だけにした
- **Review の Follow-up**: ReviewService と同じく、保存する Review の Evidence と説明を対象に本番の `generateFollowUp` を呼ぶ（評価専用の引数組み立てを作らない。LC-050）。reviewId は Prompt に入らないので録画の指紋に影響しない
- **Chip EV と ICM の混同**は決定論で厳密に判定できないので、「必要 Equity の値の直前の語が逆」の近似で疑いとして数え、一覧を人が読む形にした
- **`{481}` の扱い**: 数値 Grounding の検査を変えると、この録画の出力が不正になり再録画（上限超過）が要る。D132 の範囲で直さず #208 に分けた

## 実行した確認

### dry-run（モデル 0 回）

- `pnpm --filter @proj-poker/server eval:opponent-tournament --dry-run`: 判断 28（上限 28）・Prompt 28（異なる Prompt 14）・Tournament の節 24（S0 の 4 判断だけ無し）・Memory / Table Tendency / Tilt の節 各 4（S6 だけ）・Leakage 0・`withinLimits: true`。シェル / 子プロセスの env に経路の変数は無し
- `pnpm --filter @proj-poker/server eval:review-tournament --dry-run`: Review 8・Follow-up 2・最悪 20 回（上限 20）。Fake の呼び出し 20 回（Gate で止まる判断なし。全件 Retry → Fallback の最悪経路）・漏れ 0・Solver は Preflop 3 判断が not_applicable、Turn が unsupported

### 録画（実モデル）

- CPU: `eval:opponent-tournament --record`。`claude-haiku-4-5`（opponent_fast）・Agent SDK 0.3.289・**呼び出し 28 回 / 上限 56**（Retry 0）
- Review: `eval:review-tournament --record`。`claude-sonnet-5-5`（review_standard）・**呼び出し 11 回 / 上限 20**（Review 9〔Retry 1〕・Follow-up 2）

### CPU の指標

| 指標 | 値 |
|---|---|
| Structured Output Valid / Illegal / Retry / Fallback | 1 / 0 / 0 / 0 |
| 障害 / Leakage | 0 / 0 |
| Latency（ms。min / median / p90 / max） | 6829 / 8681 / 10802 / 12016 |
| Persona Differentiation | 1 |
| Context の有無（S0 → S2）の TVD | Nit 0・Maniac 1・合計 0.5 |
| 層の有無（S5 → S6）の TVD | Nit 0・Maniac 0.5・合計 0.25 |

- Nit は 14 判断すべて Fold（Heads-Up の SB 10BB の Q6o も Fold）。Maniac は S0 で 3BB の Raise 2、S2・S3 で All-in 2、S1・S4 で Raise / All-in 各 1、S5 で All-in / Call、S6 で Call 2（「ICM のリスクを無視」「bubbleFactor を無視」と書く）
- 所見: Context は形式・合法性・漏れの面では正しく使われているが、戦略は Persona が支配的で、Stage・ICM の差はほぼ出ない → **#207** に起票

### Review の指標

| 指標 | 値 |
|---|---|
| Review / 呼び出し | 8 / 9 |
| Structured Output Valid / Retry / Fallback / Insufficient | 0.889 / 0.125 / 0 / 0 |
| 数値 Grounding の不正 | 1（`bubble_shove/d0#2#1`: 単位を含む値の参照の後ろに単位を重ねた。Retry で通過） |
| Math / KB Grounding | 1 / 0.75 |
| Hindsight Leak / Private な情報の漏れ / 障害 / 識別子の残存 | 0 / 0 / 0 / 0 |
| Shove の前提を assumptions に書いた | 2 / 2 |
| Chip EV と ICM の混同の疑い | 0（初版の判定は 2 件の誤検知。下記「レビュー対応」） |
| Unsupported Solver の GTO への言及 | 1（「GTO の値ではない」の否定。Exact GTO の言及 0） |
| Follow-up | 2 件 answered・1 回で通過・数値 Grounding の不正 0・漏れ 0 |
| Latency（ms） | 13275 / 14280 / 23254 / 23254 |

- 合格ラインは Structured Output Valid 率（0.889 < 0.9）だけ未達（9 回中 1 回の数値 Grounding の不正。Retry で回復）
- 失敗経路: `bubble_call/d0#2` の assumptions に `{481}`（N の無い波括弧）が残った → **#208** に起票

### 品質チェック

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan に記載）

## レビュー対応

- 自己レビュー: ブロッキングなし（PR コメント）
- Codex 1 回目（`STATUS=clean`・P2 1 件）: Chip EV と ICM の混同の判定が「ICM は Chip EV より高い（60.5% と 45.5%）」の並べ方を混同と誤検知（録画の report に 2 件）→ CONFIRMED。判定を「値の直前の同じ節（読点・括弧・コロンで区切った範囲）の語」に変え、節に語が無い値は判定しないようにした。録画の出力（モデルの応答）は変えず、`report` だけを再生から作り直した（モデルは呼んでいない。`summary` は録画と一致を確認）。テストに誤検知の回帰を足した

## 残課題

- #207: Tournament の Claude CPU の戦略品質（Persona が Stage・ICM より強く効く）。改善と再測定の上限は人間判断
- #208: 数値 Grounding が `{481}` を通す。検査を変えるなら録画の取り直しの上限を人間判断
- `README.md`・`.claude/skills/`（sync-check・test-and-review）の D 番号の範囲表記（D01〜D130）は、この Issue の触らない領域なので更新していない（親へ返す）
- 標本は各 Spot・Persona 2 判断で、Stage の効果の大小は結論にしない（事実として記録するだけ）
