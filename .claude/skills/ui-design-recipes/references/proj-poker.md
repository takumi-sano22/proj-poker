# ui-design-recipes: proj-poker 固有の補強

## 位置づけと優先順位

- 実装（`apps/web/src/styles.css` のトークン・`apps/web/src/components/` の共通部品）＞ 本 md ＞ 汎用の reference。
- 画面要件・表示ルールの正本は `docs/06_UI_UX.md`、実額常時表示は D49。本 md はそれを実装の値と部品へ落とす導線で、要件を上書きしない。
- 汎用の reference と違うところは、下の「固有の規律・例外」に書く（reference は書き換えない）。

## CSS 方式とトークン

- **Tailwind は使っていない。素の CSS 1 枚**（`apps/web/src/styles.css`）。reference の Tailwind クラスは素の CSS 値で読み替える。クラス名は BEM 風（`.seat__plate`・`.btn--primary`・`.feedback__item--ruling`）。
- トークンは `styles.css` 冒頭の `:root` の custom property。部品では色・影・角丸・所要時間を直書きしない。テーマは**ダークのみ**（`color-scheme: dark`）。`prefers-reduced-motion` で `--duration-*` を 0 にする。
- 主なトークン（実際の値は `styles.css` を読む。ここへ写さない）:

| 役割 | トークン |
| --- | --- |
| 地と面 | `--color-bg` / `--color-surface` / `--color-surface-raised` / `--color-surface-sunken` / `--color-border`（`-strong` / `-interactive`） |
| 文字 | `--color-on-surface` / `--color-on-surface-muted` |
| 主操作・手番（金） | `--color-brand-400/500/600` / `--color-on-brand` |
| 取り消しにくい操作（All-in） | `--color-danger-600/700` / `--color-on-danger` |
| 卓 | `--color-felt-center` / `--color-felt-edge` / `--color-rail` / `--color-on-felt` / `--color-on-felt-muted` |
| Card | `--color-card-face` / `-edge` / `-back` / `-back-mark` / `--color-suit-red` / `-black` |
| Chip | `--color-chip-<white\|red\|green\|black\|purple>` と `-edge`（Table Config の `ChipColor`〔D92〕と 1 対 1。テストが定義の有無を検査）・`--color-dealer-button` |
| Dealer Feedback | `--color-feedback-ruling`（金）/ `-etiquette` / `-coaching` |
| Review | `--color-assess-good\|neutral\|caution\|bad\|unknown`・Pass B の面 `--color-reveal`（`-surface` / `-border`） |
| フォーカス | `--color-focus`（`:focus-visible` の 2px リング） |
| 影 | `--shadow-rest` / `--shadow-raise` / `--shadow-overlay` / `--shadow-raise-up`（下に固定する Hero 欄）/ `--shadow-turn`（手番の発光） |
| 角丸 | `--radius-control` 10px / `--radius-aside` 12px / `--radius-panel` 16px / `--radius-layer` 20px |
| 動き | `--duration-fast` 120ms / `--duration-base` 200ms / `--ease-out` |
| 卓の寸法 | `--seat-rx` / `--seat-ry` / `--bet-rx` / `--bet-ry` / `--chip-d` / `--chip-step` / `--card-sm-w` / `--card-md-w` / `--card-lg-w`（狭い画面で上書き） |

- フォントは `"Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif`・15px・行間 1.6（Web フォントなし）。

## 既存部品の対応表（新しく作らない）

パスは `apps/web/src/` 起点。

