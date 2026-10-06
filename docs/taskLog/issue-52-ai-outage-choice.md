# Issue #52: AI 障害時に Retry / Emergency Bot / Session 終了を選べるようにする

## 概要

Phase 3（AI Opponents）の子 Issue。CPU が判断を返せない「障害」（Claude の呼び出しエラー・タイムアウト・未ログイン・利用枠の上限。D86）で Hand をその手番で止め、Hero が卓の中央のダイアログで Retry / Emergency Bot で続行 / Session 終了 を選べるようにした。選ぶまでは止めたまま（Pause）。長く待つときは「AI応答が遅延しています」を補足する。Invalid Output は D41 の自動 Fallback のままで対象外。Event の形・`schema_version`・DB スキーマは変えていない。

## 初期調査

- 前提（main 76d64e0）: #47 の Orchestrator は障害を `rt.outage`（seq・Player・`timeout` / `error`・本文）に持ち、`outageOf` でだけ読めた（web へは返していなかった）。#48 で `AI_FALLBACK_USED` の `fallbackKind` に `emergency_bot` が用意済み（system Visibility）。#50 の `ClaudeOpponent` は未ログイン・利用枠の上限を `ClaudeOpponentError` で投げ、assistant message の `error`（`authentication_failed` / `rate_limit` 等）を本文に入れていた。#51 で Fallback 用の RuleBot にもその CPU の Persona を渡している。
- 障害の本文（`String(error)`）は SDK のエラー文で、資格情報のパスなどを含みうる。Hero へはそのまま出せない。
- Hero の View・SSE は `subscribe(handId, view => …)` で配っていた。障害は Log を進めないので、View の配信には乗らない。

## 変更内容

- `apps/server/src/opponents/opponent-agent.ts`: `OutageKind`（`timeout` / `unauthenticated` / `usage_limit` / `error`）と、種類を持つ例外 `OpponentOutageError` を追加。
- `apps/server/src/opponents/claude-opponent.ts`: `ClaudeOpponentError` を `OpponentOutageError` の派生にし、`outageKindOf` で assistant message の `error` を種類に分ける（`authentication_failed` / `oauth_org_not_allowed` / `verification_required` → 未ログイン、`billing_error` / `rate_limit` → 利用枠の上限、それ以外 → error）。
- `apps/server/src/hand-orchestrator.ts`:
  - `OutageStatus`（`{ revision, current: { playerId, kind } | null }`）を Hero 向けに作る `outageStatus` と、変化を配る `subscribeOutage` を追加。`revision` は障害が起きる・解けるたびに進む。
  - `resolveOutage(handId, revision, choice)`: 障害が無い・`revision` 違いは `stale_outage`。`retry` は障害を解いて同じ手番を進め直す。`emergency_bot` はその CPU を Session の Emergency Bot に登録し、以後その CPU の手番は CPU に求めず `AI_FALLBACK_USED`（`emergency_bot`）＋ RuleBot の Action を 1 回の追記で置く。`end_session` は Hand を打ち切り（`abandoned`）、`SessionStatus` を `ended`（`ai_outage`）にする。打ち切った Hand は開始の再送でも返さず、次は新しい Session。
  - Emergency Bot の登録は `SessionPointer.emergencyBots`（Map）に持ち、同じ Session の Hand は同じ Map を共有する。新しい Session では空から。
  - 自動 Fallback と Emergency Bot の記録・適用を `useFallback` にまとめた（記録の直後がその Action、の約束は同じ）。
- `apps/server/src/routes/hands.ts`: `POST /api/hands/:handId/outage`（`{ revision, choice }`。JSON Schema で検証）を追加。開始・Action・選択の応答に `outage` を足した。SSE に `event: outage` を足し、接続時と変化のたびに送る。`end_session` の後は `outage` の直後に `session`（`ai_outage`）を送る（Hand は途中なので閉じない）。
- `apps/web`:
  - `lib/api.ts`: `OutageKind` / `OutageStatus` / `OutageChoice`、`chooseOutage`、`SessionStatus` に `ai_outage`、エラー種別 `stale_outage`。
  - `lib/view-model.ts`: `parseOutageStatus`（受け側 whitelist。知っている項目だけで組み直す）、`selectOutageStatus`（revision の新しい方を残す）、`outageReasonText`（種類ごとの説明。API・モデル名は出さない）、`waitingMessage`。
  - `hooks/useHandSession.ts`: REST と SSE の両方から障害の状態を受ける。`resolveOutage(choice)` を足し、Action と同じ 2 層の二重送信防止・失敗時の再送（同じ revision を送る）に乗せた（共通部分を `submit` にまとめた）。
  - `hooks/useDelayed.ts`（新規）・`lib/config.ts`（新規。`AI_DELAY_NOTICE_MS` = 10000ms の暫定値）: CPU の同じ手番（Hand・最後の seq・Actor・障害の revision）が続いたら遅延を補足する。
  - `components/OutageDialog.tsx`（新規）と `App.tsx`: 卓の中央にダイアログ（止まった CPU の表示名・種類の説明・3 つの選択肢と補足）、Session 終了後の案内と「新しい Session を始める」、Hero の欄の待ち・一時停止の文言。`styles.css` にダイアログの面（既存の `.result` と同じトークン。狭い画面では卓の上端に寄せる）。
