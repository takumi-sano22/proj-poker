---
name: sync-check
description: 実装・設計書・Issue の三者整合を確認し、齟齬を修正してから実装計画を立てる（proj-poker 固有設定で拡張）。グローバルの sync-check（~/.claude/skills/sync-check）の手順を基本とし、このファイルで proj-poker 固有の補足を適用する。
---

# sync-check（proj-poker 固有補足）

グローバルの `~/.claude/skills/sync-check/SKILL.md` の手順を基本とする。以下の proj-poker 固有の情報を合わせて適用する。

## 三者整合の対象

| 対象 | 正本 / 場所 |
|---|---|
| docs/ 正本 | `docs/00_DOCUMENTATION_INDEX.md`（索引。矛盾時の優先順位はそこ）〜 `docs/11_OPEN_ITEMS.md` |
| 採用済み判断 | `docs/decision_log.yaml`（D01〜D117。**AI が上書き禁止**。記録・追記は `decision-log` skill） |
| 未確定事項 | `docs/11_OPEN_ITEMS.md`（OI-NNN） |
| Issue | MVP（Phase 0〜5）は親 Issue #2（MVP Parent・Close 済み）。Post-MVP（Phase 6〜8）は Post-MVP Parent #104 と Phase Parent #105〜#107 の DoD・Phase Gate と sub-issue（D102） |
| 実装 | リポジトリのコード（現在は実装前。Phase 0 以降で増える） |

齟齬を見つけたら、docs/ 正本と `decision_log.yaml` を優先して実装・Issue を直す。`decision_log.yaml` の既存判断の上書きや Open Item の永久確定が必要な齟齬は、修正せず人間確認に回す。

## 設計書ディレクトリ

| ファイル | 内容 |
|---|---|
| `docs/00_DOCUMENTATION_INDEX.md` | 索引・文書間の優先順位 |
| `docs/08_MVP_AND_ROADMAP.md` | Phase 0〜8・MVP スコープ・実行順 |
| `docs/03_SYSTEM_ARCHITECTURE.md` / `docs/04_DATA_AND_EVENTS.md` | アーキテクチャ / データ・イベント |
| `docs/09_TEST_STRATEGY.md` | テスト戦略 |
| `docs/10_DECISION_TRACEABILITY.md` | 判断と文書のトレーサビリティ |
| `docs/decision_log.yaml` / `docs/11_OPEN_ITEMS.md` | 採用済み判断 / 未確定事項 |
| `docs/taskLog/` | 作業ログ（参照のみ・修正対象外） |

Step 3（設計書の全確認）では、上記ファイルを優先的に確認する。

## Phase の進捗の置き場

進捗は **親 Issue（MVP は #2、Post-MVP は #104 と #105〜#107）の DoD チェックボックスと sub-issue の状態**、および Phase 完了時のルート README（`release-readme-sync`）にだけ置く。**正本 docs（`docs/08_MVP_AND_ROADMAP.md` 等）に進捗記法（⏳ / ✅ 等）を書き込まない**（仕様文書に第 3 の進捗置き場を作らないため）。Step 4-a で正本 docs を直すのは、仕様の齟齬を解消するときだけ。

## Issue の命名規則・処理ルール

- タイトルは必ず `[PhaseN]`（N は 0〜8）または `[横断]` で始まる（一次情報は CLAUDE.md）
- Phase に属する Issue は、その Phase の親（Phase 0〜5 は #2、Phase 6〜8 は #105〜#107）の sub-issue になっていること（未紐付けなら `create-issue` skill 手順7 で紐付ける）
- Close コメントには、理由として判断 ID（`Dxx`）またはマージ済み PR 番号を必ず記載する

```bash
gh issue list --state open --limit 200
# MVP（Phase 0〜5）は #2、Post-MVP は #104 と Phase 親 #105〜#107 の配下を見る
for p in 2 104 105 106 107; do
  echo "== #$p"
  gh api repos/takumi-sano22/proj-poker/issues/$p/sub_issues --jq '.[] | "\(.number)\t\(.state)\t\(.title)"'
done
```

## Open Issue の分類観点

Step 2（Open Issue の全件確認）では、以下の観点を優先的に確認する:

1. **Phase 完了済みなのに紐づく Issue が残っている** → コメント付き Close（その Phase の親 Issue の DoD チェックも更新）
2. **`decision_log.yaml` の判断で却下された Phase/機能の Issue** → 判断 ID を明記して Close
3. **先行スライスとして実装済みのもの** → PR 番号を明記して Close
4. **進行中 Phase の Issue**（現在の最前線は `docs/08_MVP_AND_ROADMAP.md` で確認）→ Open のまま維持
5. **wait / 後回し タグが付いている Issue** → Close せずそのまま維持
6. **Open Item（`docs/11_OPEN_ITEMS.md`）の解決が前提の Issue** → OI-NNN を明記してブロック中として維持