| 作るもの | 使う実装 |
| --- | --- |
| ボタン | `.btn`（`min-height: 44px`）+ `--primary`（金）/ `--secondary` / `--ghost` / `--danger`、`--sm` / `--md` / `--lg`。切り替えは `.toggle`（`aria-pressed`） |
| 卓・座席 | `components/Table.tsx`（`Table` / `Seat` / `BetPill`）。席の向きは `lib/view-model.ts` の `seatDirections`（Hero は真下・時計回り）が `--dir-x` / `--dir-y` で渡し、位置は CSS の半径（`--seat-rx` / `--seat-ry`）を掛けて決める |
| 実額・BB | `components/Amount.tsx` / `BbDisplay.tsx`（`.amount__real` が正本、`.amount__bb` が補助。BB の ON/OFF は `lib/display-settings.ts`） |
| Card | `components/PlayingCard.tsx`（SVG の構造描画・D60。`sm` / `md` / `lg`、`null` は裏向き、`muted` は Fold 済み） |
| チップスタック | `components/ChipStack.tsx`（`ChipStack` は額から Engine の `composeChips` で組む、`ChipPile` は出した枚数のまま。5 枚超は ×N） |
| Pot | `Table.tsx` の `.pot`（`Term` +`Amount`） |
| 宣言 Button・Chip 操作 | `components/ChipControls.tsx` + `hooks/useChipDrag.ts` + `lib/chip-ops.ts`（Click 回数 = 枚数、Click か Drag で Betting Area へ。宣言は全種を常に出し All-in だけ `btn--danger`。数値の Bet Box・Slider は作らない） |
| Dealer Feedback / Ruling | `components/DealerFeedback.tsx` + `lib/dealer-feedback.ts`（RULING / ETIQUETTE / COACHING を札と左の縁の色で分ける。Hero 欄は RULING を常に出し、他は札の button で開く） |
| Poker Vocabulary | `components/Vocabulary.tsx` + `lib/vocabulary.ts`（`Term` と `.vocab` の詳細） |
| 進行ログ | `components/HandLog.tsx` |
| CPU 障害のダイアログ | `components/OutageDialog.tsx`（`role="alertdialog"`、狭い画面は `.outage--docked`） |
| Hand の結果・Session 終了 | `App.tsx` の `HandResult` / `SessionEnded`（狭い画面は `.result--docked`） |
| Hero 欄 | `App.tsx` の `HeroDock`（`.dock`・画面下に sticky） |
| Replay | `components/ReplayScreen.tsx` + `hooks/useReplay.ts` + `lib/replay.ts`（卓・進行ログ・Hero 欄は卓の画面と同じ部品） |
| Review | `components/ReviewScreen.tsx` / `ReviewPass.tsx` / `ReviewEvidence.tsx` / `FollowUp.tsx`。根拠の欄の卓の傾向は `ReviewEvidence.tsx` の `TableTendencyView`（`.tendency`。項目ごとに名前・割合と分子 / 分母・機会があった Hand・十分か保留かの 1 つの面。560px 以上は列をそろえ、狭い画面は折り返す。十分か保留かは色と文字の両方で示す） |
| 狭い画面の判定（JS） | `hooks/useNarrowScreen.ts`（`NARROW_SCREEN_QUERY`。テストが CSS の `@media` と同じ値かを検査） |

## 画面幅と卓の配置規則

- **卓の配置の境界は 719px / 720px の 1 本**（`max-width: 719px` が狭い画面）。ほかに `min-width: 1024px`（進行ログを右に出す 2 列）、`max-width: 359px`（320px 級の詰め）、`hover: hover`（hover の演出）。**同じ閾値を CSS と JS で別々に書かない**。JS で要るときは `useNarrowScreen` を使う。
- **席と重なる欄は卓の中央に重ねない**。狭い画面では、Hand の結果・Session 終了の案内・CPU 障害のダイアログを Hero 欄に置く。広い画面では卓の中央に置く。ただし Session 終了の案内（理由と 2 つの Button）は、結果の欄が縦に 2 つの Button で背高になり 1280×720 で Hero の席に覆われたので（#158）、広い画面でも Hero 欄に置く（卓の中央は獲得額の一覧だけ。`sessionEndInDock`）。同じ内容を 2 か所に描かないので、CSS で隠し分けず、`useNarrowScreen` で描く場所を 1 か所に決める。
- **Bet の札**: 広い画面では卓の上、席の前に置く（`--bet-rx` / `--bet-ry`）。狭い画面では席の面の中、Stack の Chip の下に置く（`BetPill` を `Seat` の `betInside` で切り替える。`.bet--inside`）。卓の上に置くと、席数によっては中央や隣の席と重なる。
- **卓の中央**: 狭い画面の 2・3・6 人卓は、1 行目を Board、2 行目を Street と Pot にする。中央の高さに席の面が来る 4・5・7・8 人卓は、Street・Board・Pot を縦に積む（`data-center-stacked`。`CENTER_STACKED_SEAT_COUNTS` の 1 か所で決める）。
- **卓の縦横比**: 広い画面は 16:10。狭い画面は縦長で、値は `styles.css` と `docs/06` §1 にある。席の面に要素を足すと、`.seat` は面ごと中心に合わせている（`translate(-50%, -50%)`）ため、中央の側にも同じだけ伸びる。足したときは縦横比・`--seat-ry`・面の幅を一緒に見直す。
- **中間幅（720〜1023px）の Hero 欄**: 卓は広い画面の配置のまま、Hero 欄だけ狭い画面と同じ詰め方（Hero 欄の grid・宣言 Button・Betting Area・確定 Button の compact は `max-width: 1023px`）にし、手番の案内（`.dock__turn`）は 1 行目の右に置く（`min-width: 720px` かつ `max-width: 1023px`）。欄が横いっぱいに広がるのに、Hero の札・Stack の右の列だけに操作を詰めると、Betting Area が潰れて折り返し 434px（720×600）まで高くなった（#163）。Hero の欄の高さは、**Hero の席から Board までの高さを欄の分だけ引いた画面の高さに収める**ことで決める（720 以上は E2E が測る）。
- **Hero 欄は低く保つ**: 手番などの 1 行の案内は札の右に並べる。RULING は省かず、全体の高さで吸収する。1023px 以下の Dealer Feedback は、分類の札を文の先頭に、用語と補足（作法・学習）の Button を文の末尾に流し込む（別の列・別の行に置くと、文が削られて折り返すか 1 行増える。#179）。狭い画面は欄の上下の余白を 8px に詰め、320px 級（359px 以下）は Betting Area の案内（Click / Drag の仕方）を省いて、確定 Button と同じ 2 行に収める。
- **flex の行がはみ出す中身を持つなら `flex: none` にする**。縮めると、隣の Button と重なる。

