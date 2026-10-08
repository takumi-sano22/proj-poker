# Issue #184: Blind / Ante（hand-count・time-base・BBA）を Engine と Hand の開始に組み込む（P8-2）

## 概要

Engine に Ante（`per_player` / `big_blind_ante`。`none` は項目なし）を足し、Tournament の Hand の開始時に Blind Level（hand-count / time-base）を決めて、その Level の Blind / Ante で Hand を始めるようにした。Level と経過は `HAND_STARTED` に固定し、次の Hand と Resume はそこから作り直す。Event の版は 10。Cash の Hand の Event・固定 Scenario・Chip 保存の期待値は変えていない。

## 初期調査

- 前提（main 3c42d0f）: 判断の正本は D108・D127〜D130、docs/02 §7、docs/04 §3 / §12。P8-1（#183・PR #193）の `packages/engine/src/tournament.ts` と `SESSION_STARTED.tournament`（版 9）の上に作る。
- Pot は `HandState.pot` と各席の `totalCommitted`（Pot の段）・`streetCommitted`（Call / Raise の額・Uncalled の返却）で持つ。Pot の組み立ては `side-pots.ts` の `buildPots`（Fold していない Player の Commit で段を切る）。
- Event の Commit を数え直す箇所: `testing/invariants.ts`（テストの Invariant）・`apps/server/src/opponents/tilt.ts`（CPU の収支）・`apps/web/src/lib/dealer-feedback.ts`（判断の直前の Pot）。`decision-analysis.ts` の `winnablePot` は各席の Commit の合計で取りうる Pot を数える。
- Hand は 1 つのプロセスの中で始まって終わる（Hand の途中の Resume はしない）。Event Store は追記ごとに記録時刻（`recordedAt`）を付ける。

## 設計方針

- **Ante の置き場所**: `TableConfig.ante?: { kind, amount }`（Cash の Preset は持たない）。Tournament の Hand は `tableConfigForLevel(base, level, anteKind)` がその Level の額で持たせる（none・額 0 の Level は持たせない）。`HAND_STARTED.ante` に写す。
- **Pot での扱い（D128）**:
  - Dead Money なので `streetCommitted` に入れない（Call / Raise の額・Uncalled の返却に数えない）。
  - `per_player`: `DECK_SHUFFLED` の直後・Blind より前に Button の左から全員が払い、`totalCommitted`（Pot の段）に入れる。Stack が Ante と Blind の両方に足りなければ Ante が先（人間判断を経ていない OI-007 の暫定 Policy。docs/02 §7・docs/11 に記載）。
  - `big_blind_ante`: BB の `BLIND_POSTED` の直後に BB の席が Blind の残りの Stack で払う（0 なら置かない）。誰の Commit にも数えず `HandState.mainPotAnte` に持ち、`buildPots(contributors, mainPotDeadMoney)` で Main Pot にだけ足す。Ante で BB が All-in になったら最初の Actor を決め直す。
- **Level（D128・D117）**: `levelAt(config, { handNumber, playTimeMs })`。hand_count は Session の何 Hand 目か、time_base はプレイ時間の累計で決め、最後の Level は続ける。`HAND_STARTED.tournament = { level, handNumber, playTimeMs }`（この Hand の開始までの累計）を固定する。
- **プレイ時間**: Orchestrator が Hand の開始から終わり（`HAND_FINISHED` の追記）までを、プロセスの中の単調な時計（`playClock`。既定 `performance.now()`）で測る。前のプロセスで終わった Hand（Resume の直後の最初の Hand の計算）だけは、保存した最初の Event と `HAND_FINISHED` の記録時刻の差で測る。どちらも負・数でない長さは 0 として数え（`nextTournamentProgress`）、累計を減らさない。Hand の間・アプリを閉じていた時間は数えない。順序には使わない（Hand の順は Event の chain＝論理順序）。
- **版**: `EVENT_SCHEMA_VERSION` を 10 にした（D129）。Ante・Level の無い Hand は両方の項目を持たず版 9 と同じ形なので、版 9 までの行は変換せずに読み、Engine は `ante` の無い `HAND_STARTED` を Ante なし（`state.ante = null`）として畳み込む。版 9 で足したときと同じく upcast の関数は足していない（Ante なしとして読むことはテストで確かめた）。版 9 で保存した Tournament の Hand（`tournament` を持たない）の次の Hand は、Session の終わった Hand の数から Hand の番号を作り、プレイ時間 0 から数える。
- **Fold した Player の Ante**: Fold した Player の Ante は返さない（D128 の「Uncalled の返却に数えない」）。Property テストが見つけた「BB が per_player の Ante だけで All-in し、相手が Fold」の場合は、Fold していない誰の Commit も超える Fold した Player の Chip が最後の Pot に入る（`buildPots` の既存の扱い）。Invariant（`checkPotAwards` の上限）はこの Dead Money を足して確かめるようにし、縮小済みの反例を Scenario に昇格した。人間判断を経ていない暫定 Policy として docs/02 §7・docs/11 に書いた。
- **範囲外**: 卓 UI の Level / Ante の表示（#190）、CPU の Public Tournament Context（#188）、Review の ICM（#189）、Elimination（#185）、Payout（#186）。Web は `ANTE_POSTED` の進行ログの 1 行と、判断の直前の Pot への算入だけ（型の網羅と Pot の正しさのため）。

