# Issue #19: Web の Basic UI（2D 卓・実額表示・Declaration Button）

## 概要

`apps/web` に Basic UI（2D の卓）を作り、ブラウザで Hero として 1 Hand を最後まで遊べるようにした。卓の状態は #18 の SSE（`GET /api/hands/:handId/stream`）で受け取り、Hero の宣言は REST（`POST /api/hands/:handId/actions`）で送る（D73）。`apps/server`・`packages/engine` は変更していない。

## 設計方針

- **表示はサーバーの HeroView だけに基づく**: クライアントは状態を進めず、合法性も判定しない（D40）。宣言ボタンは `legalActions.actions` にある種類だけを出し、Bet / Raise の範囲は `min` / `max` をそのまま Slider の範囲にする。Engine は型だけを import する（`@proj-poker/source` 条件で src の型を読む。ロジックはブラウザで動かさない）。
- **他者の札**: `seats[].holeCards` に入っているもの（Showdown で公開された札）だけを表に向ける。それ以外は裏向き、Fold 済みの席は札なし。クライアントで推測・保持しない（D28）。
- **受信経路が 2 つある**（REST の応答と SSE の Push）: `selectLatestView` で「同じ Hand で `log` の最後の seq が進んでいる方」だけを残す。別 Hand の遅れた応答は捨てる（LC-041）。送信中は ref と state の 2 層で二重送信を止める。SSE の `data` は `parseHeroView` の最小の形検査を通ったものだけを描画へ流す（LC-043）。
- **SB / BB は公開 Event の `BLIND_POSTED` から読む**（位置をクライアントで計算しない）。Dealer Button は `seats[].isButton`。
- **実額が正本、BB は補助**（D49）: `Amount` 部品で実額を大きく、BB 換算を小さく添える。Stack・Pot・Bet・宣言ボタンの額・Preset のすべてに適用。
- **Bet 額**: Preset（最小・½ Pot・¾ Pot・Pot）と Slider。Pot 比は「Call した後の Pot」に対する Raise 幅で、to 額 = currentBet + 比率 × (pot + toCall) をサーバーの min / max に丸める。数値の入力欄は作らない（docs/06 §4）。
- **Card / Chip は構造描画**（D60）: Card は SVG（表・裏）、Chip と Dealer Button は CSS。色は `styles.css` の `:root` のトークンで差し替えられる。
- **Fold 後も観戦を続ける**（docs/06 §8）: 画面下の欄に「フォールドしました。Hand の終了まで観戦します。CPU n の手番…」を出す。
- **用語は「日本語 + 標準 Term」**（docs/06 §7）: 宣言ボタン・ログ・ラベル（例: レイズ（Raise）、ポット（Pot）、ボタン（BTN））。
- **ui-design-recipes**: 汎用版を参照（proj-poker 固有の補強 md は未作成。#5 で整える）。色は役割名のトークン、影は rest / raise / overlay / raise-up の 3 段＋上向き、角丸は層ごと（操作 10 / 脇役 12 / 読む対象 16）、状態は影の段と枠で示し（hover で 1 段上げ・押下で影を消す）、手番は色＋発光＋「手番」の文字で示す。hover の演出は `@media (hover: hover)` に限る。reduced-motion で所要時間を 0 にする。
- **画面下の Hero 欄**は `position: sticky; bottom: 0`。`fixed` だと高さが変わるモバイルで卓の下端（Hero の席）を覆うため、文書の末尾では通常の位置に戻る sticky にした。
- 席の配置は Hero を画面下の中央に置き、席順（時計回り）に並べる。席と Bet の位置は向き（単位円）だけを JS で出し、半径は画面幅ごとに CSS で決める（縦長のモバイルでは横の半径を詰めて画面外へ出さない）。

## コントラストの計算値（WCAG 2.1）

| 組み合わせ | 比 |
|---|---|
| on-surface / surface | 14.57 |
| on-surface-muted / surface | 8.14 |
| on-brand / brand-500（主ボタン） | 8.69 |
| 白 / danger-600（All-in） | 5.25 |
| on-felt / felt の中心（最も明るい端） | 5.12 |
| on-felt-muted / Pot の面（黒 28% を felt 中心に合成） | 6.45 |
| suit-red / card-face | 5.38 |
| brand-400（手番の文字） / surface | 9.97 |