## このプロジェクト固有の規律・例外

- **実額は常時表示する（D49）**。狭い画面で省いてよいのは補助の BB 換算だけ（宣言 Button の `.declaration__bb`、Bet の札の `.amount__bb`）。
- Card と Chip は画像ではなく構造で描く（Card は SVG、Chip は CSS の丸）。Chip の色は額面の構造の一部なので、トークン名を `ChipColor` と 1 対 1 に保つ。
- Dealer Feedback の 3 分類は、色だけでなく分類名の札でも区別する。Review の段階評価も、色だけでなく文字で示す。
- 世界観はモダン・カジノで、強めの演出を許す（D135。旧「グラデーション・発光の演出は控えめに」を置き換えた）。ただし実額・RULING・Hero の操作を覆わない・読みにくくしないことを先に守り、演出は動きを省いても表示の内容が欠けないように作る（D140）。今の実装で使っている装飾は手番の発光（`--shadow-turn`）だけ。
- 3D・Voice・BGM は作らない（非目標。`docs/00` §6・D141）。

## 横断 UI/UX の新しいレイヤー（設計のみ。#215・D135〜D142）

設計の正本は `docs/06` §16、可逆な値は `docs/11` OI-012。**まだ実装していない**ので、下の部品名は予定で、実装する Issue（UX-03〜UX-11）が決める。#215 の Gate を満たすまで機能を実装しない。

| レイヤー | 置き場所の予定 | 守ること |
| --- | --- | --- |
| App Shell（Home / Play / Learn） | `App.tsx` の画面の状態の上に Shell を置く（UX-03 #218） | 起動時は Home。Home は読み取り専用の照会だけ（UX-02 #217）。Learn / Replay の戻り先と閲覧位置を保持 |
| 右の情報パネル（PC） / 折りたためる Hero 操作パネル（スマホ） | 既存の進行ログ・Note / Tag・Tournament の欄・`HeroDock` を組み替える（UX-03・UX-05 #220） | HUD を足さない（D32）。スマホは手番で自動で開き、高さの上限は画面の約65〜70%で内部スクロール |
| Chip の操作と移動の演出 | `ChipControls.tsx`・`useChipDrag.ts`（UX-05・UX-09 #224） | Click / Drag の両方。ドロップの判定領域を他の操作と重ねない。下書きは折りたたみ・画面の移動で失わない（UX-04 #219） |
| Presentation Controller | 表示のキュー（UX-07 #222）。Live と Replay（`useReplay.ts`）で部品を共有 | Hero に見える View / Event だけ。順序を保つ・速度4段階・Showdown の内容を省かない・再接続でキューを捨てる。Fast Forward と別 |
| Dealer の通知 | `DealerFeedback.tsx`（UX-11 #226） | RULING を数秒 → 自動で閉じる → ETIQUETTE を明示確認 → 再開。3 分類を混ぜない |
| 効果音と設定 | 表示設定（`lib/display-settings.ts` と同じ viewer の保存が第一候補。UX-10 #225） | 既定 ON・自動再生の制約を尊重・音量とミュートを保存。Event Log に入れない |
| 装飾素材 | Visual Asset Pack（UX-08 #223） | Card / Chip は構造描画のまま（D60）。色・光・影・動き・音はトークン経由で、部品に直書きしない |

- 新しいトークン（世界観の色・光・演出の所要時間・音量）は既存の `:root` に足し、上の「主なトークン」の表に種類を足す。値は OI-012 の暫定値で、ここへ写さない。
- 演出の所要時間は既存の `--duration-*` と同じく `prefers-reduced-motion` で 0 にする。

## 重なりの測り方（UI を変えたら）

