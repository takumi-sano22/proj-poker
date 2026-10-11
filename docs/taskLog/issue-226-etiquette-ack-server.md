# Issue #226: UX-11 ETIQUETTE の確認（Ack）待ちで CPU を止める（server 側）

## 目的

D145（UX11-1〜5・T1=A）の server 側を実装する。ETIQUETTE の要る裁定の後、Hero が明示的に確認（Ack）するまで server が CPU の進行と次の Hand の開始を実際に止め、Ack の API と状態の配信（REST / SSE）を足す。#226 の人間承認（2026-10-11「server / client の 2PR 分離」）により、client 側（RULING → ETIQUETTE の Overlay・Ack の送信）は別 PR とする。

- PR #240 の検証テスト（「Ack を待たず CPU が進む」を成功条件に固定したもの）を、「Ack まで CPU が進まない」成功条件へ置き換える（skip・削除・無意味な緩和はしない）。
- Event / Event の版 / DB / Session Projection / Session Lifecycle は変えない。自動 Ack・要確認裁定のスキップ・Feature Flag・能力ネゴシエーションは入れない。

## 設計方針（D145 と承認済み設計資料 `issue-226-etiquette-ack-design.md` の §3〜§8 どおり）

- **Ack の要否（B1）**: Engine に純粋関数 `packages/engine/src/etiquette.ts` を置く（`ETIQUETTE_ACK_CODES`・`requiresEtiquetteAck(notes)`・`etiquetteAckRulingSeqs(events, viewerId)`）。Hero に見える Event（`visibleEvents`）の Hero への `DEALER_RULING` で、notes に 7 種のいずれかがあるものの seq。裁定・合法 Action・状態遷移には触れない。
- **確認の位置**: `HandRuntime.ackedThroughSeq`（初期 -1）と `etiquetteRevision`・`etiquetteListeners` だけをメモリに持つ。待っている裁定（`pendingRulingSeq`）は毎回 Event Log から導く（最も新しい Ack の要る裁定の seq が確認位置より後なら待ち）。
- **停止点（B2）**: `canRun` に「待ちが無い」を足す。`runCpuTurns` のループの先頭・`cpuTurn` の `isCurrent` の両方で効くので、思考待ち・判断・Emergency Bot（RuleBot）・Fast Forward・Drill が同じ経路で止まり、待ちの間に返った判断は適用しない。拘束の裁定（Hero の要求の外で `resolveHeroOutOfTurn` が置く）もループの先頭に戻って止まる。
- **古くなった判断の打ち切り**: `commit` が Ack の要る裁定を追記したら `rt.cancelWait` を呼び、待っていた思考待ち・判断（Hero の手番外の操作で古くなったもの）を打ち切る（設計資料 §4 の「人間判断の要らない実装の詳細」）。打ち切らないと、Ack の後の再開が古い判断の返り（または Timeout）まで遅れ、捨てる推論の費用も残る。
- **Ack（B3）**: `acknowledgeEtiquette(handId, rulingSeq)`。(1) 待っている seq → 確認位置を進めて（await より前）revision を上げ、`running` の後始末を待ってから `proceed`（resolveOutage と同じ形）。(2) 確認済みの Ack の要る seq → 何もせず 200。(3) それ以外 → `stale_etiquette`。同時の 2 本目は (2) になり、進行は `advance` が 1 本に保つので再開は 1 回だけ。
- **拒否**: 待ちの間の `heroAction` / `heroPhysicalAction` は `etiquette_ack_required`（stale_view より先に判定。Log を変えない）。`heroUserRead` は既存の条件のまま。
- **次の Hand（B4）**: `startHand` で、Hand を返すだけの再要求（`unseenLatestHand`）を先に返し、その後で今の Session の最後の Hand に待ちが残っていれば `etiquette_ack_required`。このプロセスに無い Hand（Resume）は待ちを持たない（D62）。
- **配信**: REST の応答（hands・actions・physical-actions・outage・etiquette-ack。drills の開始も同じ形）に `etiquette: {revision, pendingRulingSeq}`。SSE は接続時に `outage` → `etiquette` → view、変化時に `etiquette`。待ちを立てる裁定は `commit` が View より先に `etiquette` を配るので、Hand を終える裁定でも SSE が閉じる前に届く。
- **Tournament（T1=A）**: プレイ時間の計算（`playFinishedAt`・`handPlayTimeMs`・`elapsedPlayMs`）は変えない。Hand の進行中の待ちは時計が進むので入り、`HAND_FINISHED` の後の待ちは入らない（テストで確認）。

## 変更内容