- on-felt-muted を felt の中心に直接載せると 4.09 で 4.5 を割るため、Street の表示は on-felt にした。Fold 済みの席は透過で薄めると実額が 4.5 を割るため、透過をやめて沈んだ面＋破線の縁で退かせた。

## テスト

- `apps/web` に vitest（5.0.3。server と同じ版）を追加し、ルートの `pnpm test`（`pnpm -r test`）から走る。DOM 環境は足さず、部品は `react-dom/server` の文字列で確かめる。
- `lib/view-model.test.ts`: `selectLatestView`（古い View で巻き戻さない・別 Hand を捨てる）、`parseHeroView`（不正な data を捨てる）、`blindsOf`、`seatDirections`（Hero が真下・次の席が左）、`sizingPresets`（Pot 比の計算と min / max への丸め）、`describeEvent`（日本語 + Term と実額）。
- `components/components.test.tsx`: `Amount`（実額と BB）、`ActionBar`（Legal Action だけを出す・Slider の範囲・数値入力欄が無い・送信中は押せない）、`Table`（伏せた札・Fold 済みは札なし・公開札は表・Hero の札を卓に描かない・Stack / Pot / Bet / BTN / SB / BB / 手番）。

## 変更ファイル

- `apps/web/package.json`（`test` script、devDependencies に `vitest`・`@proj-poker/engine`）・`pnpm-lock.yaml`
- `apps/web/tsconfig.json`（`customConditions: ["@proj-poker/source"]`）
- `apps/web/src/App.tsx`・`main.tsx`・`styles.css`
- `apps/web/src/hooks/useHandSession.ts`（新規）
- `apps/web/src/lib/api.ts`・`format.ts`・`view-model.ts`（新規）・`view-model.test.ts`（新規）
- `apps/web/src/components/ActionBar.tsx`・`Amount.tsx`・`HandLog.tsx`・`PlayingCard.tsx`・`Table.tsx`・`components.test.tsx`（新規）
- `apps/web/src/testing/fixtures.ts`（新規）
- `docs/03_SYSTEM_ARCHITECTURE.md`（web の Engine 依存〔型だけ〕と Basic UI の構成）
- `docs/taskLog/issue-19-basic-ui.md`（本ファイル）・`docs/taskLog/assets/issue-19/*.jpg`（スクリーンショット）

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan）。
- `pnpm dev` を起動し、curl で Vite の proxy 経由の `POST /api/hands` と SSE（`event: view` が届く）を確認した。
- headless Chrome（Playwright がキャッシュしていた chrome-headless-shell）を CDP で操作するスクリプト（依存の追加なし・リポジトリ外）で、3 Hand を最後まで遊んだ:
  1. Check / Call で Showdown まで進める
  2. 最初の手番で Fold し、Hand の終了まで観戦する
  3. Raise（Slider / Preset の額）→ 以降は Check / Call
  - いずれも結果（獲得額）と「次の Hand へ」まで到達。ブラウザのコンソールのエラー・例外は 0 件。
  - 幅 390px（モバイル）で横スクロールが出ないこと、末尾までスクロールすると Hero の席が画面下の欄に覆われないこと、左右の席が画面内に収まることを座標で確認。
- 確認後に dev サーバーを停止した（3001 / 5173 が空いていることを確認）。

## 残課題

- 卓 UI 向けのデザイン体系（固有補強 md・トークンの確定）は #5。
- Chip Drag・Chip Click・Stack Composition（docs/06 §4）は Phase 4。
- Hover / Click で用語の Definition を出す（docs/06 §7）、Fast Forward（docs/06 §8）、BB 補助表示の設定（docs/06 §13）は未実装。
- Hand をまたいだ Stack の持ち越し（Session）はサーバー側の後続 Issue（現在は Hand ごとに全員 200 で始まる）。
