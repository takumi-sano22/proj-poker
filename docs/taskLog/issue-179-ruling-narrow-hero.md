# Issue #179: 裁定（RULING）表示時と 320px で Hero の欄が高くなる既知のずれを直す

## 概要

`ui-design-recipes` の `references/proj-poker.md`「既知のずれ」の 2 件（狭い画面で RULING が出ると Hero 欄が約 106px 高くなる・320×568 で Hero 欄が画面の 7〜9 割を占める）と、#163 で測っていなかった中間幅（720〜1023px）の RULING を扱う。完了条件:

- RULING が出た状態を 375×667・320×568・720×600・1024×768 で測り、Hero の席・Board / Pot・操作の欄が操作できなくなる重なりを作らない。
- 320×568 の Hero 欄の高さを改善する（できる範囲。縦スクロールが残るなら理由を reference に書く）。
- `e2e/tests/table-layout.spec.ts` に RULING の状態を足す。
- reference の「既知のずれ」を更新する。

人間の指示の確定値: 確認サイズは 320×568 / 375×667 / 720×600 / 1024×768 / 1280×720、状態は通常の Hero の手番 / RULING / Hand の終わり / Session の終わり（Tournament の UI も壊さない）。320px で縦スクロールを無くすのに UX を大きく変える必要があるなら、仕様は変えず、改善の範囲と残る制約を記録する。

## 初期調査

- 再現: 既定の 6 人卓・`POKER_SEED=20261042`・最初の Hand の Hero の手番（Call 額 2 がある）で、宣言の「チェック（Check）」を押す。裁定は `check_facing_bet`（`outcome: no_action`。Action は決まらず Hero の手番のまま）で、Hero 欄に RULING（用語「チェック（Check）」と「作法（Etiquette）」の Button 付き）が出る。決定論的に RULING を出せる。
- Playwright の一時スクリプト（リポジトリに入れていない）で `.dock` と中の項目の矩形を測り、`e2e/support/layout.ts` の `expectNoBlockingOverlap` を当てた。

修正前（Hero 欄の高さ）:

| 画面 | Hero の手番 | RULING | 作法を開く |
| --- | --- | --- | --- |
| 320×568 | 453px（80%） | 576px（101%） | 647px |
| 375×667 | 377px | 480px | — |
| 720×600 | 233px | 318px | — |
| 1024×768 | 297px | 382px | — |
| 1280×720 | 222px | 285px | — |

- 720×600 の RULING は、`expectNoBlockingOverlap` の「Hero 欄を除いた画面の高さに Hero の席・Board・Pot が同時に収まる」で落ちる（Hero 欄 318px を除いた 282px に、Hero の席〜Board〜Pot の 286px が入らない）。中間幅の Dealer Feedback は広い画面と同じ「札 | 文 | 用語」の 3 列で、用語の列（約 250px）に文が削られて 3 行に割れていた。
- 320×568 の RULING は、欄（576px）が画面（568px）より高い。画面下に固定（sticky）した欄が画面より高いと、ページの一番上以外では欄の上端（Hero の札・裁定）が画面の外に出る。
- 狭い画面（719px 以下）の Dealer Feedback は、用語と補足の Button を文の下の別の 1 行に置いていた（約 28px）。
- 320px の Betting Area は約 168px で、名前と案内が 4 行、隣の確定 Button も 3 行に割れて、この行が 67px あった。

## 設計方針

- 新しい配置や部品は作らず、CSS の詰め方だけで低くする。RULING は省かない（「RULING は省かず、全体の高さで吸収する」）。宣言・Chip・手元・Betting Area・確定の Button も 44px の押せる大きさのまま。
- Dealer Feedback は、Hero 欄が横いっぱいに広がる 1023px 以下（Hero 欄を詰める既存の境界。#163）で、札を文の先頭、用語と補足の Button を文の末尾に流し込む（Issue の「用語 Button の出し方を変える」）。Button は 1 つずつ文に続けて折り返す（まとめた箱にすると、入らないときに丸ごと次の行へ送られる）。1024px 以上は今のまま。
- 狭い画面は欄の上下の余白を 12px → 8px。320px 級（359px 以下）は Betting Area の案内（Click / Drag の仕方）を省き、確定 Button の左右の余白を詰めて、名前・確定とも 2 行に収める。案内の内容（押すと手に取った Chip を出す）は Betting Area の Button の名前（aria-label）にもある。
- 320×568 で欄を画面の高さの半分以下にするには、狭い画面で欄を固定しない・Chip の操作を畳むなどの UX の変更が要る（人間判断）。今回は行わず、改善した範囲と残る制約を reference の「既知のずれ」と `docs/06` §1 に書く。
- `decision_log.yaml` の採用済み判断に反しない（D49 の実額表示・D44 の Click / Drag の操作は変えない）。新しい人間判断は不要。

