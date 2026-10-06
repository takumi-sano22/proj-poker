# Issue #67: BB 補助表示の切り替えと Hero Fold 後の Fast Forward

## 目的

- BB 補助表示を ON / OFF できるようにする（実額は常に表示。D49）。設定は viewer ごとの保存。
- Hero が Fold した後の観戦で Fast Forward を使えるようにする（D12・D15）。縮めるのは CPU の思考待ち（`BOT_THINK_DELAY_MS`）と演出だけで、Claude の応答時間そのものは縮めない。縮まると誤解させない（D93）。
- 観戦中も Hand が終わるまで Hidden Cards を見せない（docs/06 §8）。

## 変更内容

- server: `HandRuntime` に `fastForward` と `endThinkWait` を足し、`HandOrchestrator.setFastForward` / `fastForwardOf` を追加。入れられるのは Hero が Fold した後（または席が無い）の Hand の途中だけ（それ以外は `not_spectating`）。入れると残りの CPU の思考待ちを飛ばし、待っている最中の分も終える。`cpuTurn` の判断待ち（`ask`。Claude の応答）と `OPPONENT_TIMEOUT_MS` には触れない。`commit` が `HAND_FINISHED` を追記したら切る（次の Hand は通常の速さ）。
- server API: `POST /api/hands/:handId/fast-forward`（`{ enabled }` → `{ fastForward }`。409 `not_spectating`）。開始の応答に `fastForward` を足した（「卓に戻る」で状態を戻すため）。
- web: BB 補助表示は Context（`components/BbDisplay.tsx`）で `Amount`・宣言 Button・Poker Vocabulary の例へ渡す。保存は `lib/display-settings.ts`（`localStorage` を try/catch。使えなければ既定の「出す」）。Fast Forward は `components/FastForward.tsx`（Hero Fold 後だけ）、`useHandSession` に状態と送信（操作の送信とは別に二重送信を止める）。ON 中は `.app--fast-forward` で transition を止める。
- docs: `docs/03`（Orchestrator・API 表・hooks）、`docs/06`（§2・§8）を同期。

## 判断理由

- Fast Forward はサーバーのメモリの運用状態で、Event・スキーマは変えない（Emergency Bot の選択と同じ扱い。D88）。そのため人間判断（スキーマ変更）には当たらない。
- 「Claude の応答は縮まない」を表示で守るため、待ちの案内（「<CPU 名> の手番…」、遅延時は「AI応答が遅延しています」）は Fast Forward 中も変えず、操作の横に常時の説明文を置いた。Provider（RuleBot / Claude）を web は知らないので、Provider ごとの出し分けはしない。
- BB の ON / OFF は React Context で渡した（Amount が卓の全域で使われ、CSS だけの出し分けではテストで確かめられないため）。

## 変更ファイル

- server: `apps/server/src/hand-orchestrator.ts`・`routes/hands.ts`（と各 test）
- web: `src/App.tsx`・`components/{Amount,BbDisplay,ChipControls,FastForward,Vocabulary}.tsx`・`hooks/useHandSession.ts`・`lib/{api,display-settings,format,view-model,vocabulary}.ts`・`styles.css`（と各 test）
- docs: `docs/03_SYSTEM_ARCHITECTURE.md`・`docs/06_UI_UX.md`

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan）。
- server テスト: 思考待ちの短縮（待っている最中の分も含む）、Claude 相当の判断待ち（5 秒）が縮まないこと、判断待ちの上限が変わらないこと（timeout → 障害）、Hand 終了で切れて次 Hand が通常の速さ、`not_spectating`、観戦中の View に他者の札が無いこと（`leakedCards`）、REST の 200 / 400 / 404 / 409。
- web テスト: BB OFF で BB 換算が出ず実額が出る（Amount・Table・宣言 Button・用語の例）、設定の保存（読めない / 書けない Storage でも例外にしない）、`canFastForward`、観戦中の Table が全席裏向き。
- 実機: dev サーバー（worktree・`POKER_DB_PATH=:memory:`・`BOT_THINK_DELAY_MS=1500`・RuleBot）と Playwright（headless Chromium。リポジトリ外のスクリプト）で、BB 切り替え（ON → OFF で `.amount__bb` 9〜10 → 0、実額は残る、`localStorage` に保存）、Hero が Hand にいる間は Fast Forward が出ないこと、Fold 後に出て押すと Hand が約 0.2 秒で終わること（通常は 1 手 1.5 秒）、終了後は出ないことを確認。モバイル幅（390）で見出しの折り返しを直した。dev サーバーは確認後に停止した（3001 / 5173 の LISTEN が無いことを確認）。

## 残課題

- Claude Provider での実機確認（Fast Forward 中も判断待ちが縮まないこと）は未実施（認証が要る）。server の単体テストで、判断待ちを模した遅延 CPU で確認した。
- Fast Forward ON 中のスクリーンショットは、RuleBot では Hand が 0.2 秒で終わるため撮れていない。