## 変更内容

- Engine（`packages/engine`）
  - `src/table-config.ts`: `PostedAnteKind`・`AnteConfig`・`TableConfig.ante?`。
  - `src/hand-events.ts`: `HAND_STARTED` の任意項目 `ante`・`tournament`、`ANTE_POSTED`（public）。
  - `src/hand-state.ts`: `HandState.ante`・`mainPotAnte`、`ANTE_POSTED` の Reducer（`payAnte`）。
  - `src/hand-engine.ts`: `startHand` の Ante の支払い（`postAnte`）と `StartHandInput.tournament`・入力の検証、`awardPots` が Main Pot の Dead Money を渡す。
  - `src/side-pots.ts`: `buildPots` の `mainPotDeadMoney`。
  - `src/tournament.ts`: `tableConfigForLevel` に Ante、`TournamentHandContext`・`TournamentProgress`・`FIRST_TOURNAMENT_PROGRESS`・`nextTournamentProgress`・`levelAt`・`tournamentHandContext`・`isTournamentHandContext`。
  - `src/decision-analysis.ts`: `winnablePot` に Main Pot の Dead Money（判断時点の Pot − Σ 各席の Commit）を足す。
  - `src/testing/invariants.ts`: Ante を Commit・Pot・上限の数え直しに入れる。
  - `src/index.ts`: export。
  - テスト: `hand-scenarios.test.ts`（Ante の Scenario 8 件と `antes` の期待値）・`hand-engine.property.test.ts`（Ante・不均等 Stack の Property 1 件、Session の Property に Ante の卓）・`hand-engine.test.ts`（4 件）・`tournament.test.ts`（Level の決め方 5 件・`tableConfigForLevel`）・`decision-analysis.test.ts`（BBA 1 件）。
- Server（`apps/server`）
  - `src/hand-orchestrator.ts`: `playClock`、`HandRuntime.playStartedAt / playFinishedAt`、`tournamentHandOf`・`progressAtStartOf`・`handPlayTimeMs`（`tableConfigOf` を置き換え）。
  - `src/sqlite-event-store.ts`・`src/event-upcast.ts`: 版 10 と、版 9 の行を変換せずに Ante なしとして読む説明。
  - `src/opponents/tilt.ts`: 自分の Ante を収支の出した額に数える。
  - テスト: `tournament-session.test.ts`（hand_count の Level と BBA・time_base の累計と Hand の間を数えないこと・時計の巻き戻り・Cash の形・再起動後の Level の作り直し・記録時刻の巻き戻り）・`sqlite-event-store.test.ts`（版 10 の保存と読み直し・版 9 の行を Ante なしとして読む）。
- Web（`apps/web`）: `src/lib/view-model.ts`（進行ログの `ANTE_POSTED` の行）・`src/lib/dealer-feedback.ts`（判断の直前の Pot に Ante を入れる）。
- Docs: docs/02 §7（per_player の暫定 Policy と Level の記録）、docs/03 §1（Tournament の Level とプレイ時間の測り方）、docs/04 §3（`HAND_STARTED`・`BLIND_POSTED`・`ANTE_POSTED` の行と版 10）・§12（Phase 8 の Tournament）、docs/11 OI-007（暫定 Policy）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（worktree のルート）: すべて成功。
  - engine 415 件・web 147 件・server 799 件（PR 作成前の時点）。
- `POKER_PROPERTY_RUNS_FACTOR=5` で Scenario と Hand 進行の Property を 3 回、`=3` で Ante 付きの Session の Property を 1 回回し、失敗なし。
- Cash の既存の Scenario・テストの期待値は変更していない。版の値をリテラルで見るテストは無かった（すべて `EVENT_SCHEMA_VERSION` 参照）。

## 残課題

- 卓 UI での Level・Ante・次の Level までの表示（#190）。
- CPU の KnowledgeState への Level / Ante（Public Tournament Context。#188）。`memory/observation.ts` の `context` は cash のまま（#188）。
- per_player の Ante の 2 つの暫定 Policy（Ante が先・Fold した Player の Ante は返さない）は人間判断を経ていない（OI-007。標準 Preset は big_blind_ante なので使われない）。
