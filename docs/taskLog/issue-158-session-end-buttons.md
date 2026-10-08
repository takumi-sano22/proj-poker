# Issue #158: 1280×720 の卓で Session 終了後の「新しい Session を始める」が Hero の席に覆われて押せない

## 概要

広い画面（Playwright の Desktop Chrome の既定 1280×720）で、Session が終わった後の卓の中央の結果の欄に縦に並ぶ「この Session を振り返る」「新しい Session を始める」が、Hero の席に覆われて押せなかった（#144 の Phase 7 の Critical E2E は 1280×900 で動かして回避していた）。完了条件は次の 2 つ。

- 1280×720 で両 Button が席と重ならず押せる。
- `e2e/tests/opponent-memory.spec.ts` の画面の高さの指定（1280×900）を外しても通る。

## 初期調査

- 再現: `POKER_SEED=20261042`・既定の 6 人卓・Hero が Call / Check だけで打つと、4 Hand で Bust して Session が終わる。この状態の DOM の矩形を Playwright で測った（一時スクリプト。リポジトリには入れていない）。
- 修正前の 1280×720: 卓は幅 932 × 高さ 504（`.table` は `aspect-ratio: 16 / 10` だが `max-height: 70vh` で頭打ち）。卓の中央は Street・Board・Pot の下に結果の欄（獲得額 3 行・終わった理由・Button 2 つで 299×237）を縦に積むため、結果の欄が卓の下端の Hero の席（上端 y=505）まで伸び、2 つ目の Button（y=486〜530）の中央が Hero の席に覆われた。1280×900（卓の高さ 583）は席の上端が下がるので重ならない。
- 根: 広い画面の結果の欄は「Street・Board・Pot の下に載る」位置で、使える高さは卓の高さ（画面の高さ × 70% で頭打ち）で決まる。結果の欄に縦に Button を足すほど、画面の高さが低い所で席と重なる。1024×768（卓の幅が 676px で高さ 423）でも同じ重なりが出ていた（修正前に測定）。

## 設計方針

- 結果の欄を詰めるのではなく、**Session が終わった後の案内（理由と 2 つの Button）を、画面の幅によらず Hero の欄に置く**。卓の中央に残すのは獲得額の一覧だけ。Hero の欄は画面の下に固定で、高さが卓の高さに依らないので、画面の高さで重なりが変わらない。狭い画面（719px 以下）が #5 から同じ方針で、広い画面を合わせる形。
- 結果を Hero の欄にすべて移す案（獲得額の一覧も）は、1280×720 で Hero の欄が 198px になり、Hero の席の下半分を固定の欄が覆ったので採らなかった。獲得額の一覧は卓の中央に残すと、Hero の欄は通常の高さ（115px）で済む。
- 新しい人間判断は不要（`decision_log.yaml` の判断に反しない配置の修正。docs/06 §1・docs/03 の記述を同じ PR で更新）。

## 変更内容

- `apps/web/src/App.tsx`: `sessionEndInDock`（通常の卓で Session が終わっていれば、その状態を返す）を足し、広い画面でも Hero の欄に `SessionEnded`（`docked`）を出す。`TableCenter` は Session が終わったら獲得額の一覧だけを出す（`HandResult` の `awardsOnly`。障害で打ち切った Hand の後は何も出さない）。Drill の卓は変えない（`drill !== null`）。
- `apps/web/src/styles.css`: 広い画面で Hero の欄の行に並ぶ `.dock__done > .result--docked`（`flex: 1 1 360px`）。
- `e2e/support/play.ts`（新規）: Hand の終わり・Session の終わりまで Call / Check で進める手順（`opponent-memory.spec.ts` から移した）。
- `e2e/tests/session-end-layout.spec.ts`（新規）: 回帰の検査。
- `e2e/tests/opponent-memory.spec.ts`: 1280×900 の `test.use` と、その説明のコメントを外した。共通の手順は `support/play.ts` から読む。
- `docs/06_UI_UX.md` §1・`docs/03_SYSTEM_ARCHITECTURE.md`・`.claude/skills/ui-design-recipes/references/proj-poker.md`: Session の終わりの案内の置き場所と、測る画面の大きさに 1280×720 を追記。

## 回帰の検査（`session-end-layout.spec.ts`）

- 既定の 1280×720 で、`POKER_SEED=20261042` の Session を Hero の Bust まで Play する（Hand は開始の応答の handId で特定。終わった Hand が server の一覧で complete であることも確かめる）。
- 1280×720・1024×768 で、卓の中央の結果の欄・2 つの Button の矩形がどの席とも交差しないこと、Button の中心の `elementFromPoint` が Button 自身であること、横スクロールが無いことを確かめる。
- 通常の click（force なし）で「この Session を振り返る」→「卓に戻る」→「新しい Session を始める」と進み、新しい Session の Hand（別の handId）が始まる。
- 375×667・320×568: 結果の欄が卓の中央に出ず（`.table .result` が 0 個）Hero の欄に出ること、両 Button の中心が覆われないこと、横スクロールが無いこと、通常の click で押せること。
- 修正前のコード（`App.tsx`・`styles.css` を戻した状態）で新しい検査が失敗することを確かめた（1280×720 のテストが失敗。狭い画面のテストは修正前から通る＝配置を壊していないことの検査）。

## 実行した確認

- 修正後の 1280×720 の矩形: 卓 932×504、結果の欄（獲得額 3 行）y=365〜445、Hero の席の上端 y=505。Hero の欄は y=605〜720（高さ 115px）で、2 つの Button は y=655〜699（中心の hit-test はどちらも Button）。1024×768・1920×1080 でも交差なし。375×667・320×568 は修正前と矩形が同じ。
- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check` を通した。
- `pnpm e2e --repeat-each=10`（全 9 本 × 10 = 90 件。新しい検査 3 本を含む）を 3 回流した:
  - 1 回目: 90 passed（9.3m）
  - 2 回目: 90 passed（9.3m）
  - 3 回目: 90 passed（9.3m）
  - `opponent-memory.spec.ts` は画面の高さの指定なし（既定の 1280×720）で通っている。
- `pnpm lint` / `pnpm typecheck` / `pnpm test`（web 141・server 729）/ `pnpm format:check` はすべて通った。

## 残課題

- 720〜1023px 幅で高さが 600px 級の画面では、Hero の欄が折り返して高くなり、固定の欄が卓の下側を覆う（720×600 で、Session の終わりは 220px。Button は覆われない）。手番の途中も同じで、720×600 の Hero の手番では欄が 434px になる（実測）ので、Session の終わりの案内が増やした問題ではなく、この PR の範囲外（既存の Hero の欄の高さの挙動）。#158 の再現条件（1280×720）の外なので Issue は起こさない。
