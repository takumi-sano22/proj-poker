# Issue #5: ui-design-recipes skill を卓 UI 向けに改良する

## 概要

#3 で汎用のまま移設した `ui-design-recipes` skill を、proj-poker の卓 UI 向けに改良した。#5 の最後の PR（`Closes #5`）。375px の重なりの修正は、先に #101・#102 で入れた（作業ログ `issue-5-table-ui-narrow-overlap.md`・`issue-5-bet-placement-seat-count.md`）。

## 人間判断（セッション冒頭の AskUserQuestion）

- #5 の範囲は「skill の改良と、375px の重なりの修正」。重なりは別の PR で直す。
- 卓 UI に不要な汎用 reference（chat-thread・admin-dashboard・code-block・screen-mimic）は削除する。

## 変更内容

- `references/proj-poker.md`（新規）: 固有補強。位置づけと優先順位、CSS 方式（素の CSS・Tailwind なし）とトークン名、既存部品の対応表、画面幅と卓の配置規則（719/720 の境界、狭い画面の結果・障害ダイアログは Hero 欄、Bet は席の面の中、中央の積み方、`flex: none`）、固有の規律（実額常時表示 D49 ほか）、重なりの測り方、出典の対応表、既知のずれ。トークンの実際の値は `styles.css` を正本にし、写していない。
- 削除: `references/layout/chat-thread.md`・`references/layout/admin-dashboard.md`・`references/content/screen-mimic.md`・`references/content/code-block.md`。
- `SKILL.md`: 位置づけを確定版にした（`proj-poker.md` を先に読む）。対応表の先頭に卓 UI の行を足し、削除した 4 本の行を外した。鉄則の前置き（管理画面は 1〜3 を適用しない）を外した。
- 削除した reference への参照を外した: `references/README.md` の構成図、`emoji-and-icons.md`・`app-shell-responsive.md`・`hover-and-press.md` の出典の括弧。
- `CLAUDE.md` の routing と `.claude/README.md` の skill 一覧の「現状は汎用版（#5 で改良）」を更新した。

## 判断理由

- 色の値を `proj-poker.md` に写さないのは、`styles.css` と二重管理になり、片方だけ直されてずれるため。トークン名と役割だけを書き、値は実装を読ませる。
- 配置規則と測り方は、#101・#102 で実測から決めたもの。次に卓 UI を触るときに同じ重なりを作らないよう、skill から辿れるようにした。

## 実行した確認

- `proj-poker.md` が挙げたトークン 11 個（`--color-surface-sunken`・`--shadow-turn`・`--seat-ry` ほか）が `styles.css` に定義されていること、部品・hook・lib のファイル 26 本が存在すること、`CENTER_STACKED_SEAT_COUNTS`・`BetPill`・`betInside`・`.bet--inside`・`.result--docked`・`.outage--docked`・`.declaration__bb` が実装にあることを grep / ls で確かめた。
- 削除した 4 本への参照が `.claude/`・`CLAUDE.md`・`AGENTS.md`・`docs/`（作業ログを除く）に残っていないことを grep で確かめた。
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR の Test plan）。

## 残課題

- 狭い画面で裁定があるときの Hero 欄 +106px、320×568 で Hero 欄が画面の 7〜9 割を占める件（`proj-poker.md` の「既知のずれ」に記載）。
- #101・#102 の review-learning の Capture 4 件（area ui-table）の台帳への蒸留は `review-distillation` で別途。
