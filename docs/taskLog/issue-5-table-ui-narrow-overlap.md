# Issue #5（一部）: 卓 UI の狭い画面（375px・320px）での重なりを直す

## 概要

#5（`ui-design-recipes` skill を卓 UI 向けに改良する）のうち、作業ログに残っていた「狭い画面の配置の課題」だけを別 PR で直した（skill の改良そのものは別 PR。この PR は `Refs #5`）。対象は次の 2 件と、同じ根（狭い画面の配置）の課題。

1. `issue-84-review-ui.md`: 375px で卓の中央の結果の欄（獲得額の一覧と「次の Hand へ」）が席と重なる。
2. `issue-66-dealer-feedback-vocabulary.md`: 375px で裁定があるとき Hero 欄が約 106px 高くなる（RULING の文 4 行＋用語・補足の button 2 行）。

same-root sweep（`docs/taskLog/` の「残課題」を 375 / 320 / 狭い で全文検索）で、次も同じ根と判断して直した。

- `issue-52-ai-outage-choice.md`・`issue-65-chip-interaction-ui.md`: 320×568 で CPU 障害のダイアログの下端が Hero の欄に重なる／320px で Hero 欄が高い。
- 実測で新たに見つかったもの: 375px の卓の中の重なり（Board・Street・Bet・Pot と席、Hero の席と進行ログ）、Replay の Jump の Button と「この判断の Review を見る」の重なり。

## 初期調査

- 前提: main fbef522。web は Tailwind ではなく `apps/web/src/styles.css`（`:root` のトークンと素の CSS）。卓は `components/Table.tsx`、席と Bet は向き（`--dir-x` / `--dir-y`）だけ JS で渡し、半径（`--seat-rx` など）は CSS で決める。狭い画面の境界は 719px（`@media (max-width: 719px)`）に統一されている。
- 実測の方法（Playwright 1.63・headless Chromium。リポジトリ外の一時スクリプト）: worktree の server（`TABLE_SIZE=6`・RuleBot・`REVIEW_PROVIDER=fake`・`BOT_THINK_DELAY_MS=0`、裁定の測定だけ 2500）と Vite を別ポートで起動し、1280×900・375×760・375×667・320×568（375 / 320 は `hasTouch` / `isMobile`）で Hero の手番・裁定・Hand の終了を測った。席の面・席の札・Bet・Board（札の外接矩形）・Pot・Street・結果・進行ログの矩形の交差、`elementFromPoint` で操作 Button の中心が自分か、`scrollWidth − innerWidth`、Hero 欄の高さ、Hero 欄が覆う卓の高さ。
- 修正前（main）の実測: 375×760 の Hand の終了で、結果の欄が席・席の札と重なる（`seat×result` 71×60 / 52×52・`cards×result` 39×34）うえ、Board が上段の席と重なる（28×48・41×48）。320×568 では「次の Hand へ」の中心が Hero の席に覆われ、クリックが席に遮られる（`notHit`）。卓の中でも、Hero の手番で Bet と Street / Pot / 席（`bet×street` 44×17 など）、Hero の席と進行ログ（`seat×handlog` 82×4）が重なる。10 Hand の通しでは、重なりの組が 375×760 で 10 種・375×667 で 9 種・320×568 で 13 種、1280×900 は 0 種。
- 根: 卓の中央に Board・Street・Pot に加えて結果の欄を重ねていて、縦長の卓の中央の帯（上段と下段の席の間。375px で約 106px）に入らない。Hero 欄は手番の案内・Chip の操作・宣言が縦に積まれ、裁定が加わると卓の下側をほぼ覆う。

## 設計方針

- 狭い画面（719px 以下）では、卓の席と重なる欄（Hand の結果・Session 終了の案内・CPU 障害のダイアログ）を卓の中央ではなく、画面下に固定した Hero の欄へ置く。#84 で Review の Button を Hero の欄へ移したのと同じ方針。広い画面は従来どおり卓の中央（1280px の見た目は変えない）。
  - 同じ内容を 2 か所に描かない（読み上げが二重になる）ので、CSS で出し分けず、`useNarrowScreen`（`matchMedia`）で 1 か所に決める。境界はテストで `styles.css` の `@media` と同じ値に固定する。
