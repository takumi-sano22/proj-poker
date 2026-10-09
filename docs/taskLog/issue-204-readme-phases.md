# Issue #204: README を簡素化し Phase 0〜8 の実装履歴を docs に整理する

## 概要

Phase 8 までに 372 行・約 31,000 文字に膨らんだルート README を「入口」に戻し（Q1=A）、Phase ごとの履歴を `docs/phases/` に分けた（Q2=B）。README から外した手順の詳細は `docs/guides/` に移し、`docs/00` の索引と `release-readme-sync` skill を新しい構造に合わせた。ドキュメントの情報設計だけで、プロダクトのコード・判断・ゲーム仕様は変えていない。

## 初期調査・判断

- 基準の main は `610496c`（#208 の PR #210 のマージ）。README の冒頭の「現在の状態」が Phase 6 のまま、末尾が Phase 8 の記述で、現在地が読み取りにくかった。
- 移す先の決め方:
  - 起動・環境変数・Claude の認証・Solver・開発コマンド・E2E・手動の Eval → `docs/guides/SETUP_AND_DEVELOPMENT.md`
  - 画面の使い方と「制約・未実装」の全項目 → `docs/guides/USAGE_AND_LIMITATIONS.md`（各項目に正本の所在を付け、正本を優先すると明記）
  - 「できていること」の Phase ごとの節・MVP の完成条件 → `docs/phases/phase-N.md`
  - Claude / Solver / E2E を別ファイルにすると README → guides の導線が細かくなりすぎるので、手順は 1 ファイル、使い方と制約を 1 ファイルの 2 つにした。
- 移す前に、コマンドと既定値を実装と照合した: ルートと各パッケージの `package.json`（`eval:opponent-tournament`・`eval:review-tournament`・`smoke:claude`・`smoke:reveal`・`bench:memory` など README に無かった script を含む）、`.nvmrc`（24）、`apps/server/src/config.ts`・`index.ts`（環境変数の既定値。README の表に無かった `FAKE_REVIEW_ASSESSMENT` を足した）、`e2e/support/server.ts`（3101 / 5174）、`e2e/tests/` の 7 本の spec（README に無かった `review-tendency`・`session-end-layout`・`table-layout` を足した）、`apps/web/vite.config.ts`（proxy 先は `PORT`）、CI の job 名。
- 旧 README の制約の各項目を Explore で正本 docs と照合し、古くなっていたものを直した:
  - `buildApp` の Learning Reset Store の順序の源（#157）は PR #161 で解消済み → 制約から外した
  - Review の文の数値の機械照合（D125 で Phase 7 の範囲外）は D131（#168）で実装済み → 現状の記述に置き換えた
  - Tournament の Prompt の実モデル品質は未録画 → #202（D132）で録画済み。派生課題 #207（人間判断待ち）を制約として残した
- Phase 0〜5 の情報源は `docs/08`・親 #2 と子 Issue・`docs/taskLog/`・`gh pr list --state merged`。D 番号は主題だけを書き、原文は `decision_log.yaml` へのリンクにした。
- Phase 8 の後の横断（#179・#168・#202・#208）は Phase 9 を作らず、`phase-8.md` の末尾「Phase 8 完了後の横断整理」に置いた。
- `CLAUDE.md` の「Phase 最終 PR は `release-readme-sync` skill でルート README を更新する」は、skill が README と `docs/phases/` の両方を扱うようになっても誤りではなく、統制面なので変えていない。

## 変更内容

- `README.md`: 現在の状態（Phase 8 完了・Post-MVP 完了・#203 の受け入れテスト待ち）・誰のためのものか・主な機能・設計の原則・主な制約（要約）・最短の起動手順・文書の導線・技術構成・開発の進め方に絞った（372 行 → 97 行）
- `docs/phases/README.md`・`phase-0.md`〜`phase-8.md`（新規）: Phase の索引と、Phase ごとの目的と範囲・到達した機能・品質成果・重要な判断・Issue / PR / 作業ログ・引き継いだ事項。各ファイルの冒頭に「当時の履歴であり最新仕様の正本ではない」と明記
- `docs/guides/SETUP_AND_DEVELOPMENT.md`（新規）: 前提・起動・環境変数・Claude の認証・Solver・開発コマンド・E2E・手動の Smoke / Eval / 計測
- `docs/guides/USAGE_AND_LIMITATIONS.md`（新規）: 画面の使い方と、現在の制約と暫定値の一覧
- `docs/00_DOCUMENTATION_INDEX.md`: §3.1（README・guides・phases・taskLog は優先順位の外の入口・手順・履歴・記録）と §3.2（読む順番）を足し、§4 の表に 3 行足した。§3 の優先順位は変えていない
- `.claude/skills/release-readme-sync/SKILL.md`: README の「現在の状態」と `docs/phases/` を分けて更新する手順・責務の表・禁止事項・リンク検査に書き直した（description も）
- `.claude/skills/test-and-review/SKILL.md`・`sync-check/SKILL.md`: 判断 ID の範囲表記を D01〜D132 に同期。`sync-check` の進捗の置き場・`phase-planning` の Phase 完了の手順・`.claude/README.md` の skill の説明を新しい構造に合わせた

## 実行した確認

- リンク検査（scratch の一時スクリプト。相対リンクの存在と、GitHub の見出しの slug 規則でのアンカー）: 追加・変更した Markdown 20 ファイル（この作業ログを含む）で `checked=254 errors=0`。わざと壊したリンクとアンカーを検出することも確かめた
- `docs/phases/phase-0.md`〜`phase-8.md` の 9 件の存在を確認
- `pnpm lint`・`pnpm typecheck`・`pnpm format:check`（All matched files use Prettier code style!）・`pnpm test`（engine 480・web 160・server 902 passed）: すべて終了コード 0
- `grep -rn "D01〜D" --include=*.md --include=*.yaml .`（taskLog を除く）で範囲表記が D01〜D132 にそろっていることを確認

## 残課題

- `docs/01` FR-GAME-003・`docs/02` §6・`docs/06` §13 は Reload / Top-up を要件に挙げたままで、未実装である旨が正本に無い（README と guides は「Rebuy / Top-up はありません」と現状を書いた）。正本の要件の扱いは本 Issue の範囲外
- 人間の実機の受け入れテスト（#203）と、Tournament の Claude CPU の戦略品質（#207）は Open のまま
