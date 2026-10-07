# Issue #110: harness の進捗管理の親を Post-MVP（#104〜#107）に合わせる

## 概要

harness は進捗管理と sub-issue の紐付け先を「親 Issue #2（MVP Parent）」としていた。#2 は Phase 5 の完了で Close 済みで、Post-MVP は Post-MVP Parent #104 と Phase 親 #105〜#107 で管理する（D102）。PR #109（#108）の Codex の [P1] を受けた same-root sweep の分離分。

## 変更内容

- `CLAUDE.md`: 進捗管理の親（MVP は #2、Post-MVP は #104 の下の #105〜#107）、Post-MVP の実装開始ゲート（#104 の実装開始 Gate と前 Phase の Phase Gate）、積み残しの紐付け先。
- `.claude/README.md`: phase-planning・issue-patrol の説明。
- `phase-planning`: Phase と親・DoD / Gate の対応表、Post-MVP の実装開始ゲート、DoD の突き合わせ・既存の子 Issue の確認・Scope Creep の除外・起票と紐付け・完了判定を親ごとに読み替え。
- `create-issue`: 手順 7 の紐付け先（Phase 6〜8 は #105〜#107、Post-MVP の横断は #104）とコマンド例。
- `issue-patrol`: 紐付けの確認先と sub-issue の取得コマンド（#2・#104〜#107）、停止ゲート。
- `github-workflow`: 実値・Issue 起票の入力・停止条件のゲート。
- `release-readme-sync`: 進捗の照合先を Phase の親の DoD と #104 の Phase Gate に。

## 判断理由

- MVP の記述（#2 の Gate 等）は履歴として残し、Post-MVP の親を並べる形にした（#2 を消すと Phase 0〜5 の記録が読めなくなる）。
- `add-skill` の「#2」は品質チェックリストの番号、ルート `README.md` の #2 は MVP の到達点の記述なので変えない。

## 実行した確認

- `grep -rn "#2\b\|issues/2/" CLAUDE.md .claude/`（worktrees を除く）で、残りが MVP を指す正しい記述だけであること。
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（結果は PR に記載）。

## 残課題

- なし（Phase 6 の分解は phase-planning で次に行う）。
