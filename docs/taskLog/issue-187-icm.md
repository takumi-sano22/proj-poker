# Issue #187: 2〜8 人の決定論 ICM Calculator を作る（P8-5）

## 概要

Stack（Chip）と順位ごとの賞金（pt）から、2〜8 人の ICM Equity（pt と %）・Hero から見た相手ごとの Bubble Factor・All-in の判断（All-in への Call / Shove）の ICM の必要 Equity と Chip EV の必要 Equity を計算する Engine の純粋関数 `packages/engine/src/icm.ts` を作った。方式は Malmuth-Harville（OI-007 の暫定 Policy）を Version 付きの Policy に置いた。Event・テーブル・Server・UI は変えていない（CPU への注入は #188、Review の Evidence は #189、画面は #190）。

## 初期調査

- 前提（main 5c20e61）: 判断の正本は D109（決定論の ICM・LLM を正本にしない・Chip EV と別 Evidence）・D130（全席の Equity・Bubble Factor・All-in の必要 Equity。Shove は「特定の 1 人に Call され、ほかは Fold」の条件付き、Fold Equity・Call 頻度は含めず前提を明示）、docs/02 §7、OI-007（ICM の方式は Malmuth-Harville の暫定値）。
- P8-4（#186）の `payoutsByPlace`（順位ごとの賞金。pt の整数列）と `tournamentResult`（順位・残人数・`payoutsByPlace`）を入力に使える。
- Pot は既存の `buildPots`（Side Pot。Fold した Player の Dead Money・`big_blind_ante` の Main Pot の Dead Money）で組める。

## 設計方針

- **Equity**: 部分集合 DP（上位から決まった Player の集合ごとの確率。2^n × n）。全順列（8! = 40,320）を数えない。賞金のある順位までだけ展開する。
- **入賞人数より少ない人数**: 残っている n 人は 1〜n 位を争い、n 位より下の賞金（すでに Bust した Player のもの）は含めない。`prizePool` は争う賞金の合計で、Σ Equity と % はこれに対して閉じる。賞金の列が n より短ければ足りない順位は 0。
- **Stack 0**: Stack の残っている全員より下の順位。Stack 0 が複数ならその順位を等確率で分ける（同順位の賞金の等分と同じ値）。Bubble Factor・必要 Equity の「負け」の結果で Hero の Stack が 0 になるため必要。
- **Bubble Factor**: Hero と相手の Stack の小さい方を 1 対 1 で取り合う（Dead Money なし）ときの「負けで失う ICM Equity ÷ 勝ちで得る ICM Equity」。賭けられない・勝っても Equity が増えないときは null。
- **All-in の必要 Equity**: 判断時点の各席（手元の Chip・この Hand で出した額・Fold の有無）と `big_blind_ante` の Dead Money から、Fold / Call されて勝つ / 負けるの 3 結果の Hero の Stack と ICM Equity を作り、損益分岐の勝率 q（q × 勝ち + (1 − q) × 負け = Fold）を ICM と Chip の両方で返す。Chip で計算した値は All-in への Call では Pot Odds と一致し、ICM の値と別の項目として返す（D130）。
  - Call: 相手の額が決まっているのでそのまま。Fold の比較点では相手が Pot を取る。相手か Hero のどちらかが All-in になる Call だけを受け付ける。
  - Shove: Call しうる相手（まだ Fold しておらず Stack が残っている）ごとに条件付きで出す。比較点（Hero が Fold した場合）で Pot を取る Player は一意に決まらない（Preflop なら BB や最後の Raiser）ので、呼び出し側が渡して `assumptions.potWinnerIfHeroFolds` に残す。
  - 前提（`othersFold: true`・`foldEquityIncluded: false`・`callFrequencyIncluded: false`・`potWinnerIfHeroFolds`）を型で戻り値に明示し、Review AI へ前提ごと渡せるようにした。
  - Multiway の All-in（相手以外に All-in した・すでに相手の Bet に揃えた Player がいる）・All-in の関わらない判断は範囲外として RangeError。
