# Issue #226: UX-11 ETIQUETTE の確認（Ack）の client 側（RULING → ETIQUETTE の欄・Ack の送信・表示の停止）

## 目的

D142・D145 に従い、server（#226 の server PR #244）が ETIQUETTE の確認まで CPU と次の Hand の開始を止める契約に対して、client 側で
RULING → ETIQUETTE の欄を出し、Hero の明示の確認で Ack を送り、server の応答の状態に従って表示と進行を再開する。
人間の方針（#226 issuecomment-6106076286）どおり server / client の 2 PR に分け、統合して検証してから server → client の順に続けてマージする。

## 変更内容

1. **Presentation Controller の P1 の修正（`apps/web/src/lib/presentation.ts`）**: `receive()` → `bound()`（表示待ちの上限 24 step の切り詰め）と、
   最初の Hand の受信（`handId === null` で最新に合わせる）が `holdThroughSeq` を見ておらず、Ack を待つ裁定より先（Board・Showdown・Pot の配分）まで
   表示を進め得た。`receive` に `holdThroughSeq` を渡し、受信のすべての経路（最初の Hand・続く Hand・同じ Hand の切り詰め）で hold の step より先を
   表示済みにしない（`heldSeq`）。ChatGPT の独立監査（#226 issuecomment-6109333730）の P1 候補を、修正前に失敗する再現テストで確認した。
2. **Ack の状態と API（`lib/api.ts`・`lib/view-model.ts`）**: `EtiquetteAckStatus`、`acknowledgeEtiquette`（`POST /api/hands/:handId/etiquette-ack`）、
   `stale_etiquette` / `etiquette_ack_required` の種類、whitelist の `parseEtiquetteStatus` / `parseEtiquetteEvent`、`selectEtiquetteStatus`
   （今の Hand の新しい revision だけを残す。OutageStatus と同じ選び方）。
3. **useHandSession**: REST（開始・Action・障害・Ack・Drill）と SSE `etiquette` から状態を受け、`holdThroughSeq` に待っている裁定の seq を渡す。
   `acknowledgeEtiquette` は出している ETIQUETTE の裁定だけを送る（二重送信は送信中の ref と state で止める）。待ちの間の `operate` は送らない。
   `etiquette_ack_required` は専用の案内と状態の読み直し（SSE を張り直す）、`stale_etiquette` は読み直しと案内。どちらも自動で確認・再送しない。
4. **RULING → ETIQUETTE（`lib/dealer-overlay.ts`・`hooks/useDealerOverlay.ts`・`components/DealerOverlay.tsx`）**: 理由（notes）のある Hero への裁定は
   RULING を `RULING_OVERLAY_MS`（2,500ms。OI-012 の暫定値）出して自動で閉じ、確認待ちの裁定なら ETIQUETTE を「確認しました」まで出す。
   障害のダイアログの間は出さない。読み込みの直後は前に見た裁定を出し直さないが、確認待ちの裁定は RULING → ETIQUETTE で出し直す。
   状態は `useHandSession` の層（画面の切り替えより上）に持つので、Home / Learn から戻っても出し直す。COACHING は出さない。
5. **開始の流れ（`lib/start-flow.ts`）**: #245 の 2 段階の開始（`isUnseenEndedHand`）で、1 回目の終わった Hand が確認待ちなら 2 回目を送らずその Hand を開き、
   2 回目が 409 `etiquette_ack_required` なら 1 回目の応答の Hand と確認の状態を開いて確認を求める（自動 Ack・無条件の再送・終わった Hand の破棄をしない）。
6. **置き場所**: 欄は画面の幅に依らず Hero の欄の操作の場所に出し、その間は手番の Feedback・案内・操作の欄を外さずに隠す（`hidden`。下書きは残る。D146）。
   最初は広い画面で卓の中央の流れに置いたが、E2E で 720×600 の Board の押し上げ（席と重なる）と、固定の Hero の欄の裏に「確認しました」が隠れる
   （1280×720 でも表示の直後）こと、320×568 で Hero の欄が画面より高くなることが分かり、置き場所を変えた。
7. docs: `docs/03`（Presentation Controller の節。#244 と同じ横断 UI/UX の段落は変えない）・`docs/06`（§6・§16.4・§16.5・§16.8）・`docs/11`（OI-012 の暫定値）。

## 変更ファイル

- `apps/web/src/lib/{presentation,api,view-model,config,dealer-overlay,start-flow}.ts`、`hooks/{useHandSession,useDealerOverlay}.ts`、
  `components/DealerOverlay.tsx`、`App.tsx`、`styles.css`
- テスト: `lib/presentation.test.ts`（再現 7 件）・`lib/view-model.test.ts`・`lib/dealer-overlay.test.ts`・`lib/start-flow.test.ts`・
  `components/components.test.tsx`、E2E `e2e/tests/etiquette-ack.spec.ts`（新規 8 件）・`e2e/tests/table-layout.spec.ts`・`e2e/support/etiquette.ts`
- docs: `docs/03`・`docs/06`・`docs/11`・本ログ

## 判断理由

- **再接続・読み込みの直後も hold を優先**: D140 は「再接続では最新に合わせる」だが、D142・D145 の「確認までその先を見せない」順序を守るため、
  確認待ちの間は最新ではなく裁定の step までに合わせる（`holdThroughSeq` の既存の意味「Skip・同期も越えない」と同じ）。
- **RULING を出す裁定**: 毎回の Hero の操作が裁定（notes なし）を 1 つ足すので、理由のある裁定だけにした（通常の Action に欄を出さない）。
- **置き場所の変更**: Issue の WHAT は「RULING は中央 Overlay」だが、同じ Issue の「狭い画面でも Hero 欄に隠れず卓の公開状況が読める」と
  #163 / #179 の配置の不変条件を満たせなかったため、Hero の欄にした（可逆。卓の中央に出す案は #224 の視覚演出と合わせて再検討できる）。
- **Feature Flag・自動 Ack は入れない**（人間判断 (a)。D145 不変）。

## 実行した確認

- `pnpm --filter @proj-poker/web test`: 276 passed（presentation の再現テストは修正前に 5 件失敗することを確認）
- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`
- E2E は server を含む統合ブランチ（main + #244 + 本 PR）で実行（結果は PR に記録）。本 PR 単独の CI の e2e は、server が Ack を返さないため
  ETIQUETTE の E2E が失敗する想定（統合の成功とはみなさない）。

## 残課題

- HAND_ABORTED と CPU の障害（Outage）の E2E は未実施: E2E で障害を起こす手段が無い（RuleBot は失敗しない・実モデルの呼び出しは禁止・
  server に障害注入を足さない）。server の結合テスト（#244 の `etiquette-ack-verification.test.ts` の Outage / Retry / Emergency Bot / Session 終了）と、
  client の単体テスト（障害の優先 `flush` と hold の同時・`outageActive` で欄を出さない）で代替。
- SSE の切断の E2E は、`context.setOffline` で既存の接続が切れないため、ブラウザと Vite の間に TCP の中継を置いて HTTP の接続だけを切る方法にした。
- RULING の欄を卓の中央に出すかは、#224（視覚演出）で再検討できる（今は Hero の欄）。
- #219 の下書きの層・再確認 UI は本 Issue に含めない。#230 の Pause / End 予約の設計 Gate は未解除のまま。
