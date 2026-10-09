# Issue #190: Tournament の UI（P8-8）

## 概要

Hero が UI で 6-max STT を始めて完走できるよう、新しい Session の種類の選択（Cash / Tournament の標準 Preset。D128）、卓の Tournament の表示（Level・Blind・Ante・次の Level までの残り・残人数・Payout・Elimination）、Hero の Bust / 優勝で終えた Result（D129）、Review の ICM / Prize Equity と Chip EV の別表示（D130）を足した。#189 から引き継いだ Replay・Session Review の Important Spot の Tournament の理由も足した。

## 初期調査

- 正本: D49・D108・D127〜D130、`docs/06` §15、`docs/02` §7、`docs/05` §10。
- server は P8-1〜P8-7 で実装済み。開始の API の `session`（#183）、Level・Ante は `HAND_STARTED`（#184）、順位・Result は Orchestrator の `tournamentStandingsOf` / `tournamentResultOf`（#185・#186。HTTP の API は無い。Session の**終わった** Hand だけから作るので、Session の最初の Hand の途中では null）。
- Review の Evidence（`ReviewEvidence.tournament`）は API の応答にそのまま入っている（web の型と画面が無かった）。
- Important Spot: Review は `reviewSpotReasons` で Tournament の理由を足すが、Replay（`replayImportantSpots`）と Session Review（`importantHands`）は `extractImportantSpots` のままだった。
- `ui-design-recipes` の `references/proj-poker.md`・`implementation-guidance` の `ui.md` / `ai-boundary.md`・台帳 LC-040〜043 を先に読んだ。#179（RULING / 320px の Hero 欄）は既知の課題。

## 設計方針（人間判断を経ていない表示の規則は暫定。PR の Review Required）

- **API**: `GET /api/hands/:handId/tournament` → `{ tournament: TournamentTableStatus | null }`。Orchestrator の `tournamentTableOf` が、この Hand の開始時の Level・Blind・Ante（`HAND_STARTED`）、次の Level（hand_count は始まる Hand の番号、time_base は残りのプレイ時間を要求の時点で測る。0 なら次の Hand から）、Session の最初の Hand から**この Hand まで（進行中を含む）**の `tournamentResult` を都度計算する。公開の情報だけ（Persona・札を含まない）。
- **Session の種類の選択**: `useHandSession` に `sessionChoice` と `startNewSession` を足し、新しい Session を始める操作（最初の画面の「Hand を始める」・「新しい Session を始める」）だけが `session` を送る。「次の Hand へ」「卓に戻る」は送らない。`session_mode_mismatch` は「続きから遊ぶ」で設定を送らずに続きへ戻れる。
- **見出し**: Tournament は「Level 2 · 15 / 30 · BB Ante 30」。Cash は変えない。幅 359px 以下は Ante を見出しから省く（見出しが 1 行増えたため）。
- **Tournament の欄**: 進行ログの上。Level・Blind・次の Level・残人数を常に出し、Payout と脱落は `details` に畳む（最初は全部を開いて出したら 1280×720 で進行ログが Hero 欄の下に隠れたため）。終わったら開いて順位と Payout（未決は先に「未決」「未確定」）。
- **Result**: Session の終わりの案内を Hero の順位と Payout の 1 文にする（読めるまでは Cash と同じ文）。
- **Review**: 「Tournament（ICM / Prize Equity と Chip EV）」の欄。ICM Equity は pt（小数第 1 位）と %、All-in は相手ごとに Chip EV / ICM の必要 Equity を別の列、Shove は「〈相手〉に Call された場合」と前提の文。Math の見出しを「計算（Math・Chip で計算）」にする。
- **Important Spot**: `importantSpotsOf`（`review/tournament-evidence.ts`）を足し、Review の `reviewSpotReasons`・Replay・Session Review が同じ関数を通る（LC-050 と同じ考え方。画面ごとに理由が食い違わない）。Engine の `projectHandSummary` は Session の設定を持たないので変えない。

## 変更ファイル

- server: `hand-orchestrator.ts`（`TournamentTableStatus`・`tournamentTableOf`）、`routes/hands.ts`（GET の route）、`review/tournament-evidence.ts`（`importantSpotsOf`）、`review/evidence.ts`、`replay.ts`、`learning/session-review.ts`
- web: `App.tsx`、`hooks/useHandSession.ts`・`useTournament.ts`（新規）、`lib/api.ts`・`tournament.ts`（新規）・`review.ts`・`review-api.ts`、`components/TournamentPanel.tsx`（新規）・`ReviewEvidence.tsx`・`ReviewPass.tsx`、`styles.css`
- テスト: `apps/server/src/tournament-table.test.ts`（新規）、`apps/web/src/components/tournament.test.tsx`（新規）
- docs: `docs/03` §1（API・Session・web の構成・Replay）、`docs/05` §10、`docs/06` §15、`docs/07` §6

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 480・web 160・server 842）/ `pnpm format:check`: すべて通過。
- E2E（Cash の既存の配置の回帰）: 全 11 本（`session`・`session-end-layout`・`table-layout`・`learning`・`opponent-memory`・`review-tendency`）が通過。
- Playwright で dev サーバー（RuleBot・Review は fake）を使い、Tournament を Hero の Bust まで遊んで実測（使い捨てのスクリプト）:
  - 横スクロール: 320×568・375×667・720×600・1024×768・1280×720/800/900 のすべてで 0。
  - 見出しの高さ: Cash と同じ（320・375 は 155px、720 以上は 68px）。Ante を省く前は 320 で 176px（+21px）・Level の表記を短くする前は 720 で 120px（+52px）だった。
  - Hand の途中の Hero 欄の高さは Cash と同じ部品なので変わらない（#179 を悪化させない）。Session の終わりの Hero 欄は、`select` が 1 つ増えるため、狭い画面と 720px 台で 1 行（約 50px）高くなる。1280×720 は同じ行に収まる（115px）。Cash の配置の E2E の hit-test は通過。
  - Review: Hero の Shove の判断で、ICM Equity（230pt・47.9% / 250pt・52.1%。Heads-Up で争う 480pt）と、Chip EV / ICM の必要 Equity（49.4% / 49.4%）を別の列で表示。

## 残課題

- Tournament の E2E と README は #191。
- time-base の残り時間は、卓の状態が進むたびに読み直す（Hand の途中で何も起きなければ表示は進まない）。
- Session Review の画面に Tournament の Result を出すか（今は卓の欄と Hero の欄だけ）。
- Session の終わりの Hero 欄の `select` で、狭い画面では 1 行高くなる（Cash も同じ）。
