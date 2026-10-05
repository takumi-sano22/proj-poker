# Issue #35: Session（Stack 持ち越し・Bust 時の退席・Session 終了）

## 概要

Server の Hand Orchestrator に Session を持たせ、Hand 間で Stack を持ち越すようにした。2 Hand 目以降の席と Button は、前 Hand の `HAND_STARTED`（席順・`buttonPlayerId`）と `HAND_FINISHED`（`stacks`）から Engine の `nextHandSeating`（#34）で決める。Bust した CPU は退席し、Hero の Bust か、残りが Hero だけになったら Session を終える（D80）。Web に Session 終了の表示と、新しい Session を始める導線を足した。永続化スキーマと Event の形（`HandEvent`・`schema_version`）は変えていない。

## 設計方針

- **第 2 の State を持たない（D37）**: Orchestrator が持つのは「今の Session の ID と最後の Hand の ID」だけ。Stack・席・Button は毎回、最後の Hand の Event Log から作る。
- **最初の Hand**: 均等 Stack（`startingStack`）・Button は席順の先頭（Hero）。従来の最初の Hand と同じ。
- **Session の終了（D80）**: Hero の Stack が 0 なら `hero_busted`（CPU が何人残っていても）。Hero の Stack が残っていて `no_next_hand` なら `hero_last_standing`。
- **Session 終了後に新しい Hand を求められたら**: 明示エラーにせず、新しい Session として均等 Stack で始める（Web の「新しい Session を始める」はこの `POST /api/hands`）。
- **前 Hand が未完了のまま新しい Hand を求められたら**: 今の Session の最後の Hand が進行中なら、新しく作らずその Hand を返す（`POST /api/hands` は 200）。当初は「新しい Session として均等 Stack で始める」にしていたが、Codex の指摘（P1: 開始の応答だけが失われて Web が再送すると Session と持ち越した Stack が捨てられる）で開始を冪等にした。最後の Hand が内部エラーで止まっている場合だけ、新しい Session として均等 Stack で始める（復旧の手段を残す）。Web の接続断の案内は「卓に戻る」にした（進行中の Hand があればその続き、無ければ新しい Session）。
- **Session の状態の返し方**: Hand ごとに `SessionStatus`（`in_hand` / `ready_for_next_hand` / `ended` + `reason`）を `POST /api/hands`・`POST .../actions` の応答に入れ、SSE では `complete` の View の直前に `event: session` を 1 回送る（Web は complete の View で SSE を閉じるため先に送る）。Hero に返すのは Hero 自身の結果と次 Hand の有無だけ（D28・D73）。Bust や Session 終了の判定は Web でしない。
- **SQLite の Session**: `EventStore.append` に任意の `AppendContext { sessionId }` を足し、Hand の最初の追記の値で `hands.session_id` を書く。`sessions.started_at` はその Session の最初に保存した Hand の開始時刻。テーブル・列・Trigger は変えていない。従来の「起動ごとに 1 Session」は Orchestrator の Session 単位になった。
- **CPU の seed**: 卓の設定上の席番号から導く（Bust で席が詰まっても同じ CPU に同じ導き方）。

## テスト

- Orchestrator: 2・6・8 人卓で Session を最大 30 Hand 回し、各 Hand の開始時に Chip 総量が不変・前 Hand の Stack をそのまま持ち越し Stack 0 の席だけが抜ける（席順は保つ）・同じ Session ID・CPU の Fallback なし、どこかで Bust が起きていること。3 人卓で CPU が Bust → 次 Hand は Hero と cpu2 の Heads-Up・Button = cpu2 = SB・Stack 持ち越し・同じ Session。Hero の Bust で `ended/hero_busted`、次の Hand は新しい Session（均等 Stack・Button = Hero）。CPU 全員の Bust で `ended/hero_last_standing`。進行中の Hand があるときの開始は同じ Hand を返し Event を増やさない（Heads-Up の 2 Hand 目・6 人卓の 1 Hand 目）。最後の Hand が内部エラーで止まっていたら新しい Session（均等 Stack）。
- API: 進行中の Hand があるときの `POST /api/hands` は同じ Hand を 200 で返す。応答の `session` が View と食い違わない（途中は `in_hand`、終了後は `ready_for_next_hand` か `ended`）。SSE は `session` を complete の View の直前に 1 回だけ送り、漏れ検査を通る。
- SQLite: Hand の最初の追記の Session ID で `hands.session_id` を書き、`sessions` の行は Session ごとに 1 回（最初の Hand の開始時刻）。
- Web: `selectSessionStatus`（Hand 終了後の状態を遅れた `in_hand` で戻さない・別 Hand は捨てる）、`parseSessionStatus`（whitelist）。

## 実機確認（Playwright・dev サーバー）

`TABLE_SIZE=3`・`POKER_DB_PATH=:memory:`・`BOT_THINK_DELAY_MS=50` で起動し、PC（1280）とスマホ（390）で Hero が All-in / Call を続ける操作を Session 終了まで自動で回した。2 Hand 目に持ち越した実額の Stack（例: 402）が出ること、CPU の Bust 後に 2 席（Heads-Up）になること、Session 終了で理由（Bust／勝ち残り）と「新しい Session を始める」だけが出て「次の Hand へ」が出ないこと、新しい Session で均等 Stack（200）に戻ること、横スクロールが無いことを確認した。dev サーバーは確認後に止めた。

## 変更ファイル

- `apps/server/src/hand-orchestrator.ts`・`hand-orchestrator.test.ts`・`event-store.ts`・`sqlite-event-store.ts`・`sqlite-event-store.test.ts`・`routes/hands.ts`・`routes/hands.test.ts`・`config.ts`（コメント）
- `apps/web/src/App.tsx`・`hooks/useHandSession.ts`・`lib/api.ts`・`lib/view-model.ts`・`lib/view-model.test.ts`・`styles.css`
- `docs/03_SYSTEM_ARCHITECTURE.md`（Orchestrator の Session・API 表・Web）・`docs/04_DATA_AND_EVENTS.md`（§10 の Session の保存）

## 残課題

- 再起動後の Session の再開（Resume）は Phase 5 の範囲（本 Issue の範囲外）。再起動すると新しい Session から始まる。
- Session の終了を表す Event・Session Projection・Memory Update の保存は未実装（Event 種別を足すには人間判断が要る）。
- 古いタブなど、最後の Hand 以外の Hand から「次の Hand へ」を押した場合も、今の Session の最後の Hand から続く（単一タブの通常経路では起きない）。