- **Payout / Standings との接続**: `tournamentIcm(result, stacks)` が、順位が未決で Bust していない Player の顔ぶれと Stack を照合し、`result.payoutsByPlace` で計算する。Stack の時点（Hand の開始時・判断時点）は呼び出し側（#188 / #189）が決める。
- **差し替え**: `IcmPolicy`（`version`・`method`）を引数（既定 `ICM_POLICY`）にし、`method` で switch する。結果に `policyVersion` と `method` を残す。
- **人間判断を経ていない規則**（OI-007 の暫定 Policy として docs/02 §7・docs/11 に明記）: 版 `phase8_icm_provisional_v1`、Stack 0 が複数のときの等分、Shove の比較点の Pot の行き先を呼び出し側が渡すこと。

## 数値精度

- Stack・Payout は整数で受け取り、確率・Equity・必要 Equity は倍精度で丸めずに返す。
- テストの許容誤差: Scenario は `toBeCloseTo(…, 9)`（小数第 9 位）、Property は争う賞金の合計に対する相対 1e-9。
- 表示・Evidence に出すときだけ pt・%・必要 Equity（% 表記）を小数第 1 位に四捨五入する（比較・判定は丸める前の値）。

## 変更内容

- Engine（`packages/engine`）
  - `src/icm.ts`（新規）: `icmEquities`・`bubbleFactors`・`icmCallAllIn`・`icmShove`・`tournamentIcm`・`ICM_POLICY`・`ICM_MIN_PLAYERS` / `ICM_MAX_PLAYERS` と型。
  - `src/icm.test.ts`（新規）: 手計算の Scenario（2 人 1,000 / 500 で 260 / 220・3 人 50 / 30 / 20・同額・Winner Take All・Stack 0 が 1 人 / 2 人・賞金の列が人数より短い・8 人）、入力の拒否、Bubble Factor（Heads-Up は 1・3 人同額は 4/3・null の条件）、Call（同額で ICM 8/13・Blind の Dead Money で Pot Odds 18/41・Hero が足りない All-in の Call）、Shove（SB vs BB・相手ごと・Hero の超過の返却）、範囲外の拒否、`tournamentIcm` の接続。
  - `src/icm.property.test.ts`（新規）: 2〜8 人・Stack 0 / 同額を含む任意の Stack と上位ほど多いか同じ賞金で、Σ Equity = 争う賞金の合計・% の合計 100・0 ≤ Equity ≤ 1 位の賞金、Stack が多いほど Equity が多いか同じ・同額は同じ、Chip を受け取ると Equity が減らない、並べ替えで各 Player の Equity が変わらない。All-in の Spot で Hero の Chip が 負け ≤ Fold ≤ 勝ち・Chip EV の必要 Equity が 0〜1・前提が明示される。
  - `src/index.ts`: export。
- Docs: docs/02 §7（ICM Calculator の入出力・Stack 0・Bubble Factor・必要 Equity の前提・数値精度）、docs/03 §1（`icm.ts`）、docs/11 OI-007（#187 の暫定 Policy）。docs/04 は Event・永続化を変えていないので変更なし。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（worktree のルート）: すべて成功（engine 461 件・web 147 件・server 801 件）。
- `POKER_PROPERTY_RUNS_FACTOR=100` で ICM の Property を 100 倍のケース数で実行: 成功。
- 性能（一時的なテストで計測し、計測後に削除。WSL2・Node 24）: 8 人の `icmEquities` 1,000 回で 12.3ms（1 回約 0.012ms）、8 人全員を Hero にした `bubbleFactors` 100 周で 96.9ms（1 Hero 約 0.12ms）、8 人（Call しうる相手 7 人）の `icmShove` 100 回で 19.4ms（1 回約 0.19ms）。Hand の開始や Review の 1 判断ごとに呼んでも問題ない。

## 残課題

- CPU の Public Tournament Context への注入（Stage を含む）は #188、Review の Evidence（Chip EV の必要 Equity と並べる・前提の表示）は #189、画面は #190。
- 方式・Stack 0 の扱い・Shove の比較点は人間判断を経ていない暫定 Policy（OI-007）。
- Push/Fold Solver（Fold Equity・Call 頻度を含む EV）は Phase 8 の初期 Scope 外（D109）。
