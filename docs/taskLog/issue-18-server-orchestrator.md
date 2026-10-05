# Issue #18: Server の Hand Orchestrator・暫定 CPU Bot・REST + SSE API

## 概要

`apps/server` に Hand Orchestrator・暫定 CPU（決定論ルール Bot。D71）・API（REST + SSE。D73）を置き、Hero 1 人 + CPU 5 人で 1 Hand を API 経由で最後まで進められるようにした。Event Log はメモリ内の Event Store に置く（SQLite は #20）。

## 設計方針

- **State は Event Log から毎回作る**（D37）: Orchestrator は Event Store から `foldHandEvents` で State を作り、別の State を持たない。Engine の `HandProgress.events` を Event Store へ追記するのは Orchestrator だけ。
- **合法性は Engine だけ**（D40）: Hero の入力も CPU の出力も `applyAction` で検証する。API の JSON Schema は「形」だけを見る（型の自動変換・余分な項目の黙った削除は Fastify の ajv 設定で無効化）。
- **情報境界**（D28・D71・D73）: CPU への入力は `OpponentInput { view: projectBotView(...), legal }` だけ（型の上でも global State・Deck を渡せない）。API の応答と SSE は `projectHeroView` の結果だけ。Hand の seed はサーバーだけが持ち、受け取らず返さない（Deck を推測させない）。
- **暫定 CPU は Domain の外の Adapter**: `OpponentAgent` Interface（`opponents/opponent-agent.ts`）と実装 `RuleBot`。手の強さを 3 段階で見積もり、seed 付き乱数で合法 Action から選ぶ。CPU の seed は Hand の seed から席ごとに導く（同じ seed・同じ Hero の Action なら同じ Event Log になる）。
- **Fallback**: CPU の出力が Engine に拒否される／例外を投げる → Check（できなければ Fold）。記録（seq・Player・理由）は Event Log ではなく Orchestrator の運用 Metadata に残し、warn ログを出す。Retry と `AI_FALLBACK_USED` Event は LLM の Opponent を入れるときに足す（決定論 Bot の Retry は同じ結果になるため）。
- **CPU の思考待ち**: `BOT_THINK_DELAY_MS`（既定 600ms・テストは 0）。0 なら同期でまとめて進める。待ちの間に Log が進んでいたら予約した手番を捨てる（遅延応答を適用しない）。アプリ終了時（`onClose`）に予約を取り消す。
- **二重送信の検出**: Hero の Action は `lastSeq`（client が見ていた `view.log` の最後の seq）を必須にした。Log がそこから進んでいれば `stale_view`（409）で拒否する。Hero に見える Event の seq だけで比べるので、見えない Event の存在は漏れない。
- **Event Store**: `append` / `read` の Interface とメモリ内実装。append-only で、seq が連続しない追記（二重追記・抜け）は何も書かずに拒否する。保存時に Event を複製して配下まで凍結し、呼び出し側の参照から書き換えられないようにする。`eventId`・`recordedAt` は保存側が付ける（docs/04 §3）。
- **SSE**: `event: view` + `data: HeroView`。接続時に現在の View、以後は Log が進むたびに送る。Hand が終わった View を送ったらサーバーが閉じる。`preClose` で開いている SSE を閉じる。
- **Engine を build せずに使う**: Engine の `exports` に条件 `@proj-poker/source`（→ `src/index.ts`）を 1 行足し、server の `tsconfig.json`（`customConditions`）・`vitest.config.mjs`（`ssr.resolve.conditions`）・`dev`（`tsx --conditions`）で指定した。CI は build せずに lint → typecheck → test を流すため（`dist` 参照のままだと型付き lint・typecheck・test が Engine を解決できない）。`build`（新設 `tsconfig.build.json`）と `start` は build 済みの `dist` を使う。Engine の公開 API は変えていない。

## テスト

