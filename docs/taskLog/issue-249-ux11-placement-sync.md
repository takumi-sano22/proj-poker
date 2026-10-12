# Issue #249: UX11 配置判断（UX11-placement=A）の正本化と Track A 現行資料の整合

## 目的

#226 で人間が承認した UX11-placement=A（#226 issuecomment-6111020291。RULING / ETIQUETTE の欄は今の Hero 欄の操作の場所で受け入れる）を
`docs/decision_log.yaml` に D 番号で記録し、#218・#222・#223・#226 の完了後も残っていた「未実装」「Draft・マージ待ち」「Gate 1 未解除」の古い記述を
現行の状態に合わせる。新しいゲームの機能・Event・API・DB・表示仕様は採用しない。製品コードは変えない。

## 変更内容

1. `docs/decision_log.yaml`: origin/main の最大 D146 の次として **D147** を追記（UX11-placement=A。中央は必須にしない・#224 で中央の演出を検討するときは
   Board / Pot / 席 / Hero の視認性・hit-test・今の Ack の導線を壊さない・寸法は OI-012・D142 / D145 は変えない）。D142・D145 など既存の D は編集しない。
2. D 番号の範囲表記（D01〜D146 → D01〜D147）: `decision_log.yaml` 先頭・`README.md`・`docs/00`・`docs/10`・`sync-check` / `test-and-review` skill。
3. `docs/10`: D147 の行を追加し、Q28・Q29 の対応に「欄の配置は D147」を足した。
4. `docs/06` §16: 冒頭の「UX-08〜UX-11 は未実装」を、#223（素材の納品。組み込みは #224 / #225）と #226（§16.5 の実装）が完了し、
   #219・#220・#224・#225 が未実装である区別に直した。§16.5 の実装の段落と §16.8 の UX-11 の行に PR 番号（#244 / #247）と D147 を足した。
5. `docs/11` OI-012: 確定に D147 の配置、未確定に欄の寸法・余白（可逆）、UX-11 の行に実装 PR と D147 を足した。
6. `.claude/skills/ui-design-recipes/references/proj-poker.md`: 「設計のみ・まだ実装していない」を、実装済み（#218・#222・#226・#223 の納品）と
   未実装（#219・#220・#224・#225）を行ごとに区別する表へ更新し、実在するファイル（`AppShell.tsx`・`usePresentation.ts`・`DealerOverlay.tsx` 等）と
   トークン（`--color-feedback-*`・`PRESENTATION_*`・`RULING_OVERLAY_MS`）に合わせた。
7. `docs/assets/casino-v2/HANDOFF.md`: 「Draft PR #239」「マージ前」「#223 Open」「Gate 1 未解除」を、#239 MERGED `bbd1c3e`・#223 Closed・Gate 0 / 1 解除済み・
   Gate 2 未解除に直した。素材のバイナリ・`manifest.json`・SHA-256 は変えていない。

## 変更ファイル

`docs/decision_log.yaml`・`docs/00_DOCUMENTATION_INDEX.md`・`docs/03_SYSTEM_ARCHITECTURE.md`（横断 UI/UX の段落の範囲表記）・`docs/06_UI_UX.md`・`docs/10_DECISION_TRACEABILITY.md`・`docs/11_OPEN_ITEMS.md`・
`docs/assets/casino-v2/HANDOFF.md`・`README.md`・`.claude/skills/{sync-check,test-and-review}/SKILL.md`・
`.claude/skills/ui-design-recipes/references/proj-poker.md`・本ログ

## 判断理由

- D147 の内容は #226 の人間判断のコメントと #249 の WHAT に書かれた範囲に限り、AI の推測で項目を足していない。
- 配置の判断は D142（順序）・D145（Ack の契約）を変えないので、既存 D の status は変えず「具体化」として記録した。
- 古い作業ログ（検証当時の taskLog）は遡って書き換えず、本ログを新規に作った。

## 実行した確認

- `grep -rn "D01〜D1" --include=*.md --include=*.yaml .`（taskLog 以外の範囲表記が D147 にそろうこと）
- `grep -o "id: D[0-9]*" docs/decision_log.yaml | sort | uniq -d`（D 番号の重複なし）
- `pnpm format:check`・`pnpm lint`・`pnpm typecheck`・`pnpm test`（結果は PR の Test plan に記載）

## 残課題

- #219（UX-04）の本実装は別 PR。#224 で中央の演出を検討するときは D147 の条件に従う。