- Engine: `etiquette.ts`（新規）と `index.ts` の export。
- server: `hand-orchestrator.ts`（`OrchestratorError` に `stale_etiquette` / `etiquette_ack_required`、`EtiquetteAckStatus`、`HandRuntime` の 3 項目、`acknowledgeEtiquette`・`etiquetteStatus`・`subscribeEtiquette`、`canRun`・`commit`・`startHand`・`heroAction`・`heroPhysicalAction`・`close`）。`routes/hands.ts`（`POST /api/hands/:handId/etiquette-ack`、応答の `etiquette`、SSE の `etiquette` イベント、409 の写像）。`routes/drills.ts`（409 の写像と応答の `etiquette`）。
- テスト: `etiquette-ack-verification.test.ts` を「Ack まで CPU が進まない」成功条件の結合テスト 13 件へ置き換え（下記）。`routes/etiquette-ack.test.ts`（新規 5 件）。`engine/src/etiquette.test.ts`（新規 4 件）。`routes/drills.test.ts`（Drill の Ack 1 件追加）。既存の 4 件は Ack の手順を足して期待を合わせた（`hand-orchestrator.test.ts` の Out-of-Turn 2 件、`routes/replay.test.ts` の裁定の再生 1 件、`routes/hands.test.ts` の SSE の順序 1 件）。
- docs: `docs/03_SYSTEM_ARCHITECTURE.md`（§1 の API の表の応答・失敗・新しい行・SSE、Orchestrator の説明、横断 UI/UX の段落の実装状況）。`docs/04`・`docs/02` は D145 の正本化どおりで変更なし。`docs/06` は触らない。

### PR #240 の検証テストの置き換え（旧 → 新の成功条件）

| 旧（Ack を待たず進むことを固定） | 新 |
|---|---|
| 手番の Oversized Chip: 同じ要求の中で次の CPU に判断を求める | Ack まで判断を求めず CPU の Action も無い。Ack の後に再開して最後まで進み Chip 総量が保存される（botDelayMs 0 と > 0 の 2 件） |
| Out-of-Turn: 保留の裁定の後も CPU が進み、拘束の裁定の後も進む | 保留の裁定で止まり（待っていた判断は abort・遅れて返っても適用しない）、Ack → CPU 3 手 → 拘束（+ Oversized Chip）で再び止まり、Ack で進む |
| Timeout 前の Out-of-Turn で遅れた障害は捨てられる | 障害は立たず、Ack まで判断を求めず、Ack の後の cpu3 の Preflop の Action は 1 回だけ |
| 障害の間の Out-of-Turn の後、Retry すると Ack を待たず進む | Retry / Emergency Bot でも Ack まで進まない・先に Ack しても障害の選択まで進まない・Session 終了でも待ちが残り次の Hand を 409（4 件） |
| Hand を終える裁定は同じ追記に HAND_FINISHED を含む（Store が終わった Hand への追記を拒否） | 同じ追記で終わるが待ちは残り、次の Hand の開始は 409・Hand を返すだけの再要求は受ける・終わった Hand への操作も 409・Ack は lastSeq を変えない |
| （追加） | 同時の 2 つの Ack で再開は 1 回、Ack の判定（stale / 冪等 / 404 / 新しい待ちを解かない / stale_view 維持 / User Read 受理）、Fast Forward、Tournament T1=A |

## 判断理由

- 停止を `canRun` 1 箇所に置いたのは、設計資料 §3 のとおり Hero の要求の外で出る拘束の裁定・遅れて届く判断・障害の後の再開のすべてを同じ条件で止められるため（個別の経路に分岐を足さない）。
- 待ちを Event Log から毎回導くのは、D145 の「Ack が要るかは Event Log から導き、メモリに持つのは確認した位置だけ」に合わせるため（キャッシュを持つと Event と食い違う余地ができる）。
- Drill の開始（`POST /api/drills`）は待ちで拒否しない。D145 が拒否を定めるのは `POST /api/hands` で、Drill は専用の Session（今の Session を変えない）のため。

## 実行した確認

- `pnpm lint`: 0 error
- `pnpm typecheck`: 成功
- `pnpm test`: engine 493 passed / web 188 passed / server 940 passed
- `pnpm format:check`: 成功
- 変異の確認: `canRun` の Ack の条件を一時的に外すと、`etiquette-ack-verification.test.ts` の 13 件中 8 件が失敗することを確かめた（元に戻した）。
- E2E（`pnpm e2e`）は手元では実行していない（#218 の Worker が同じ E2E のポート 3101 / 5174 を使用中のため）。CI の e2e ジョブで確認する。

## 残課題

- **現行 UI との非互換**: 今の Web は Ack を送れないので、ETIQUETTE の裁定（例: 宣言なしの Oversized Chip・手番外の操作）が出ると CPU が止まり、Hero の操作は 409 `etiquette_ack_required`（client は未知の失敗として扱う）、Hand が終わっても次の Hand は 409 になる。client PR との統合までマージを保留する（PR の Risk）。
- client PR で扱うこと: RULING → ETIQUETTE の Overlay と Ack の送信、409 `etiquette_ack_required` / `stale_etiquette` の扱い、REST・SSE の `etiquette` の受け取り、`dealer-feedback.ts` の ETIQUETTE の表を Engine の `ETIQUETTE_ACK_CODES` に型で縛ること（今回は apps/web を触らない）、Web の `etiquette-ack-verification.test.ts` の扱い。
- `HAND_ABORTED` の Hand は `POST /api/hands` で返す対象にならない（既存）ので、再読み込みの後の復元は SSE の接続時の `etiquette`（または `outage` の応答）から行う。client PR で経路を確認する。
- `GET /api/session/current`（D144）は変えていない。Hand が終わって Ack が残っていると `ready_for_next_hand` を返すが、開始は 409 になる。Home での扱いは UX-03 / client PR、Session の終了・一時中断の予約との関係は #230 で再確認する（D145 の記載どおり）。
