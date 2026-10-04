---
name: release-readme-sync
description: Phase完了（PRマージ）時に使用する。ルートREADME.mdを現Phase到達点（動く範囲・セットアップ・制約）へ更新する定型手順。
model: haiku
---

# release-readme-sync Skill

## トリガー

- Phaseの最終PR（または複数PRのまとまり）がmainにマージされた時
- ルートREADMEのPhase記載が現状と乖離していると気づいた時

## 役割

ルート `README.md` の「現在の状態」「現在のフェーズ」と MVP 進捗を、マージ済みの実装・親 Issue #2 の DoD チェックと一致した状態に保つ。古い Phase 記述や、未マージの機能を「実装済み」とする記述を残さない。

## 手順

1. **現在地の確認**
   - 直前にマージされた PR の内容を確認する
   - `docs/08_MVP_AND_ROADMAP.md` で該当 Phase（Phase 0〜8）の完了条件を確認する
   - 親 Issue #2 の DoD チェックリストを確認し、完了した項目がチェック済みか確認する（未チェックなら親 #2 側を更新する提案を出す）

2. **ルートREADMEの更新**
   - 「現在の状態」セクション（無ければ「現在のフェーズ」に併記）を最新 Phase の到達点（動く範囲・セットアップ・制約）に更新する
   - 「現在のフェーズ」セクションの Phase 番号・名称を `docs/08_MVP_AND_ROADMAP.md` と一致させる
   - MVP 進捗（「MVPの完成条件」と親 #2 の DoD の達成状況）を更新する
   - 設計書への参照が `docs/`（索引 `docs/00_DOCUMENTATION_INDEX.md`）を指しているか確認する
   - セットアップ手順は Phase 0 で確定後に追記される想定。確定済みなら最新の手順と一致させる（未確定のコマンドを推測で書かない）

3. **チェックリスト**
   - [ ] 「現在のフェーズ」が `docs/08_MVP_AND_ROADMAP.md` の現在地と一致している
   - [ ] 「現在の状態」がマージ済みの実装と一致している（未マージの Phase の機能を「実装中」「実装済み」と書かない）
   - [ ] MVP 進捗が親 #2 の DoD チェックと一致している
   - [ ] 設計書の出典が `docs/` を指している
   - [ ] 「制約・未実装」の記述が現状と一致している

4. **競合留意**
   - `README.md` は複数セッションが触れることがある
   - `git pull` で最新状態を取得してから編集する
   - 編集前に他のブランチが `README.md` を変更していないか確認する

## 完了条件

- ルート README の現在地（フェーズ・状態・MVP 進捗・制約）が最新 Phase と親 #2 の DoD に一致している

## 出典

- `docs/08_MVP_AND_ROADMAP.md`（Phase 定義・完了条件）
- `docs/decision_log.yaml`（採用済み判断。README 記述が矛盾しないこと）
- 親 Issue #2（MVP Parent・DoD チェックリスト）
