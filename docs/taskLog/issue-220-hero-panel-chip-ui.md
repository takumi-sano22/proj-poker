# Issue #220: UX-05 Chip と Hero 操作 UI の拡大・スマホの折りたたみ

## 目的

- D137（スマホの Hero 操作パネルの折りたたみ・手番で自動で開く・高さの上限 65〜70%）と D138（操作用 Chip PC 約 54px / スマホ 48〜52px・移動の視覚化・Betting Area の見た目の縮小と判定領域の維持）を実装する。
- #219 の下書きの契約（D139・D146）、#226 の Ack（D145・D147）、CPU 障害（Outage）の優先表示を壊さない。数値は OI-012 の可逆な暫定値。Engine・Event・API・DB は変えない。

## 変更内容

- `apps/web/src/lib/hero-panel.ts`（新規）: 手番の識別子 `heroTurnKey`（手番の間の displayed の `operationKey`）・`initialHeroPanel`・`nextHeroPanel`（新しい手番でだけ開く）・`panelOperable`（操作の欄を出す条件。Outage・結果・Session 終了では折りたたみを出さない）。
- `apps/web/src/App.tsx`: `HeroDock` に開閉の状態と開閉 Button（`HeroPanelToggle`。`aria-expanded` / `aria-controls`、閉じたときの「Dealer の確認が必要」「送った操作の結果待ち」「もう一度の確定が必要」・手元 / 出した Chip の額）。狭い画面だけ。`ChipControls` に `id` を渡す。
- `apps/web/src/components/ChipControls.tsx`: Click / キーボードで手に取る・手元と Betting Area の Click で出すときに移動の演出を流す（下書きは先に変える）。Betting Area は判定の Button を欄いっぱいにし、見た目を `.betting-area__felt` に分けた。Drag で付いてくる Stack の Chip を操作用の Chip と同じ札で描く。
- `apps/web/src/lib/chip-flight.ts`（新規）: Web Animations で Chip を from → to へ飛ばす。`--duration-chip` が 0（演出なし・reduced-motion）なら要素を作らない。`pointer-events: none`。
- `apps/web/src/styles.css`: トークン `--duration-chip` / `--chip-op-d` / `--chip-op-hit`、卓上の `--chip-d` 14→16px（狭い画面 11→12px、7・8 人卓の 720px 以上は 14px のまま）、操作の grid（719px 以下は手元を次の行）、Betting Area のフェルト（最大 300px）、開閉 Button・`data-collapsed` で `.chip-controls` だけ隠す、狭い画面の `.dock` に `max-height: 68dvh` と内部スクロール、1024〜1279px の Chip 52px と確定 Button の幅。
- テスト: `lib/hero-panel.test.ts`（自動で開く規則・`panelOperable`〔Outage〕・CSS の契約）、`e2e/tests/hero-panel.spec.ts`（新規 5 本）、`e2e/support/layout.ts` に `skipTableOverlap`（#252 の既知の重なりの除外用）。
- docs: `docs/06` §1・§16 冒頭・§16.3「実装（UX-05 #220）」、`docs/03`、`docs/11` OI-012（暫定値の置き場所。永久確定はしない）、`ui-design-recipes/references/proj-poker.md`。

## 判断理由

- 閉じたときに隠すのは `.chip-controls` だけ。RULING / ETIQUETTE の欄・裁定の Feedback・障害・結果は閉じても出す（RULING の省略禁止〔D137〕・Ack の導線〔D147〕・障害を先に〔D145〕）。外さずに CSS で隠すので、下書き・Drag の状態・再確認が消えない。
- 自動で開く契機を「手番の boolean」ではなく `operationKey` にした: 受理された Hero の操作は必ず Hero への裁定を 1 つ増やす（D146）ので、同じ手番の再描画では変わらず、次の手番では必ず変わる。手番の後に自動で閉じないのは、送信の結果待ち・再確認の間に畳まないため。
- 1024〜1279px は 54px の Chip で Betting Area の欄が潰れた（既存 table-layout の 1024×768 RULING で Hero 欄が 501px）ので 52px にした（D138「画面に応じて調整」の範囲）。
- 移動の演出は Drag では流さない（付いてくる Chip がすでに移動を示し、Drop の非同期確定〔#251 P3〕に演出のタイミングを足さない）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`: 通過。`pnpm test`: engine 493・web 310・server 940 件すべて通過（途中の 1 回は server の `amaster97-adapter.test.ts` の同時実行数のテストが全体並列の負荷で落ち、単独で 3 回・全体の再実行で通過。web だけの差分と無関係のタイミング依存）。
- E2E 全件 42 本通過（`pnpm e2e`・9.4 分。新規 `hero-panel.spec.ts` 5 本を含む）。
- 実測（2〜8 人卓で同じ値。8 人卓 720×600 の席の交差だけ #252 で除外）:

| 画面 | 操作用 Chip（押せる大きさ） | 卓上 Chip | 開いた Hero 欄 | 閉じた Hero 欄 | Betting Area 判定 / フェルト |
| --- | --- | --- | --- | --- | --- |
| 320×568 | 48px（50） | 12px | 386px（68.0%・内部スクロール） | 172px（30.3%） | 168×52 / 166×44 |
| 375×667 | 48px（50） | 12px | 454px（68.0%・内部スクロール） | 172px（25.8%） | 223×59 / 221×57 |
| 720×600 | 48px（50） | 16px（7・8 人 14px） | 241px（40.2%） | 折りたたまない | 164×73 / 162×71 |
| 1280×720 | 54px（56） | 16px（7・8 人 14px） | 224px（31.1%） | 折りたたまない | 312×56 / 300×54 |
| 1280×900 | 54px（56） | 16px（7・8 人 14px） | 224px（24.9%） | 折りたたまない | 312×56 / 300×54 |

- 横スクロール 0、Betting Area の判定領域と Stack の Chip・手元・確定・宣言の矩形が交差しない、Betting Area の中心の `elementFromPoint` が Betting Area 自身、Hero 欄の全 Button の中心の hit-test を全組合せで確認。スクリーンショットは 2・6・8 人卓の各画面（開・閉）を Playwright の添付に残した（`e2e/test-results/hero-panel/`。CI では playwright-report）。

## 残課題・引き継ぎ

- #252: 8 人卓 720×600 の左側の席の面が約 1px 重なる（main でも同じ座標で再現する既存の問題）。直したら spec の `skipTableOverlap` を外す。
- PC の右の情報パネルの折りたたみ（D137 の PC 側）は #220 の WHAT に無く、未実装のまま。
- #224 へ: 卓の中央・Board / Pot / Showdown の演出を足すときは、Hero 欄の開閉 Button と `.chip-flight`（z-index 60）・Drag の札（z-index 50）の重なり順、Ack の導線を壊さない。卓上 Chip の拡大率（16 / 12 / 7・8 人 14px）は Bet・Pot の演出と合わせて見直せる。
- #225 へ: 効果音は Chip の移動の演出（`flyChip` を呼ぶ 2 か所）と同じ契機に足せるが、演出なし・reduced-motion と音のミュートは別の設定として持つ。
- #227 へ: 実機（iOS Safari の `dvh`・セーフエリア）で開閉と内部スクロールを確認する。
