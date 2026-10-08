# Phase 7 の分解（phase-planning）

## 概要

#104 の Phase 6 → 7 Gate（8 項目すべて人間がチェック済み）と #105 の Close（2026-10-08）を確かめ、`phase-planning` で Phase 7（#106）を子 Issue に分解した。人間判断（2026-10-08・AskUserQuestion）を D118〜D121 として記録する（P7-0・#135）。

## 起票した Issue（#106 の sub-issue・依存順・各本文に `Depends on`）

| ID | Issue |
|---|---|
| P7-0 | #135 Decision / Docs Sync（この PR） |
| P7-1 | #136 Fixed CPU Identity / Pool / Guest |
| P7-2 | #137 Observation を Event Log から決定論で抽出 |
| P7-3 | #138 Private Hypothesis / recency decay |
| P7-4 | #139 Memory → KnowledgeState / Prompt |
| P7-5 | #140 Tilt State Machine |
| P7-6 | #141 Table Tendency |
| P7-7 | #142 Opponent Policy / Eval |
| P7-8 | #143 Opponent Memory Reset / Rebuild |
| P7-9 | #144 Critical E2E / README |

## 人間判断（AskUserQuestion の回答。すべて推奨案）

- 永続化は抽出型。v10 の追記型 `session_participants`、Fixed Pool はコードの Version 付き Config（OI-005 の暫定値）、Observation は Event Log から決定論で抽出、Guest は Session 限りの Identity（D118）
- OI-011 の暫定値は指数減衰（半減期 150 Hand・Sample 15 × Skill 0.5〜1.5）と 0〜3 の整数 Tilt。順序は論理順序（D119）
- Opponent Memory Reset は v11 の追記型の区切りの表。全 CPU か 1 つの `cpuProfileId`。正本と User Read / Note / Tag は消さない（D120）
- P7-0〜P7-9 を直列。Memory は Evidence ID 付きの上限付き要約で KnowledgeState へ。LLM の呼び出しは増やさない（D121）

## 変更内容

- `docs/decision_log.yaml`: D118〜D121 を追記（既存の D は変えていない）
- `docs/04` §6・§11・§12、`docs/05` §4・§5、`docs/08` §3.1（子 Issue の表）、`docs/11` OI-005・OI-011（暫定値の注記。永久確定ではない）
- `docs/10`: 判断グループ表。範囲表記を D01〜D121 に（docs/00・docs/10・README・skill 2 つ）

## 調べた現状（起票の前提）

- CPU は席 id（`cpu1`…）と席順の Persona 割り当てだけで、永続 Identity・Observation・Memory は未実装（`apps/server/src/config.ts`・`review/evidence.ts`）。
- Persona の `tiltSusceptibility` / `recoverySpeed` は値だけで未使用。
- マイグレーションは v9 まで。`ordinals.kind` は CHECK で固定なので、Opponent Memory Reset の区切りは別の表の列で持つ（D120）。
- 「卓を離れる」API は無く、放置した Session は `SESSION_ENDED` を持たない。Guest の寿命・Tilt の Reset は「Session の終わり」に加え「次の Session で読まない」で担保する必要がある（#136・#140 で扱う）。

## 実行した確認

- `decision_log.yaml` が YAML として読め、末尾が D121（121 件）
- 範囲表記が D01〜D121 にそろっている（`grep -rn "D01〜D1"`）
- 品質チェック 4 つ: lint / typecheck / format:check は exit 0、`pnpm test` は engine 363・web 141・server 562 がすべて passed

## 残課題

- 子 Issue #136〜#144 を issue-worker 経路で順に実装する。
