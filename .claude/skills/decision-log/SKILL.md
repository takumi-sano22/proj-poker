---
name: decision-log
description: proj-poker の人間判断と未確定事項を扱う skill。docs/decision_log.yaml（D01〜の採用済み人間判断）への新規判断の追記、docs/11_OPEN_ITEMS.md（OI-xxx）の暫定値の置き方・確定時の移し替え、実装中に人間判断が必要な論点を見つけたときの止まり方を定める。「判断を記録して」「decision log に追加」「Open Item を確定」「OI を閉じる」「この仕様は決まってる？」「人間判断が要る」で起動する。移設元は adr-log。
model: haiku
---

# decision-log — 人間判断と Open Items の運用

proj-poker の仕様の最上位は `docs/decision_log.yaml`（採用済みの人間判断）で、`docs/00_DOCUMENTATION_INDEX.md` §3 の優先順位の 1 位にあたる。**AI はここに書かれた判断を上書きしない。新しい判断を勝手に足さない。** 本 skill は、記録してよい場面・記録の形式・止まるべき場面を定める。

## いつ使うか

| 場面 | 何をするか |
|---|---|
| セッション冒頭の `AskUserQuestion` で人間が判断した | 回答のうち**仕様・方針に関わるもの**を D 番号で追記する（下記「追記手順」） |
| 実装中に、docs で決まっていない論点に当たった | 可逆なら Open Item 方式で暫定値を置いて進む。不可逆・方針に関わるなら停止して人間へ返す（下記「実装中の判断」） |
| Open Item（OI-xxx）が PoC などで決まった | 人間の確認を経てから D 番号で追記し、`11_OPEN_ITEMS.md` の該当項目に解消済みの注記を付ける |
| 既存の D 番号と矛盾する実装・要望が出た | **実装で吸収しない**。矛盾点を PR / Issue コメントに残して停止する（`github-workflow`「必ず人間確認で停止する条件」） |

## 実装中の判断（自走中の止まり方）

1. **docs の正本を優先順位どおりに確認する**（`decision_log.yaml` → `01` → `02` … → `research/*`）。`research/*` は根拠資料であって仕様ではない。
2. **決まっていなければ可逆性で分ける**:
   - **可逆**（Config・Preset・定数で差し替えられる。例: OI-003 Rake Preset、OI-004 Chip 額面、OI-005 CPU 人数）→ Config に暫定値を置いて進んでよい。コードコメントと PR 本文に「`OI-xxx` の暫定値。確定ではない」と書く。**暫定値を永久仕様として docs に書かない。**
   - **不可逆・方針に関わる**（データモデルの形・永続化スキーマ・情報境界・MVP スコープ・非目標の導入）→ 停止する。論点・選択肢・推奨案を Issue コメントに残し、次セッション冒頭の `AskUserQuestion` に回す。
3. `11_OPEN_ITEMS.md` の末尾「すでに確定しており、Routine Implementation で再検討しない項目」は再検討しない。

## 追記手順（人間が判断した後だけ）

1. 最新を取得する: `git fetch origin && git show origin/main:docs/decision_log.yaml | grep -o "id: D[0-9]*" | tail -1`。番号は **origin/main の最大番号 + 1**。直書きしない（他セッションとの衝突を避けるため。push 直前にもう一度確認する）。
2. 既存の形式に合わせて末尾へ追記する:

   ```yaml
   - id: D67
     choice: "<選んだ選択肢。AskUserQuestion の場合は選んだラベルの要約>"
     status: "採用済み"
     decision: "<日本語 1〜2 文。何を採用したか>"
   ```

   - 既存 D の内容を変える判断なら、既存行は消さずに新しい D を足し、`decision` に「D28 を変更」のように書く。旧 D の `status` を `"D67 で変更"` に更新する（履歴を残すため）。
3. 判断が影響する正本 docs（`01`〜`09`）と `10_DECISION_TRACEABILITY.md` の判断グループ表を同じ PR で更新する。Open Item を解消した場合は `11_OPEN_ITEMS.md` の該当節に `→ D67 で確定` と追記する（節は削除しない）。
4. ファイル先頭のコメント（`D01〜D66 の採用済み人間判断`）の範囲表記も更新する。

## やってはいけないこと

- 会話で決まっていない判断を、AI の推測で D 番号として記録する。
- 実装の都合（「この方が楽」）で Open Item を確定扱いにする。
- `research/*` の一般論を根拠に、採用済み判断を上書きする。
- 記録だけの PR に見えても `decision_log.yaml` を記録系 docs として Codex スキップ扱いにする（正本なので通常どおりレビューする。`github-workflow/references/codex-review.md`「記録系 docs の Codex スキップ」）。

## 完了条件

- 追記した D 番号が origin/main の最大 + 1 で、既存と衝突していない。
- 影響する docs・`10_DECISION_TRACEABILITY.md`・`11_OPEN_ITEMS.md` が同じ PR で同期している。
- 暫定値で進めた箇所には OI 番号のコメントが付いている。
