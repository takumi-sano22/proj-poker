# Issue #68: Replay を作り、README を Phase 4 の到達点に更新する

## 概要

Phase 4（Live Mechanics）の最終 PR。保存済みの Event を Hero の視点で一手ずつ再生する Replay（server の Replay Service と API、web の Hand 一覧と再生画面）を作った。Replay は Event Log の prefix を `projectHeroView` に渡すだけで、Engine・CPU・AI を動かし直さない（Re-simulation ではない。D38）。Hand 一覧から選び、Previous / Next / Play / Pause で再生し、Showdown で公開された札は公開時点から見える（D93）。README を Phase 4 の到達点に更新した。あわせて #63 の申し送りどおり Opponent Eval を手動で回して録画を取り直し、Spot の Rule Profile を本番の Preset に戻した。Event の形・`schema_version`・永続化スキーマ（テーブル・マイグレーション）は変えていない。

## 初期調査

- 前提（main c8c86fe）: Event は版 5。`EventStore.read(handId)` は seq 順で upcast 付き。Engine の `projectHeroView` / `visibleEvents` は Event の prefix からその時点の Hero の視点を作れる。Hand の一覧を返すクエリは無かった（`sessions` / `hands` テーブルはある）。
- `SqliteEventStore` は `HAND_FINISHED` の時点でだけ SQLite に書き、途中の Hand はメモリ（`pending`）に持つ（D62）。D88 により AI 障害の後に Session 終了で打ち切った Hand は `HAND_FINISHED` が無いまま `pending` に残る。→ 一覧は `hands` の行と `pending` を合わせる。テーブルに手を入れずに済む（マイグレーション不要）。
- 1 Event ずつ再生すると、Action に決まった `DEALER_RULING` の step では直後の `ACTION_TAKEN` がまだ無く、`dealerFeedbackAt` の RULING の文言から結果（「コール 2 として扱います」）が落ちる。Live では裁定と Action は同じ追記で同時に届く（D90）。
- Dealer Feedback の Hero 欄の部品（`HeroFeedback`）は `App.tsx` の中の関数だった。Replay でも使うので共有の部品に移した（中身は変えていない）。

## 変更内容

### Replay（server）

- `apps/server/src/event-store.ts`: Interface に `listHands(limit)`（Event のある Hand を開始の新しい順に `{ handId, startedAt, finishedAt }`。`HAND_FINISHED` が無ければ `finishedAt: null`）を足し、メモリ内の実装と共通の `summarizeLog` を足した。
- `apps/server/src/sqlite-event-store.ts`: `listHands` は `hands` を `started_at DESC, rowid DESC LIMIT ?` で読み、メモリの途中の Hand と合わせて並べ直す。再起動すると途中の Hand は一覧から消える。
- `apps/server/src/replay.ts`（新規。Replay Service）: `replaySteps`（Hero に見える Event の prefix ごとの `projectHeroView`。Action に決まった裁定だけ直後の `ACTION_TAKEN` と 1 step にまとめる。`legalActions` は `null`）、`summarizeReplayHand`（一覧の 1 行: Hero の札・収支〔`HAND_FINISHED` の Stack − `HAND_STARTED` の Stack〕・`complete`。Hero に見える Event だけから作る）、`ReplayService`（`list` は最大 `REPLAY_LIST_LIMIT`＝100 件・`hand` は `players` と `steps`）。
- `apps/server/src/routes/replay.ts`（新規）: `GET /api/replay/hands` と `GET /api/replay/hands/:handId`（Event が無ければ 404 `hand_not_found`、形の不正は 400）。`app.ts` で Orchestrator と同じ Store を渡して登録した。

### Replay（web）

- `apps/web/src/lib/api.ts`: `getJson`・`fetchReplayHands`・`fetchReplayHand` と型。
- `apps/web/src/lib/replay.ts`（新規）: step の移動（端で止まる・最後の step で Play を押すと最初から）、`stepCaption`（進行ログと同じ文言に、Hero の宣言・Chip の操作・裁定の行を足す）、一覧の収支（実額 + BB 補助）・Hero の札・開始時刻の表記。
- `apps/web/src/hooks/useReplay.ts`（新規）: 一覧と Hand の取得（取得のたびに番号を振り、最後の要求の応答だけ採る。一覧と Hand で別々）と、step・再生中の状態。再生は `REPLAY_STEP_MS`（`lib/config.ts`。暫定値 900ms）ごとに進め、最後の step で止める。
- `apps/web/src/components/ReplayScreen.tsx`（新規）: Hand 一覧（開始時刻・Hero の札・収支、未完了は「未完了」）と再生画面（卓・進行ログ・Hero の札と Stack・その step の 1 行・Dealer Feedback・前へ / 再生 / 一時停止 / 次へ・何 step 目か）。卓・進行ログ・Chip の構成（#62）・Dealer Feedback（#66）・用語の詳細は卓の画面と同じ部品。
- `apps/web/src/App.tsx`: 見出しに「Replay を見る」/「卓に戻る」の切り替え。Replay を見ている間も卓の Session（SSE）はそのまま。`HeroFeedback` を `components/DealerFeedback.tsx` へ移した。
- `apps/web/src/styles.css`: Replay の一覧と操作欄。狭い画面でも 3 つの操作 Button が 1 行に並ぶよう、ラベルは日本語と英語の 2 段。

