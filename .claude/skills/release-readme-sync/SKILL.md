---
name: release-readme-sync
description: Phase（またはそれに相当するまとまり）の完了時に使う。ルート README の短い「現在の状態」と、docs/phases/ の Phase 履歴を分けて更新し、guides の制約・Domain docs・Decision Log との整合とリンクを確かめる定型手順。README に Phase の作業履歴を積み増さない。
model: haiku
---

# release-readme-sync Skill

## トリガー

- Phase の最終 PR（または複数 PR のまとまり）が main にマージされた時
- ルート README の「現在の状態」や `docs/phases/` が現状と乖離していると気づいた時

## 責務の分担（どこに何を書くか）

| 置き場 | 書くこと | 書かないこと |
|---|---|---|
| 1. ルート `README.md` | 短い「現在の状態」（到達した Phase・いまできること・残る受け入れ作業）と「主な制約」の数行の要約 | Phase ごとの作業の履歴・Issue / PR / D 番号の大量の列挙・詳細な仕様・環境変数の詳細 |
| 2. `docs/phases/` | その Phase（または Release）の履歴: 目的と範囲・到達した機能・品質成果・D 番号の参照・Parent / Issue / PR / taskLog・引き継いだ事項。`docs/phases/README.md` の一覧に 1 行 | D 番号の原文の複製・最新仕様の再定義・taskLog の全文の転載 |
| 3. Domain docs（`docs/01`〜`09`） | 最新の仕様（必要なときだけ。実装の PR で直すのが原則） | 進捗の記法（⏳ / ✅ 等） |
| 4. `docs/decision_log.yaml` | 人間判断の正本（`decision-log` skill だけが追記する） | この skill からの追記・書き換え |
| 補. `docs/guides/` | 現在の制約と暫定値の一覧（`USAGE_AND_LIMITATIONS.md` §2）・コマンドと既定値（`SETUP_AND_DEVELOPMENT.md`） | 履歴 |

## 手順

1. **現在地の確認（更新の前に必ず）**
   - `git fetch origin && git log --oneline origin/main -5` で最新の main を確認する
   - 直前にマージされた PR の内容を確認する
   - `docs/08_MVP_AND_ROADMAP.md` で該当 Phase の完了条件と Gate（§3.2）を確認する
   - その Phase の Parent Issue（MVP は #2、Post-MVP は #104 と Phase Parent）の DoD と Gate のチェックを `gh issue view` で確認する。未チェックなら「完了」と書かず、親側の更新を提案する（Gate のチェックは人間だけが行う）

2. **`docs/phases/` に履歴を足す**
   - `docs/phases/phase-N.md` を、既存のファイルと同じ構成（冒頭の「当時の履歴であり最新仕様の正本ではない」の注記・目的と範囲・到達した機能・主要な品質成果・重要な判断・Issue / PR / 作業ログ・次へ引き継いだ事項）で作る
   - `docs/phases/README.md` の一覧に 1 行足す。前の Phase のファイルの「次」へのリンクを足す
   - Phase に属さない横断の整理は、新しい Phase を作らず、直前の Phase のファイルの末尾の節にまとめる
   - 過去の Phase のファイルは、誤記・リンク切れの修正を除いて書き換えない

3. **ルート README の「現在の状態」を更新する**
   - 到達した Phase と、いまできることを数行で書き換える（積み増さず、置き換える）。過去の Phase を「現在」と書いたまま残さない
   - 「主な制約」は数行の要約に保ち、詳細は `docs/guides/USAGE_AND_LIMITATIONS.md` §2 を更新する
   - 起動手順・コマンドは、ルートと各パッケージの `package.json` の scripts・`.nvmrc`・`apps/server/src/config.ts` と一致させる（存在しないコマンドを推測で書かない）。詳細は `docs/guides/SETUP_AND_DEVELOPMENT.md` を直す

4. **整合とリンクの検査**
   - 判断 ID の範囲表記（`D01〜Dnn`）を `grep -rn "D01〜D" --include=*.md --include=*.yaml .` でそろえる
   - 追加・変更した Markdown の相対リンクとアンカーを機械的に検査し、リンク切れ 0 件を確認する（一時スクリプトでよい。リポジトリに依存を足さない）
   - `pnpm format:check` を通す

5. **チェックリスト**
   - [ ] README の「現在の状態」が最新の main・`docs/08` の現在地・Parent の DoD / Gate と一致している（未マージ・未確認の機能を「実装済み」「完了」と書かない）
   - [ ] README に Phase の作業履歴や Issue / PR / D 番号の大量の列挙を戻していない
   - [ ] `docs/phases/` に今回の Phase のファイルと一覧の行がある
   - [ ] Phase の履歴と最新仕様を混同していない（履歴に最新仕様を再定義しない・README や guides に履歴を書かない）
   - [ ] `USAGE_AND_LIMITATIONS.md` §2 の制約が現状と一致し、解消した制約を残していない
   - [ ] リンク切れが 0 件

6. **競合留意**
   - `README.md`・`docs/phases/README.md` は複数のセッションが触れることがある。編集前に最新の main を取り込み、他のブランチの変更を確認する

## 完了条件

- ルート README の現在地が最新の Phase とその Parent の DoD に一致し、`docs/phases/` に当該 Phase の履歴があり、リンク切れが無い

## 出典

- `docs/08_MVP_AND_ROADMAP.md`（Phase 定義・完了条件・Phase Gate）
- `docs/00_DOCUMENTATION_INDEX.md` §3.1（README・guides・phases・taskLog の役割）
- `docs/decision_log.yaml`（採用済み判断。記述が矛盾しないこと）
- Parent Issue #2（MVP）、Post-MVP Parent #104 と Phase Parent #105〜#107
