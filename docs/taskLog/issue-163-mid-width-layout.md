# Issue #163: 720〜1023px 幅で Hero の欄が折り返して高くなり卓の下側を覆う

## 概要

720〜1023px 幅（中間幅）で、画面下に固定した Hero の欄が折り返して高くなり、卓の下側（Hero の席・Board・Pot）を覆った。Hand の途中の Hero の手番では 720×600 で欄が 434px（y=166〜600）になる。#158（PR #162）の残課題。完了条件:

- 中間幅で Hero の欄の高さが卓の主要な情報（Hero の席・Board・Pot）を覆わない配置にする。
- 720×600・1024×768 の Hand の途中と Session 終了後で、席と操作の欄が重ならない回帰の検査を足す。
- 375px・320px・1280×720 を壊さない。

## 初期調査

- 再現: 既定の 6 人卓・`POKER_SEED=20261042`・最初の Hand の Hero の手番。Playwright で `.dock`・`.chip-controls` の矩形を測った（一時スクリプト。リポジトリには入れていない）。
- 修正前の欄の高さ（Hero の手番）: 720×600 = 434px、900×700 = 435px、1023×768 = 318px、1024×768 = 297px、1280×720 = 222px。
- 根: `.dock` は 720px 以上で「Hero の札・Stack の列」と「操作（`.dock__controls`）の列」を横に並べる。720px 付近では操作の列が 419px しか無く、`.chip-controls` が広い画面の 1 行（Chip・手元・Betting Area・確定を横に並べる）のままなので、Betting Area が潰れて 1 文字ずつ折り返し（246px）、宣言 Button 6 つも 3 行に割れて、欄が 434px になった。720〜1023px は、卓は広い画面の配置のまま（`useNarrowScreen` の境界は 719/720px）で、欄だけ横幅が足りない。
- 中間幅の単一の列（進行ログは卓の下に回る）なので、欄が高いとどこまでスクロールしても Hero の席と Board を同時に見られない。欄の高さは「Hero 欄を除いた画面の高さに Hero の席〜Board〜Pot が収まる」で判断できる。

## 設計方針

- 卓の配置（`useNarrowScreen` の 719/720px の境界）は変えない。中間幅の卓は広い画面の配置のまま。
- Hero の欄だけ、狭い画面（719px 以下）と同じ詰め方を 1023px 以下へ広げる。欄が横いっぱいに広がる幅では、札・Stack と案内を 1 行目、Chip・Betting Area・確定と宣言 Button を横幅いっぱいの行に並べる方が低くなる。新しい配置は作らず、既存の規則の適用範囲を広げる。
- 手番の案内（`.dock__turn`）だけは 720〜1023px で 1 行目の右へ置く（右の列に収まる）。狭い画面の `.dock__turn` は変えない（375px・320px の配置を壊さない）。
- 新しい人間判断は不要（`decision_log.yaml` の判断に反しない配置の修正）。

## 変更内容

- `apps/web/src/styles.css`: 次の 3 つの `@media` を `max-width: 719px` → `max-width: 1023px` に広げた。Hero 欄の grid（札・Stack と案内を同じ行に並べる）、確定 Button の `max-width: 112px` の詰め、宣言 Button・Chip・Betting Area の詰め（`.declaration` の文字と余白・BB 換算を省く・Chip と Card を 1 段小さく・Betting Area の文字）。`min-width: 720px` かつ `max-width: 1023px` で `.dock__turn` を 1 行目の右へ置く規則を足した。
- `e2e/support/layout.ts`（新規）: 席・Board・Pot・結果の矩形の交差、Hero 欄の Button の中心の hit-test、通常の click の確認（`trial`）、横スクロール、「Hero 欄を除いた画面の高さに Hero の席〜Board〜Pot が同時に収まる」（720px 以上）。
- `e2e/tests/table-layout.spec.ts`（新規）: 回帰の検査。
- `docs/06_UI_UX.md` §1・`docs/03_SYSTEM_ARCHITECTURE.md`・`.claude/skills/ui-design-recipes/references/proj-poker.md`: 中間幅の Hero の欄と、測る画面の一覧に中間幅（720×600・1024×768）を追記。

## 回帰の検査（`table-layout.spec.ts`）

- 1 つの Session（`POKER_SEED=20261042`）を、画面の大きさ 720×600・1024×768・1280×720・375×667・320×568 ごとに、(1) 最初の Hand の Hero の手番、(2) Hero が Bust して Session が終わった後、の 2 つの状態で測る。Hand は開始の応答の handId で特定し、終わった Hand が server の一覧で complete であることも確かめる（#129・D117）。
- 測る項目: 席・Board・Pot・結果の欄が互いに交差しない／Hero 欄のすべての Button の中心を Button 自身が受ける／横スクロールが無い／720px 以上は Hero の席・Board・Pot の高さが「画面の高さ − Hero 欄の高さ」に収まる／宣言 Button（Hand の途中）と「この Session を振り返る」「新しい Session を始める」（Session の終わり）を `click({ trial: true })` で押せる（force なし。押下はしない。確定 Button は Chip を出すまで disabled なので除く）。
- 修正前の `styles.css` に戻すと、720×600 の Hand の途中で「戻す」の中心が別の要素（潰れた Betting Area）に覆われて失敗する（修正前に確かめた）。
- 既存の `session-end-layout.spec.ts`（#158）は変えていない。

## 修正後の数値（Hero の手番の Hero 欄の高さ）

| 画面 | 修正前 | 修正後 |
| --- | --- | --- |
| 720×600 | 434px | 233px |
| 900×700 | 435px | 233px |
| 1023×768 | 318px | 216px |
| 1024×768 / 1280×720 / 375×667 / 320×568 | 297 / 222 / 377 / 453px | 変わらない |

User Read（読みを記録）を開いた 720×600 でも欄は 302px（卓の下側は見える。ボタンは覆われない）。

## 実行した確認

E2E_RESULTS_PLACEHOLDER

## 残課題

- 狭い画面（375×667・320×568）は、欄が高く、Hero の席と Board が同時には収まらない（`references/proj-poker.md`「既知のずれ」。#5 からの既存。今回の範囲外）ため、「収まる」の検査は 720px 以上に限った。
- 1024〜1279px は進行ログを右に出す 2 列で、欄は広い画面の配置のまま（1024×768 で 297px。Betting Area はやや窄いが、折り返しはあるものの操作は覆われない）。今回は 720〜1023px に限った。