### Opponent Eval の取り直し（#63 の申し送り）

- `apps/server/src/testing/opponent-eval/spots.ts`: 旧 ID（`phase1_provisional_v0`）に固定していた `RECORDED_TABLE_CONFIG` を消し、本番と同じ `PHASE1_CASH_PRESET`（`phase4_provisional_v1`）で Spot を始める。
- `apps/server/src/testing/opponent-eval/recordings/opponent-eval.json`: 下記の実行の録画。

### docs・README

- `docs/03`（Event Store の `listHands`・Replay Service・API 表・web の Replay）、`docs/04` §9（Replay の実装。テーブル・Event は変えていない）、`docs/06` §10（Replay の画面）、`docs/09` §5（Spot の Rule Profile の扱い）。
- `README.md`（`release-readme-sync`）: 現在の状態・セットアップ（Chip 操作・Replay・Fast Forward の使い方）・現在のフェーズを Phase 4 の到達点に更新。Ruling は OI-008、額面は OI-004 の暫定値と明記。

## 判断理由

- **Replay の材料はサーバーで作る**: Hero に見えない Event（他者の Hole Cards・Deck・`system`）はサーバーの外へ出さない。web に Event を渡して Engine で畳み込む形にすると、ブラウザへ渡す Event の whitelist を別に持つことになる。`projectHeroView` の出力だけを返せば、Live と同じ情報境界（INV-INFO-001）に乗る。
- **step は Hero に見える Event 1 件ごと**（Action に決まった裁定だけまとめる）: 宣言・Chip の操作・裁定を「一手ずつ」見せるため、操作の Event もそれぞれ 1 step にした。裁定と Action は同じ追記の 1 つの出来事で、裁定だけの step では結果が欠けるので 1 step にした。
- **応答は step ごとの HeroView**（`log` を含む）: 1 Hand は数十 step で、ローカル単一ユーザーでは応答の大きさより、web が既存の部品（Table・HandLog・HeroFeedback）をそのまま使えることを優先した。
- **未完了の Hand も一覧に出す**: D88 の「`HAND_FINISHED` の無い Hand」は Replay で壊れないことが要件。収支は決まっていないので `null` にし、「未完了」と表示する。メモリにだけあるので再起動で消えることを一覧の説明文と README に書いた。
- **一覧の上限 100 件**は画面で選ぶのに足りる数の暫定値（ページングは作らない）。

## 手動の Eval（実際に Claude を呼んだ結果）

- 条件: 2026-10-06、`claude-haiku-4-5`（`opponent_fast`）、Agent SDK 0.3.289、claude.ai でログイン済み（`claude auth status` の `loggedIn: true`・`authMethod: claude.ai`）、`ANTHROPIC_API_KEY` は子プロセスの環境から外す（`buildClaudeEnv`）。`pnpm --filter @proj-poker/server eval:opponent --repeats 4 --concurrency 4 --record`（4 Spot × 6 Persona × 4 回 = 96 判断）。#53 と同じ条件。exit 0。
- 数値は `run.ts` の出力（集計 JSON）から転記した。

| 指標 | #53 の録画 | 今回の録画 |
|---|---|---|
| 判断 / 呼び出し | 96 / 96 | 96 / 96 |
| Structured Output Valid 率 | 1 | 1 |
| Illegal Action 率 | 0 | 0 |
| Retry 率 | 0 | 0 |
| Fallback 率 | 0 | 0 |
| 障害 | 0 | 0 |
| Hidden Information Leakage | 0 | 0 |
| Latency ms（min / median / p90 / max） | 6015 / 7668 / 9532 / 10578 | 4063 / 7907 / 9310 / 10005 |
| Persona Differentiation | 0.675 | 0.679 |