- テスト:
  - `hand-orchestrator.test.ts`: Hero 向けの障害の状態に本文・Persona が無い／種類の分かる例外／Retry（同じ入力で再要求・通れば続く・また障害なら同じ手番で止まる）／`stale_outage`（古い revision・障害なし・二重送信）／Emergency Bot（その CPU の Action すべてに `emergency_bot` の記録が直前に付く・次の Hand でも続く・その CPU には求めない・Hero の View に記録が入らない・Chip 総量）／Session 終了（打ち切り・新しい Session・均等 Stack）／Emergency Bot を新しい Session へ持ち越さない／障害の状態の配信。
  - `routes/hands.test.ts`: 応答・SSE に障害の状態が載り、エラー本文（資格情報のパスを模した文字列）・Persona・system の記録が無い／選択 API の 200・409・400・404／SSE の `outage` の順序と `ai_outage` の `session`。既存の「終わった Hand の SSE」の期待に、接続時の `outage` を足した。
  - `claude-opponent.test.ts`: 録画・構成済みの失敗から種類を分ける。
  - web: `parseOutageStatus` / `selectOutageStatus` / `parseSessionStatus`（`ai_outage`）/ `waitingMessage` / 説明文に API 名が無い、`OutageDialog` の描画。
- docs: docs/03 §1（API 表・`OutageStatus`・SSE・`SessionStatus`・web の受け方）・§3・§5・§6（実装）、docs/04 §3（`AI_FALLBACK_USED` の `emergency_bot`）、docs/11 OI-001（遅延表示の暫定値）、README（障害時の案内）。

## 判断理由

- **Hero に返すのは playerId・種類・revision だけ**: 本文は資格情報のパスやトークン断片を含みうる。種類は「ログインし直す」「枠が戻るまで待つ」を案内するのに要る分だけ分けた。本文は server のログ（`outageOf`）には残す。
- **revision を足した**: 障害は Log を進めないので View の seq では新旧を比べられない。また、Retry で同じ手番にまた障害が起きると seq も Player も同じになり、古いダイアログからの選択（特に Emergency Bot・Session 終了の二重送信）を区別できない。障害が起きる・解けるたびに進む番号にすると、REST と SSE の到着順の吸収と、選択の古さの判定を 1 つで扱える。
- **Emergency Bot の記録は手番ごと**: D86「Flag を残す」と docs/06 §12「Opponent Quality 分析で通常 Hand と混同しない」を満たすには、Emergency Bot が決めた Action ごとに分かる必要がある。自動 Fallback と同じく記録の直後にその Action を置く。`reason` にはきっかけの種類だけを入れ、本文は入れない（Event Log は DB に残るため）。
- **Emergency Bot の登録はメモリ**: Event Log から導くには Session の全 Hand を読む必要がある（その CPU に手番が来なかった Hand には記録が残らない）。再起動後の Resume は Phase 5 なので、今は Session のポインタに持ち、Resume 時に `AI_FALLBACK_USED`（`emergency_bot`）から戻す想定を docs/03 §6 に書いた。
- **Session 終了は Hand を打ち切る**: Event を足すと Event の形が変わる（停止条件）ので足さない。内部エラーで止まった Hand と同じく「持ち越す Stack が決まらない Hand」として扱い、次は新しい Session（均等 Stack）にする。打ち切った Hand の Pot の Chip は Session ごと捨てる（新しい Session の中で Chip 総量は保たれる）。
- **遅延表示の閾値 10 秒**: #50 の実測（中央値 約 7.2 秒・p90 約 8.6 秒）で、普段の待ちでは出さず p90 を超えたら出す値。障害として止める 30 秒より短い。暫定値として web の Config に置いた（OI-001）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 158・server 139・web 39 件すべて成功）/ `pnpm format:check`（ルート）。
- dev サーバー（worktree・`POKER_DB_PATH=:memory:`・`TABLE_SIZE=4`）と Playwright（headless Chromium）で実測:
  - `OPPONENT_PROVIDER=claude OPPONENT_TIMEOUT_MS=1`（必ず timeout になる設定）: 1280×800・375×760・375×667・320×568 でダイアログを表示。Retry で再び障害→ダイアログ、Emergency Bot で Hero の手番まで進む、別の CPU の障害で Session 終了→「AI の判断を受け取れなかったため…Session を終了しました。」と「新しい Session を始める」→新しい Hand。ダイアログの 3 ボタンが他の要素に隠れていないこと（`elementFromPoint`）、横スクロールが出ないこと（`scrollWidth` = 画面幅）を確認。Retry ボタンにフォーカスが移る。
  - 320×568 だけは、ダイアログの下端（「Session を終了」）が下に固定した Hero の欄に重なる。ページを縦にスクロールすれば押せる（卓の下に進行ログがあるため）。
  - `BOT_THINK_DELAY_MS=12000`（RuleBot）: 3 秒時点「CPU 1 の手番…」、11 秒時点「CPU 1 の手番…（AI応答が遅延しています）」、次の CPU の手番で補足が消える。
- dev サーバーは確認後に停止した。

## 残課題

- 320×568 のような低い画面では、ダイアログの下端が Hero の欄に重なる（スクロールで押せる）。卓 UI のデザイン体系（#5）で Hero の欄の高さと合わせて見直す候補。
- 再起動後の Resume（Phase 5）で、Emergency Bot の登録を Event Log から戻す。
- 遅延表示の閾値・判断待ちの上限は OI-001 の暫定値のまま。
