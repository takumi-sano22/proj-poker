# Phase 3 — AI Opponents

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 3 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §3「Phase 3」 |
| Parent | [#2](https://github.com/takumi-sano22/proj-poker/issues/2)（MVP Parent。Close 済み） |
| 主な期間 | 2026-10-05〜06 |
| 主な判断 | D82〜D88 |
| 索引 | [Phase 履歴の索引](./README.md) ／ 前: [Phase 2](./phase-2.md) ／ 次: [Phase 4](./phase-4.md) |

## 目的と範囲

CPU を LLM（Claude）で動かせるようにする。CPU ごとの情報境界（KnowledgeState）・構造化された Action の検証・Retry / Fallback・Persona・障害時の扱いを作り、合法性は Engine が判断して LLM には判断させない。子 Issue は #46〜#53 の 8 つ（D82）。

## 到達した機能

- **KnowledgeState と決定論 Math**（[#46](https://github.com/takumi-sano22/proj-poker/issues/46)）: CPU ごとに、その CPU に見える情報だけの KnowledgeState を作る（他者の Hole Cards・未来のカード・他 CPU の Persona を渡さない）
- **非同期の OpponentAgent**（[#47](https://github.com/takumi-sano22/proj-poker/issues/47)）: 出力を Schema / Legal Action / Amount Range で検証し、不正なら 1 回だけ Retry、だめなら RuleBot へ Fallback
- **AI の Event**（[#48](https://github.com/takumi-sano22/proj-poker/issues/48)）: `AI_ACTION_INVALID` / `AI_FALLBACK_USED` を Event Log に残す（版 4）
- **Claude の認証**（[#49](https://github.com/takumi-sano22/proj-poker/issues/49)）: API キーではなく Claude Code の OAuth（サブスクリプション枠）を使う手順を文書にした（D87。D84 を変更）
- **Model Adapter**（[#50](https://github.com/takumi-sano22/proj-poker/issues/50)）: Claude Agent SDK の Adapter と role-based model config（対戦 CPU は `opponent_fast`）
- **Persona**（[#51](https://github.com/takumi-sano22/proj-poker/issues/51)）: 6 種の Preset を卓の CPU に割り当て、Prompt と RuleBot に反映
- **AI 障害時の選択**（[#52](https://github.com/takumi-sano22/proj-poker/issues/52)）: Retry / Emergency Bot で続行 / Session を終了 の 3 択
- **AI Opponent Eval**（[#53](https://github.com/takumi-sano22/proj-poker/issues/53)）: 代表 Spot × Persona の判断を集め、出力の正しさ・Retry 率・Latency・Persona の差・情報漏れを測る最小ハーネス（`docs/09` §5）

既定の CPU は RuleBot のままで、Claude は設定で切り替えたときだけ使う形にした。

## 主要な品質成果

- 情報境界（KnowledgeState）を型と Projection で作り、global な GameState を LLM に渡さない構成にした
- CI・`pnpm test` は Claude を呼ばない（Fake と録画だけ）運用を決めた

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D82: Phase 3 の子 Issue の分解
- D83: 不正出力と Fallback の Event（版 4）
- D84 → D87: Claude の認証を API キーから Claude Code の OAuth へ変更
- D85: `opponent_fast` の暫定モデルと 6 種の Persona（OI-001・OI-005 の暫定値）
- D86: AI 障害時の 3 択
- D88: 障害時の Session 終了・Emergency Bot の登録はメモリに持つ（Phase 5 の D95 で Event 化）

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| [#46](https://github.com/takumi-sano22/proj-poker/issues/46) KnowledgeState と決定論 Math（重複起票の [#45](https://github.com/takumi-sano22/proj-poker/issues/45) は Close） | [PR #54](https://github.com/takumi-sano22/proj-poker/pull/54) | [`issue-46-knowledge-state.md`](../taskLog/issue-46-knowledge-state.md) |
| [#47](https://github.com/takumi-sano22/proj-poker/issues/47) 非同期化・検証・Retry・Fallback | [PR #55](https://github.com/takumi-sano22/proj-poker/pull/55) | [`issue-47-async-opponent-validation.md`](../taskLog/issue-47-async-opponent-validation.md) |
| [#48](https://github.com/takumi-sano22/proj-poker/issues/48) AI の Event（版 4） | [PR #56](https://github.com/takumi-sano22/proj-poker/pull/56) | [`issue-48-ai-events-v4.md`](../taskLog/issue-48-ai-events-v4.md) |
| [#49](https://github.com/takumi-sano22/proj-poker/issues/49) Claude Code の OAuth の手順と D87 | [PR #57](https://github.com/takumi-sano22/proj-poker/pull/57) | [`issue-49-claude-oauth-setup.md`](../taskLog/issue-49-claude-oauth-setup.md) |
| [#50](https://github.com/takumi-sano22/proj-poker/issues/50) Agent SDK の Model Adapter | [PR #58](https://github.com/takumi-sano22/proj-poker/pull/58) | [`issue-50-agent-sdk-adapter.md`](../taskLog/issue-50-agent-sdk-adapter.md) |
| [#51](https://github.com/takumi-sano22/proj-poker/issues/51) Persona の Preset | [PR #59](https://github.com/takumi-sano22/proj-poker/pull/59) | [`issue-51-persona-presets.md`](../taskLog/issue-51-persona-presets.md) |
| [#52](https://github.com/takumi-sano22/proj-poker/issues/52) AI 障害時の選択 | [PR #60](https://github.com/takumi-sano22/proj-poker/pull/60) | [`issue-52-ai-outage-choice.md`](../taskLog/issue-52-ai-outage-choice.md) |
| [#53](https://github.com/takumi-sano22/proj-poker/issues/53) AI Opponent Eval と README | [PR #61](https://github.com/takumi-sano22/proj-poker/pull/61) | [`issue-53-opponent-eval.md`](../taskLog/issue-53-opponent-eval.md) |

## 次の Phase へ引き継いだ事項

- 障害時の Session 終了・Emergency Bot の Event 化 → Phase 5（D95）
- Eval の合格ラインと Spot は暫定。明らかに筋の悪い判断（Strategic Incoherence）は未測定（[`issue-53-opponent-eval.md`](../taskLog/issue-53-opponent-eval.md)）