- 卓の中央の帯を空けて、席・Bet と重ならないようにする（狭い画面だけ）。
  - 卓を縦長にする（幅:高さ 4:5 → 3:4。幅 359px 以下は 5:7）。Board の札は 28px（359px 以下は 20px）、Board を 1 行目、Street と Pot を 2 行目に並べ、Pot は名前と額を 1 行にする。4 人・8 人卓は真横に席が来て中央の幅が狭いので、Street / Board / Pot を縦に積む。
  - Bet の札は実額だけにして（BB 換算は補助。D49）席の面の内側に置く。Hero の席が下に出る分の余白を足す。
- Hero 欄を低くする（狭い画面だけ）: 手番などの 1 行の案内を Hero の札・Stack の右に並べる（`.dock__controls` を `display: contents` にして dock の grid に直接置く）。Betting Area の名前と案内は 11px で 2 行に収める。
- 既存の部品とトークンを使う（新しい意匠・色は足していない）。結果は既存の `.result` と `.btn`、障害のダイアログは既存の `.outage`。

## 変更内容

- `apps/web/src/hooks/useNarrowScreen.ts`（新規）: 719px 以下かを返す。`matchMedia` が無い環境（サーバー描画・テスト）は広い画面。
- `apps/web/src/App.tsx`: 狭い画面では `Table` の `center` を空にし、`HeroDock` / `DockBody` に結果（`HandResult`）・Session 終了の案内（`SessionEnded`。卓の中央の分も共通化）・障害のダイアログを出す。結果の Button は「次の Hand へ」と「この Hand の Review」を同じ行に並べる。
- `apps/web/src/components/OutageDialog.tsx`: `docked`（Hero の欄に出すとき `outage--docked`）。
- `apps/web/src/styles.css`: 狭い画面の卓（縦横比・中央の並び・Pot・Bet・席の間隔・359px 以下の詰め方）、`.result--docked`、`.outage--docked`、Hero 欄の grid、Betting Area の文字、`.spot-jump`（Replay の Jump の行を縮めない）。
- `apps/web/src/components/components.test.tsx`: `useNarrowScreen` の既定（広い画面）と、境界が `styles.css` の `@media` と同じ値であること、`OutageDialog` の `docked`。
- `e2e/tests/session.spec.ts`: 375×667（タッチ）で、結果が卓の中央ではなく Hero の欄に出ること、横スクロールが無いこと、「この Hand の Review」と「次の Hand へ」が押せること（Playwright の click は押す位置に別の要素があると失敗する）。
- `docs/06_UI_UX.md` §1・§12、`docs/03_SYSTEM_ARCHITECTURE.md`: 狭い画面の置き方を追記。

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine・server 445・web 120 件すべて成功）/ `pnpm format:check` / `pnpm e2e`（2 件成功。375px の新しいテストを含む）。
- 実測の結果（6 人卓。修正前 → 修正後。Hero 欄が覆う卓の高さはスクロールの先頭での値で、末尾までスクロールすると 0）:
  - **1 Hand の測定（seed 20261006）**
    - 375×760・Hand の終了: 重なり 5 組（`seat×result` ほか）→ 0 組。Hero 欄 164 → 193px（結果の欄を含む）。
    - 375×760・Hero の手番: Hero 欄 388 → 325px、重なり 7 組 → 0 組。
    - 375×760・裁定あり（Oversized Chip）: Hero 欄 494 → 431px（裁定なしの手番との差は +106px のまま。裁定の文は 3 行＋用語・補足 2 行。全体を 63px 低くした）。
    - 320×568: 手番 457 → 401px、裁定あり 566 → 510px、Hand の終了の重なり 11 組 → 0 組。「次の Hand へ」はクリックが席に遮られていたが、Hero の欄の中で押せる。
  - **10 Hand の通し（Hero は Call / Check を続ける。手番ごと・終了ごとに測定。1280×900 の 67 点・375×760 の 58 点・375×667 の 54 点・320×568 の 58 点）**
    - 重なりの組（席・席の札・Bet・Board・Pot・Street・結果・進行ログ）: 375×760 10 種 → 0 種、375×667 9 種 → 0 種、320×568 13 種 → 0 種。1280×900 は前後とも 0 種で、Hero 欄の高さも変わらない（最大 243px）。
    - 横スクロールは全点で 0（`scrollWidth − innerWidth`）、操作 Button（`.btn` と Chip の Button）の中心を `elementFromPoint` で引いて自分以外の要素に覆われた点は 0（修正前は 320×568 の Hand の終了で「次の Hand へ」が覆われた）。ページのエラーは 0。Hero 欄の最大の高さ: 375 は 448 → 386px、320 は 517 → 461px。
  - **席数**（10 Hand の通しの 375×760。重なりの組の種類）: 2・3 人卓は 375 / 320 とも 0。5 人卓は 9 種 → 5 種。4・7・8 人卓は修正後に 3〜5 種が残る（4・8 人卓は修正前の 1 Hand の測定で 4〜6 組）。残るのは Bet が中央（Board・Pot・Street）や席の面と重なる組で、修正前も同じ根（Bet の位置が真横の席・中央に近い）。
  - **CPU 障害のダイアログ**（`OPPONENT_PROVIDER=claude`・`OPPONENT_TIMEOUT_MS=1`・4 人卓）: 375×760・375×667・320×568 でダイアログが Hero の欄の中に出て、3 つの選択肢（Retry / Emergency Bot / Session を終了）の中心が自分以外に覆われない（修正前の 320×568 は下端が Hero の欄に重なっていた）。Hero 欄は 397 / 397 / 417px。1280×800 は卓の中央のまま。
  - **Replay**（375×667・320×568・1280×900）: 重なり 0。375px で Jump の Button が「この判断の Review を見る」と重なっていた（`.spot-jump` が縮んで Button が箱から 56px はみ出し、右の Button が 310px から始まって 40px 重なっていた）→ 縮めずに行の中で横に送る（Review の Button は 422px から）。
