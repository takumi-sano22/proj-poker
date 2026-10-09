# Issue #186: Payout / Tournament Result を決定論で作る（P8-4）

## 概要

Tournament の Prize Pool・順位ごとの賞金（Payout）・Player ごとの Payout を足した Tournament Result を、Event Log から都度計算する Engine の純関数 `tournamentResult` として作った。Payout は pt（参加費の単位）で、Chip とは別の量として扱う。新しい Event・テーブル・マイグレーションは足しておらず、Event の版は 10 のまま。Cash の経路・Event・テストの期待値は変えていない。

## 初期調査

- 前提（main 2c627c3）: 判断の正本は D108・D127・D129、docs/02 §7（端数・同順位の OI-007 暫定 Policy）、docs/04 §3 / §12。P8-1（#183）の `SESSION_STARTED.tournament`（設定の Snapshot。`entryFee`・`payout` を持つ）と P8-3（#185）の `tournamentStandings`（順位。同順位・未決〔null〕・打ち切り〔abandoned〕を表す）の上に作る。
- `PayoutStructure` は `kind: "percentages"` の判別 Union で、`validateTournamentConfig` が割合の合計 100%・上位ほど多いか同じ・入賞の数 ≤ 参加人数を検証済み。
- Orchestrator には #185 の `tournamentStandingsOf(handId)` があり、HTTP の API はまだ無い（画面は #190）。

## 設計方針

- **Prize Pool**: 参加費（Snapshot の `entryFee`）× 参加人数（Session の最初の Hand に座った人数。`standings.entrants`）。D127 の 100pt × 6 = 600pt。
- **順位ごとの賞金（`payoutsByPlace`）**: Prize Pool × 割合 / 100 を切り捨て、余りを上位から 1pt ずつ（docs/02 §7 の既存の暫定 Policy）。切り捨ての損は順位ごとに 1pt 未満なので余りは入賞の数未満で、1 周で配り切れる。合計 100% を関数の中でも検証し直す（Snapshot を JSON から読むため）。Custom Payout は `kind` を足して `switch` で分岐する形（D108）。
- **Player ごとの Payout**: 順位が決まった Player はその順位の賞金（入賞外は 0）。同順位の n 人はその順位から n 個分の賞金を合算して等分し、余りは Bust した Hand の席順で Button の左から 1pt ずつ（D75 の端数と同じ考え方）。順位が未決なら `null`（未確定）。
- **Hero の Bust（D129）**: Hero の順位が決まった時点で Hero の Payout も確定する。残った CPU は未確定（null）。
- **版**: 端数・同順位の配り方は人間判断を経ていない暫定 Policy なので、`PAYOUT_POLICY_VERSION = "phase8_provisional_v1"` を Result に残す（Result は都度計算なので、規則を変えたら版を上げてどの規則の額かを読めるようにする）。
- **矛盾する入力**: 入賞の数が参加人数より多い（Prize Pool を配り切れない）なら RangeError（Server は Preset の人数の卓でだけ Tournament を始めるので通常は起きない）。
- **人間判断を経ていない規則（OI-007 の暫定 Policy として docs/02 §7・docs/11 に明記）**: 同順位が入賞の境目をまたぐときは入賞外の 0pt も含めて等分する／同順位の余りの席順は Bust した Hand の席順と Button／`ai_outage` で打ち切った Tournament は決まった順位の Payout だけを確定し、残っていた Player（Hero を含む）の Payout は未確定のまま（払い戻し等はしない）。PR の Review Required に記載。
- **テストのヘルパー**: #185 の順位のテストにあった「Engine で All-in の Hand を進めるヘルパー」を `src/testing/tournament-hands.ts` へ移し、順位と Payout のテストで共有した（順位のテストの中身・期待値は変えていない）。

## 変更内容

- Engine（`packages/engine`）
  - `src/tournament-payout.ts`（新規）: `prizePoolOf`・`payoutsByPlace`・`tournamentResult`・`PAYOUT_POLICY_VERSION`・`TournamentResult`・`TournamentResultPlacement`。
  - `src/tournament-payout.test.ts`（新規）: 標準 600pt → 300 / 180 / 120、端数、Custom の割合、不正な割合・Prize Pool、6 人の Hero 優勝（入賞外 0・合計保存・決定論）、3 人同順位の余りを Button の左から、入賞の境目をまたぐ同順位、Hero の Heads-Up の Bust（in_progress での確定分も）、入賞外での Hero の Bust、`ai_outage` の打ち切り、入賞の数 > 参加人数、cash・旧版は null。
  - `src/tournament-payout.property.test.ts`（新規）: 合計 100 の任意の割合と Prize Pool で、Σ = Prize Pool・各順位は切り捨て額か +1・+1 は上位から連続・上位ほど多いか同じ。
  - `src/testing/tournament-hands.ts`（新規）: 上記のヘルパー（`tournament-standings.test.ts` から移動）。
  - `src/index.ts`: export。`src/tournament.ts`: コメントの参照先。
- Server（`apps/server`）
  - `src/hand-orchestrator.ts`: `tournamentResultOf(handId)`。
  - `src/tournament-session.test.ts`: Tournament を終わりまで進めた Result（600pt・300 / 180 / 120・順位は standings と一致・未決の順位の Payout だけが null・確定した Payout と未決の順位の賞金の合計が Prize Pool・決定論）。cash の Session は null。
- Docs: docs/02 §7（Payout と Result・暫定 Policy の細部）、docs/03 §1（`tournamentResultOf`）、docs/04 §3（「Tournament の Payout と Result」・版 10 のままの理由）・§12、docs/11 OI-007。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（worktree のルート）: すべて成功（engine 435 件・web 147 件・server 801 件）。
- Cash の既存のテストの期待値は変更していない（Cash の Session の `tournamentResultOf` は null を追加で確認）。

## 残課題

- HTTP の API と卓 UI での Result の表示は #190。
- ICM（#187）は `payoutsByPlace` を Prize の列として使える。
- 端数・同順位・打ち切りの扱いは人間判断を経ていない暫定 Policy（OI-007）。