- 暫定の合格ラインには全部届いた（`run.ts` の出力「合格ライン: すべて届いた」）。録画の再生（`harness.test.ts`）は新しい録画で通る。
- 版の差（`phase1_provisional_v0` → `phase4_provisional_v1`）は Hero の Ruling だけで、CPU の局面・Legal Action は同じ。Prompt に入る `ruleProfile` の値だけが変わる。Persona ごとの最終 Action の分布は n=4 のばらつきの範囲で動いている（例: Nit の `preflop_facing_3bet` は #53 の call 3・raise 1 → 今回 fold 3・call 1）。Persona の差が良くなった・悪くなったとは言わない。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）: すべて exit 0。`pnpm test` は engine 232・web 108・server 176 件が通過（Claude は呼ばない）。
- 情報境界のテスト（`apps/server/src/routes/replay.test.ts`）: Hand API で実際に Hand を進め（seed 5 つ・3 回に 1 回不正な出力を返す CPU で `AI_ACTION_INVALID` の `system` Event を Log に残す）、一覧と再生のどの応答にも `forbiddenKeys`（Deck・seed・engine / system の記録）・`personaTerms`・CPU の不正な出力の値・エラー本文が無いこと、各 step に「その step の seq までに Hero が知ってよい札」以外が無いこと（`leakedCards`）を確かめる。CPU の札は `CARDS_TABLED` の step から見え、その前の step では `null`。最後の step は Live の `projectHeroView`（`legalActions` だけ `null`）と一致。宣言・Chip の操作・裁定の step、Action の決まらない裁定（`no_action`）の単独の step、Action に決まった裁定が Action と同じ step に入ることも確かめる。未完了の Hand（進行中・AI 障害の後に Session 終了で打ち切った Hand）でも同じ検査を通す。
- Store の契約（`event-store.test.ts`・`sqlite-event-store.test.ts`）: `listHands` の順序・`finishedAt: null`・`limit`、SQLite で保存済みとメモリの Hand を合わせること、開き直すと途中の Hand が消えること。
- 実機（Playwright・headless Chromium。リポジトリ外のスクリプト）: worktree で dev サーバー（`POKER_DB_PATH` は使い捨ての一時ファイル・`BOT_THINK_DELAY_MS=0`・RuleBot）を起動し、API で 1 Hand を物理的な操作（Chip を 1 で出す Call・宣言）で最後まで進め、2 Hand 目は開始だけ（未完了）にした。1280×900 と 375×760（モバイル・タッチ）で:
  - 一覧: 2 行（未完了の Hand は「未完了」、終わった Hand は「4♥ 3♦ −12（6 BB）」）。横スクロール 0（`scrollWidth − innerWidth = 0`）。
  - 再生: 1 / 27 step で「Hand 開始（ブラインド 1 / 2）」、CPU の表向きの札 0 枚。「次へ」12 回で 13 / 27、Hero 欄に Dealer Feedback（「プリフロップ（Preflop）の裁定: コール（Call） 2 として扱います。」と学習の札）。「前へ」で 12 / 27。「再生」で 2 秒後 14 / 27（約 900ms ごと）、「一時停止」で 1.5 秒待っても 14 / 27 のまま。最後の step（27 / 27）で「Hand 終了」・卓の中央に獲得額（「CPU 2 が ポット（Pot） 25 12.5 BB を獲得」）・Showdown で公開した CPU の札 2 枚が表向き。横スクロール 0。
  - 未完了の Hand: 6 / 6 step まで進み、卓の中央に「この Hand はここで止まっています（未完了）。」、見出しに「未完了」。
  - 375px で操作 Button（前へ / 再生 / 次へ）が 1 行に並ぶことをスクリーンショットで確認（最初の版は「次へ」が 2 行目に落ちたので、ラベルを 2 段にして直した）。
  - ページのエラー・コンソールのエラーは無し（1280px の初回だけ `/favicon.ico` の 404。既存で、この変更とは無関係）。
  - dev サーバーは確認後に停止した（3001 / 5173 の LISTEN が無いことを `ss -ltnp` で確認）。

## 残課題

- 未完了の Hand（メモリだけ）は再起動で一覧から消える。Hand の中断・再開の Event 化（D88）は Phase 5 の Session Resume で設計する。
- Learning-only Full Reveal・Jump to Important Spot は Phase 5 の Review（D93）。
- 一覧の上限（100 件）・再生の間隔（900ms）は暫定値。ページング・速さの切り替えは作っていない。
- 親 #2 の DoD（Logging / Persistence の Replay）の更新は親が行う。