- `hand-orchestrator.test.ts`: Hero の手番で止まる・1 Hand が終わる・Chip 総量不変／60 seed で Fallback なし（CPU は合法 Action だけ）かつ CPU の入力に見えない札・Deck・seed が無い（入力を丸ごと走査）／同じ seed で同じ Event Log／非合法出力・例外 → Safe Fallback と記録／`stale_view`（二重送信で Log が変わらない）／`hand_not_found`／思考待ちありで 1 手ずつ進み、その間の Hero の Action は `not_actor`／`close` 後は予約を実行しない／Hero が 1 人でない設定を拒否。
- `routes/hands.test.ts`（Fastify inject・SSE は実 listen + fetch）: 5 seed で API 経由で 1 Hand が終わり、どの応答にも漏れが無い（その時点の Hero が知り得る札以外の Card・`deck`・`seed`・`DECK_SHUFFLED`・`engine` を走査）／schema 不正 400・非合法額 422・`stale_view` 409・未知の Hand 404／SSE は Hero の View だけを順に Push し、終了でサーバーが閉じる・漏れが無い／終わった Hand の SSE は最後の View を 1 回送って閉じる。
- `rule-bot.test.ts`: 同じ seed で同じ判断列、200 局面で Action の種類・額が Legal の範囲内。`event-store.test.ts`: 追記・読み出し・seq の衝突の拒否（一部だけ書かない）・読み出しの写し。
- 漏れ検出の有効性: `heroView` に他者の `HOLE_CARD_DEALT` を混ぜる改変で REST・SSE の漏れテストが落ちることを確認してから戻した。
- 200 seed で CPU の Action 分布を確認（fold 601 / call 678 / check 932 / bet 284 / raise 145、Fallback 0）。

## 変更ファイル

- `apps/server/src/config.ts`・`event-store.ts`・`hand-orchestrator.ts`・`opponents/opponent-agent.ts`・`opponents/rule-bot.ts`・`routes/hands.ts`・`testing/leaks.ts`（新規）、`app.ts`・`index.ts`
- テスト: `apps/server/src/config.test.ts`・`event-store.test.ts`・`hand-orchestrator.test.ts`・`opponents/rule-bot.test.ts`・`routes/hands.test.ts`
- `apps/server/package.json`（`@proj-poker/engine`・`vitest` の追加、`test`・`dev`・`build` script）・`tsconfig.json`・`tsconfig.build.json`（新規）・`vitest.config.mjs`（新規）・`pnpm-lock.yaml`
- `packages/engine/package.json`（`exports` に `@proj-poker/source` 条件を 1 行）
- `docs/03_SYSTEM_ARCHITECTURE.md`・`docs/04_DATA_AND_EVENTS.md`（実装との同期）

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test`（Engine 109・Server 21 テスト）/ `pnpm format:check`（結果は PR の Test plan）。
- `pnpm build` → `node apps/server/dist/index.js` で `/api/health` と `POST /api/hands` を確認（`dist` にテストと `testing/` が出ないことも確認）。確認後にプロセスを止め、`dist` を削除した。
- `pnpm dev` 相当（server だけ・`BOT_THINK_DELAY_MS=300`・別ポート）で、CPU の行動が 1 手ずつ SSE で届き Hero の手番で止まることを `curl -N` で確認。確認後にプロセスを止めた。

## 残課題

- Session（Stack の持ち越し・Hand の連続）・永続化は #20 以降。Button は起動からの Hand 数で回しているだけ。
- Hand の Runtime 情報（listener・Fallback の記録）はメモリに溜まり続ける（ローカル単一ユーザーで 1 Session の規模なら問題にならない。永続化の Issue で Hand 終了後の扱いを決める）。
- 不均等 Stack（Side Pot）は Phase 2（D70）。現在は全 Hand 均等 Stack で始めるため `unsupported_state` は起きない（起きた場合、Hero の Action は 422、CPU は Fallback → それも拒否なら Hand の進行を止めて error ログ）。
- #19（Web）向け: SSE は `status === "complete"` を受けたら `EventSource.close()` する（サーバーが閉じた後の自動再接続を避ける）。Hero の Action には `lastSeq` が必須。