- 目視（スクリーンショット）: 375×667 の Hand の終了で、卓の中央は Board と「Hand 終了」「ポット（Pot）」の 1 行だけになり、結果（「CPU 2 が ポット（Pot） 328 を獲得」）と「次の Hand へ」「この Hand の Review」が Hero の欄に出る。裁定ありの 375×760 では、案内が Hero の札の右、裁定の文 3 行、用語と補足が 2 行。
- dev サーバー（3201 / 5273）は確認後に停止した。

## 判断理由

- 結果を卓の中央に収めようとしなかった理由: 375px では上段と下段の席の間の帯が約 106px で、Board・Street・Pot（約 90px）だけで埋まる。結果の欄（約 100px）はどう並べ替えても入らない。#84 の Review の Button と同じく、常に見える Hero の欄へ置いた。
- 裁定の分の +106px は減らせなかった（裁定の文と、用語・補足の Button は省けない）ので、そのほかの高さを削って全体を低くした。

## 残課題

- 4・5・7・8 人卓の 375px 以下では、Bet が中央（Board・Pot）や席の面と重なる組が一部に残る（修正前より少ない）。Bet の位置を席数ごとに決める必要があり、卓 UI のデザイン体系（#5）で扱う。
- 裁定があるときの Hero 欄は、裁定なしより約 106px 高い（375px）。裁定の分の高さを減らすには、用語の Button の出し方（Vocabulary）を変える必要がある。
- 320×568 では Hero 欄が 401〜510px で画面の 7〜9 割を占める（卓はスクロールで見る。従来どおり）。
- 10 Hand の通しでも、320×568 の 1 点だけ席と Bet が 4px 重なることがある（Bet の札の幅が大きい額のとき）。