## 変更内容

- `apps/web/src/styles.css`
  - Dealer Feedback の詰め方の `@media` を `max-width: 719px` → `max-width: 1023px` に広げ、用語と補足の Button を別の行（`display: flex; margin-top: 4px`）ではなく文の末尾に流し込む（`.feedback__terms { display: inline }`・子に `margin-left: 4px`）。
  - `max-width: 719px` で `.dock` の上下の余白を 8px にする。
  - `max-width: 359px` で `.betting-area__hint` を省き、`.chip-controls__submit` の余白を `4px 6px` にする。
- `e2e/support/layout.ts`: 720px 未満は「Hero 欄が画面の高さに収まる」を確かめる（欄が画面より高いと、欄の上端か下端が常に画面の外に出る）。
- `e2e/tests/table-layout.spec.ts`: 「裁定（RULING）が出た Hero の手番」の step を足した。最初の Hand で Call 額があることを確かめ（seed が変わったら気付く）、「チェック（Check）」を宣言して RULING の文を待ち、5 つの画面の大きさで `expectNoBlockingOverlap` と、宣言 Button 6 つ・RULING の用語「チェック（Check）」・「作法（Etiquette）」の通常の click の確認（`trial`）を行う。用語と宣言の Button は同じ名前なので、宣言は `宣言（Declaration）` の group、用語は RULING の項目の中で探す。
- `.claude/skills/ui-design-recipes/references/proj-poker.md`: 「Hero 欄は低く保つ」に Dealer Feedback の流し込みと狭い画面の詰め方、`table-layout.spec.ts` の測る状態に RULING と 720px 未満の項目、「既知のずれ」を修正後の数値と残る制約に書き換えた。
- `docs/06_UI_UX.md` §1・`docs/03_SYSTEM_ARCHITECTURE.md`: RULING の詰め方と、320×568 に残る制約を追記。

## 修正後の数値（Hero 欄の高さ）

| 画面 | Hero の手番 | RULING | 作法を開く |
| --- | --- | --- | --- |
| 320×568 | 422px（74%） | 541px（95%） | 616px |
| 375×667 | 369px（55%） | 469px（70%） | 523px |
| 720×600 | 233px | 291px | 326px |
| 1024×768 | 297px | 382px | 420px |
| 1280×720 | 222px | 285px | 323px |

- 720×600 の RULING は、Hero 欄を除いた 309px に Hero の席〜Board〜Pot の 286px が収まる（修正前は 282px に入らなかった）。
- 320×568 の RULING は、欄が画面に収まる（541px ≤ 568px）。
- 1024px 以上は変えていない。
- 作法を開いた 720×600 は 326px で、Hero の席・Board・Pot が同時には収まらない（開いたときだけ。閉じれば戻る）。reference の「既知のずれ」に書いた。

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 480・web 160・server 843 件）/ `pnpm format:check` を通した。
- 修正前の `styles.css`（`origin/main`）に戻すと、新しい `table-layout.spec.ts` が `RULING 720×600: Hero 欄（高さ 318px）を除いた 282px に、Hero の席・Board・Pot（286px）が同時に収まる` で失敗する。修正後は通る。
- `pnpm e2e`（全 12 本。`tournament.spec.ts`・`session-end-layout.spec.ts`・`session.spec.ts` を含む）: 12 passed（1.8m）。
- `pnpm e2e table-layout --repeat-each=10`: 10 passed（1.7m）。
- `pnpm e2e table-layout session-end-layout --repeat-each=10`（2 回目。#158 の回帰を含む）: 40 passed（4.1m）。
- 画面の確認（Playwright の一時スクリプトのスクリーンショット。リポジトリには入れていない）: 320×568・375×667・720×600・1024×768・1280×720 の Hero の手番・RULING・作法を開いた状態。

## 残課題

- 320×568 の Hero 欄は、Hero の手番で画面の 74%、RULING が出ると 95% を占める。RULING の文・宣言 Button 2 段・Chip・手元・Betting Area はどれも省くと操作か裁定の情報が欠けるので、CSS の詰め方ではこれ以上低くできない。さらに低くするには UX の変更（狭い画面で欄を固定しない・Chip の操作を畳む等）の人間判断が要る。
- 作法・学習の補足を開いた状態は、720×600 で Hero の席・Board・Pot が同時には収まらず、320×568 で欄が画面より高くなる（E2E の対象外）。
