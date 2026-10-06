# Issue #62: Chip の額面 Preset と Stack の構成表示を作る

## 概要

Phase 4（Live Mechanics）の最初の PR。Chip の額面 Preset（1 白・5 赤・25 緑・100 黒・500 紫。D92・OI-004 の暫定値）を Table Config に置き、額から Chip の構成（額面ごとの枚数）を組む決定論の関数 `composeChips` と、席の Stack と Bet を色付きの積みで描く表示（`ChipStack`）を作った。あわせて Phase 4 冒頭の人間判断 D89〜D93 を `docs/decision_log.yaml` に記録し、範囲表記と OI-004 / OI-008 の注記をそろえた。Event・`schema_version`・永続化スキーマ・既存の Action 入力（ActionBar）は変えていない。

## 初期調査

- 前提（main 28cf0a3）: Table の Stack・Bet は実額 + BB 補助（D49）で、Bet は単色の `ChipIcon` 1 個だった。Chip の額面・構成を持つコードは無い。
- `TableConfig` は `HAND_STARTED` に項目を選んで写す（Blind・oddChipRule・reopenRule）だけなので、`chipDenominations` を足しても Event の形は変わらない（buttonRule と同じ扱い）。
- Web は `@proj-poker/engine` を型だけ import していた（Vite の既定の解決では `dist` を見るため、build しない dev で実行時の値は読めない）。額面と構成の関数を Web で使うため、`vite.config.ts` に `@proj-poker/source` 条件（`resolve.conditions` と Vitest 用の `ssr.resolve.conditions`）を足し、サーバーの `vitest.config.mjs` と同じ書き方にそろえた。ブラウザが使う Engine の値は額面と構成の関数だけ（tree-shaking でほかの Engine は入らない。`vite build` で確認）。

## 変更内容

- `packages/engine/src/chips.ts`（新規）: `ChipColor`・`ChipDenomination`・`ChipCount`・`DEFAULT_CHIP_DENOMINATIONS`（1 白・5 赤・25 緑・100 黒・500 紫）・`composeChips(amount, denominations?)`（大きい額面から貪欲。枚数 0 は含めない。不正な額・不正 / 重複した額面・1 が無くて組めない額は `RangeError`。黙って額を変えない）。
- `packages/engine/src/table-config.ts`: `TableConfig.chipDenominations` と `PHASE1_CASH_PRESET` の値を追加。`index.ts` から公開。`hand-engine.test.ts` の `TableConfig` 直書き 2 か所に項目を足した。
- `packages/engine/src/chips.test.ts`（新規）: Preset の値、構成の固定値、不正入力、Property（構成の合計 = 額・枚数は 1 以上の整数・額面は大きい順で重複なし・下の額面は 1 つ上の額面に満たない・貪欲の枚数が動的計画法の最小枚数と一致）。
- `apps/web/src/components/ChipStack.tsx`（新規）: 額面ごとの積みを CSS で描く（D60）。1 本に重ねるのは最大 5 枚で、超える枚数は `×N` を積みの上に出す。額面と枚数は `data-denomination` / `data-count` と `title` に持ち、見た目は `aria-hidden`（実額は隣に常時出る。D49）。
- `apps/web/src/components/Table.tsx`: 席の Stack の下と Bet に `ChipStack` を置く。`Amount.tsx` の `ChipIcon` は使わなくなったので削除。
- `apps/web/src/lib/config.ts`: `CHIP_DENOMINATIONS`（`PHASE1_CASH_PRESET.chipDenominations`）。額面・色の対応は Config 側で、コンポーネントは直書きしない。
- `apps/web/src/styles.css`: `--color-chip-<色名>` / `-edge` のトークン 5 色、`.chip--<色名>`、`.chip-stack` / `.chip-column`、寸法 `--chip-d` / `--chip-step`（狭い画面は小さく）。旧 `--color-chip` / `--color-chip-edge` は不要になり削除。
- `apps/web/src/components/components.test.tsx`: `ChipStack`（構成と色、0 は描かない、枚数上限と `×N`、渡した額面に従う、Preset の全色に CSS の定義がある）、Table に Stack / Bet の積みが出ること。
- docs: `decision_log.yaml` に D89〜D93 を追記し、範囲表記を D01〜D93 に（decision_log 先頭・docs/00・docs/10・README）。docs/10 の判断グループ表に D89〜D93 の行。docs/11 の OI-004 と OI-008 に「暫定値は D92 / D91（確定ではない）」の注記。docs/03（Engine の入口と Web の components）と docs/06 §4 に Stack Composition 表示の実装を追記。

## 判断理由

- **構成は表示用で、額の正本ではない**: Pot・Stack・Bet は整数の額のまま（D74）。構成を保存せず、Event にも持たせない（Event / スキーマの変更は #64 の範囲）。
- **色は名前だけを Config に置く**: 実際の色の値は CSS のトークン（D60 の Theme 変更可能）。Preset の色名と CSS のずれは、全色に CSS の定義があることを確かめるテストで拾う。
- **貪欲法でよい根拠**: 1 / 5 / 25 / 100 / 500 は貪欲が最小枚数になる（動的計画法との一致を Property Test で確認）。ほかの額面に差し替えても枚数の最小は保証しないが、合計 = 額は保つ。
- **積みの枚数に上限（5）**: 大きい Stack（例 98 万）で何百枚も描かないため。上限を超える枚数は `×N` で示す。
- **Pot の積みは今回は描かない**: Issue の範囲は Stack と Bet。
- README の「現在のフェーズ」は Phase 3 の到達点のままにした（Phase 最終 PR #68 で更新する。`release-readme-sync`）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート）。結果は PR 本文の Test plan に記す。`pnpm --filter @proj-poker/web build` が通る。
- UI の実測（Playwright / Chromium。dev サーバーは確認後に停止）: 6 人卓を PC（1280px）とモバイル（390px）で開き、Stack と Bet の積みが出ること、Fold した席・Bet の位置・席の重なりが従来と変わらないことを確認した。モバイルの Bet とストリート名の重なりは変更前（main）にもあった。
- 8 席・極端な額（Stack 987,654 / Bet 1,500 / Stack 0）は、`renderToStaticMarkup` の出力に `styles.css` を当てた静的ページで PC（1000px）とモバイル（390px）を確認した（実際の卓は `TABLE_SIZE` の起動設定で決まるため）。大きい額でも積みは 5 枚までで `×N` が積みの上に出て、隣の積みと底がそろう。8 席のモバイルで左端の席が画面の端に接するのは従来の配置（`--seat-rx`）によるもの。

## 残課題

- Chip の Click・Drag・Betting Area への投入は #65、Ruling は #63、宣言・物理操作・裁定の Event（版 5）は #64。
- `.claude/skills/` 内の範囲表記（D01〜D88）は本 PR の範囲外。親が更新する。
- 暫定値（額面・色）は OI-004 のまま。人間が確定するまで永久仕様にしない。
