# Phase 8 の分解（phase-planning）

## 概要

#106 の Close と #104 の Phase 7 → 8 Gate（すべて人間がチェック済み）を確かめ、`phase-planning` で Phase 8（#107）を子 Issue に分解した。実装前の人間判断（2026-10-09・AskUserQuestion）を D127〜D130 として記録する（P8-0・#182）。機能実装は含めない。

## 起票した Issue（#107 の sub-issue・依存順・各本文に `Depends on`）

| ID | Issue |
|---|---|
| P8-0 | #182 Decision / Docs Sync（この PR） |
| P8-1 | #183 Tournament Mode / Session Model / Preset |
| P8-2 | #184 Blind / Ante（hand-count・time-base・BBA） |
| P8-3 | #185 Elimination / Position / Tournament Progression |
| P8-4 | #186 Payout / Tournament Result |
| P8-5 | #187 Deterministic ICM Calculator |
| P8-6 | #188 Tournament KnowledgeState / CPU Adaptation |
| P8-7 | #189 Tournament Review / ICM Evidence |
| P8-8 | #190 Tournament UI |
| P8-9 | #191 Tournament Critical E2E / README |

## 人間判断（AskUserQuestion の回答）

- 標準 6-max STT の暫定値: Starting Stack 1,500・Blind 10/20 から 10 Hand ごと・BBA の額は BB と同じ・参加費 100pt × 参加人数（推奨案。D127。OI-007）
- Ante は TDA 準拠の Dead Money（BBA は Blind を先に払う・Main Pot へ）。time-base は Core に加えて UI でも選べる Preset にする（推奨案ではなく「時間も UI で選べる」を選択。D128）
- Hero の Bust で Tournament を終える。Tournament は Event Log だけに残し、Projection は都度計算。終了理由は既存の値を使う（推奨案。D129）
- ICM は全席の Equity・Bubble Factor・All-in の必要 Equity まで構造化して CPU と Review に渡す（推奨案。D130）

## 質問せずに暫定値とした項目（OI-007 の Version 付き暫定 Policy。確定ではない）

Codex の P1（#192）を受け、「一意に決まる」とは扱わず、人間判断を経ていない暫定値として docs/02 §7・docs/11 OI-007 に明記した。

- 同じ Hand の複数 Bust の順位（開始時の Stack が多い方が上位・同じなら同順位で賞金を合算して等分。TDA）
- Payout の端数（切り捨て・余りは上位から。同順位の余りは席順。D75 と同じ考え方）
- ICM の方式（Malmuth-Harville・倍精度・許容誤差つきのテスト・表示は丸め）

## 変更内容

- `docs/decision_log.yaml`: D127〜D130 を追記（既存の D は変えていない）
- `docs/02` §7（Preset・time-base・Ante・同時 Bust・Payout の端数・Hero の Bust・ICM の粒度と方式）
- `docs/04` §12（Phase 8 の永続化方針）、`docs/05`（Tournament の Review と CPU の Context・Memory）、`docs/06` §15（Tournament UI）
- `docs/08` §3.1（子 Issue の表）、`docs/11` OI-007（暫定値の注記。永久確定ではない）
- `docs/10`: 判断グループ表。範囲表記を D01〜D130 に（docs/00・docs/10・README・skill 2 つ）

## 調べた現状（起票の前提）

- Engine に Ante は無い（型・Event・処理とも。`ANTE_POSTED` は docs/04 に名前だけ）。Ante は `streetCommitted` に入れない経路が要る（Call 額・Uncalled の返却に混ざるため）。
- Blind は `TableConfig` に固定で、Orchestrator は毎 Hand 同じ設定を渡す（Level の仕組みが無い）。
- Bust の除外・Button の移動・Heads-Up は Engine の `nextHandSeating` / `startHand` で再利用できる。
- Session の終了理由は 3 値で `session_projections` の CHECK にある → D129 で既存の値を使い CHECK を変えない。
- Event の `schema_version` は 8。Ante・Level・Elimination を足す PR で上げ、upcast を足す。
- CPU の Memory の context は `"cash"` 固定（`memory/observation.ts`）、Memory の要約は cash だけを通す（`memory/memory-summary.ts`）→ #188。
- Solver の Spot は `mode: "cash"` 固定で、Tournament は Unsupported として Fallback できる → #189。
- Web に Session の開始画面・mode の選択は無い → #190。

## 実行した確認

- `decision_log.yaml` が YAML として読め、末尾が D130（130 件）
- 範囲表記が D01〜D130 にそろっている（`grep -rn "D01〜D1"`）
- 品質チェック 4 つ: lint / typecheck / format:check は exit 0、`pnpm test` は engine 369・web 147・server 776 がすべて passed

## 残課題

- 子 Issue #183〜#191 を依存順に実装する（P8-1 の着手前に Gate で停止）。