- Playwright で 1280×720（既定。卓の高さが `70vh` で頭打ちになり、中央の欄が席に最も近い）・1280×900・375×760・375×667・320×568 を測る。**席数（2〜8 人）× 画面幅 × 何 Hand も**測る（1 点だけでは、席数と額によって外れる）。
- 測る項目:
  - 席の面・札・Bet・Board・Pot・Street・結果・進行ログ・見出しの矩形が交差しないか
  - 操作 Button の中心で `elementFromPoint` を取り、他の要素に覆われていないか
  - `scrollWidth − innerWidth` が 0 か（横スクロールの有無）
  - Hero 欄の高さ
- 絶対配置がはみ出す要素は、卓の外の隣接要素（見出し・進行ログ）まで含めて測る。
- Session 終了後の配置は `e2e/tests/session-end-layout.spec.ts`（1280×720・1024×768・375×667・320×568 で矩形の交差と Button の中心の hit-test）。
- **画面の大きさごとの配置は `e2e/tests/table-layout.spec.ts`**（720×600・1024×768・1280×720・375×667・320×568 × Hand の途中の Hero の手番・RULING が出た Hero の手番〔Call 額があるのに Check を宣言して決定論的に出す。#179〕・Hand の終わり・Session の終わり。測り方は `e2e/support/layout.ts`: 席・Board・Pot・結果の矩形の交差、Hero 欄の Button の中心の hit-test、通常の click の確認〔`trial`〕、横スクロール、720px 以上は「Hero 欄を除いた画面の高さに Hero の席・Board・Pot が同時に収まる」、720px 未満は「Hero 欄が画面の高さに収まる」）。**中間幅（720〜1023px）を測る画面の一覧に入れる**。Hero 欄に出す項目（裁定・案内）を足したら、その項目が出た状態もこの spec に足す。
- 手元でも、720×600・900×700・1023×768 を測る（欄が折り返す幅は、広い画面の配置が収まらなくなる 720px 付近に出る）。
- E2E（`e2e/tests/session.spec.ts`）の 375px のテストは、Playwright の `click()` が覆われた Button で失敗するので、そのまま重なりの検査になる。
- 手順と過去の数値は作業ログにある: `docs/taskLog/issue-5-table-ui-narrow-overlap.md`、`docs/taskLog/issue-5-bet-placement-seat-count.md`。

## 関連 skill への導線

- 実装前の判定基準 → `implementation-guidance` の `references/ui.md`
- 表示経路への配線漏れなど、レビュー時の欠陥クラス → `code-review` の台帳（LC-040 ほか）

## 出典の対応表

| reference | proj-poker での出典 |
| --- | --- |
| `foundations/color-usage.md` | `styles.css` の `:root`（卓・Chip・Feedback の専用色を含む） |
| `foundations/surface-and-depth.md` | 影 `--shadow-*`・角丸 `--radius-*` |
| `components/button.md` | `.btn` と宣言 Button（`ChipControls.tsx`） |
| `components/modal.md` | `OutageDialog.tsx`、Vocabulary の詳細 |
| `layout/app-shell-responsive.md` | `App.tsx`（卓 + 進行ログ + 下に固定の Hero 欄）・`useNarrowScreen.ts` |
| `effects/glow-and-decor.md` | 手番の発光 `--shadow-turn` |

## 既知のずれ

- （未解決。D137 で方針は決まったが未実装）狭い画面（719px 以下）は、Hero 欄が画面の高さの大半を占める（#179 で詰めた後の Hero の手番の欄の高さ: 320×568 で 422px〔74%〕・375×667 で 369px〔55%〕。RULING が出ると 320×568 で 541px〔95%〕・375×667 で 469px〔70%〕）。画面下に固定した欄の上に見える卓は 1〜3 割なので、Hero の席・Board・Pot を見るには欄の上で卓をスクロールする（7・8 人卓も同じ）。RULING の文（4 行前後）・宣言 Button 2 段・Chip・手元・Betting Area は、どれも省くと操作か裁定の情報が欠け、44px の押せる大きさも保つ必要があるので、CSS の詰め方ではこれ以上低くできない。さらに低くするには、狭い画面で欄を固定しない・Chip の操作を畳む、などの UX の変更（人間判断）が要る。この人間判断は D137（スマホは Hero 操作パネルを折りたためる形にし、Hero の手番で自動で開く・開いた高さの上限は画面の約65〜70%で内部スクロール）で済み、実装は UX-05（#220）。それまでは下の数値のまま。E2E は「欄が画面の高さに収まる」（全部の操作を同時に見られる）までを測る。
- 作法・学習の補足を開くと、Hero 欄はさらに 1 項目ぶん高くなる（720×600 で約 326px になり、Hero の席・Board・Pot が同時には収まらない。320×568 では欄が画面より高くなり、ページの一番上では宣言 Button の下端が、それ以外では札と裁定の上端が画面の外に出る）。開いたときだけで、閉じれば戻る。
- ライトテーマは無い（ダークのみ）。
