# Phase 1 — Vertical Poker Slice

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 1 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §3「Phase 1」 |
| Parent | [#2](https://github.com/takumi-sano22/proj-poker/issues/2)（MVP Parent。Close 済み） |
| 主な期間 | 2026-10-05（[#5](https://github.com/takumi-sano22/proj-poker/issues/5) の UI 改良は 2026-10-07） |
| 主な判断 | D70〜D76 |
| 索引 | [Phase 履歴の索引](./README.md) ／ 前: [Phase 0](./phase-0.md) ／ 次: [Phase 2](./phase-2.md) |

## 目的と範囲

`Play → Event Log` の縦一本を最小の形で通す。6-max Cash の 1 Hand を、決定論の Engine・ローカルの Server・ブラウザの卓・SQLite の Event Log までつなぐ。Side Pot・Short All-in の Reopen・人数の可変・Session は Phase 2 以降。

## 到達した機能

- **Engine の基礎**（[#16](https://github.com/takumi-sano22/proj-poker/issues/16)）: Card / Deck・seed 付き RNG・Hand Evaluator
- **6-max 1 Hand の進行**（[#17](https://github.com/takumi-sano22/proj-poker/issues/17)）: Legal Action・Street・Showdown・単一 Pot と Event の発行。全員 100BB の均等 Stack で、Fold / Check / Call / Bet / Raise / All-in と Minimum Raise を扱う。扱えない状態（Side Pot 等）は Event を出さずにエラーにした
- **Odd Chip Split**（[#23](https://github.com/takumi-sano22/proj-poker/issues/23)）: 割り切れない端数を Button の左から配る
- **Server**（[#18](https://github.com/takumi-sano22/proj-poker/issues/18)）: Hand Orchestrator・暫定 CPU（seed 付きの決定論ルール Bot。後の RuleBot）・REST（Hero の Action）+ SSE（Hero に見える Projection の Push）
- **Web の Basic UI**（[#19](https://github.com/takumi-sano22/proj-poker/issues/19)）: 2D 卓・実額表示・宣言 Button
- **Event Log の永続化**（[#20](https://github.com/takumi-sano22/proj-poker/issues/20)）: Node 24 内蔵の `node:sqlite`（ORM なし・生 SQL・自前マイグレーション）に、終わった Hand の Event を追記で保存。行ごとに `schema_version` を持たせる方針を決めた

## 主要な品質成果

- Engine の固定 Scenario の形式（`HandScenario`）と汎用ランナーを [#17](https://github.com/takumi-sano22/proj-poker/issues/17) で確定した（`poker-engine-testing` skill の §4）
- Chip を整数の最小単位で表し、浮動小数を使わない規約を決めた

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D70: Phase 1 の範囲（均等 Stack・単一 Pot）
- D71: 暫定 CPU は seed 付きの決定論ルール Bot（後の Fallback / Emergency Bot に流用）
- D72: `node:sqlite`・生 SQL・自前マイグレーション
- D73: REST（POST）+ SSE、Push は Hero に見える Projection だけ
- D74: Chip は整数の最小単位
- D75: Odd Chip の配り方（Rule Profile の設定値。OI-008 の暫定値）
- D76: Event の行ごとの `schema_version` と読み込み時の upcast

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| [#16](https://github.com/takumi-sano22/proj-poker/issues/16) Engine 基礎と D70〜D73 の記録 | [PR #21](https://github.com/takumi-sano22/proj-poker/pull/21) | [`issue-16-engine-basics.md`](../taskLog/issue-16-engine-basics.md) |
| [#17](https://github.com/takumi-sano22/proj-poker/issues/17) 6-max 1 Hand の進行と Event | [PR #22](https://github.com/takumi-sano22/proj-poker/pull/22) | [`issue-17-hand-progression.md`](../taskLog/issue-17-hand-progression.md) |
| [#23](https://github.com/takumi-sano22/proj-poker/issues/23) Odd Chip Split | [PR #24](https://github.com/takumi-sano22/proj-poker/pull/24) | [`issue-23-odd-chip.md`](../taskLog/issue-23-odd-chip.md) |
| [#18](https://github.com/takumi-sano22/proj-poker/issues/18) Hand Orchestrator・暫定 CPU・REST + SSE | [PR #25](https://github.com/takumi-sano22/proj-poker/pull/25) | [`issue-18-server-orchestrator.md`](../taskLog/issue-18-server-orchestrator.md) |
| [#19](https://github.com/takumi-sano22/proj-poker/issues/19) Basic UI | [PR #26](https://github.com/takumi-sano22/proj-poker/pull/26) | [`issue-19-basic-ui.md`](../taskLog/issue-19-basic-ui.md) |
| [#20](https://github.com/takumi-sano22/proj-poker/issues/20) SQLite の Event Log | [PR #30](https://github.com/takumi-sano22/proj-poker/pull/30) | [`issue-20-sqlite-event-log.md`](../taskLog/issue-20-sqlite-event-log.md) |
| [#5](https://github.com/takumi-sano22/proj-poker/issues/5) `ui-design-recipes` の卓 UI 向け改良と狭い画面の重なり（MVP 後に実施） | [PR #101](https://github.com/takumi-sano22/proj-poker/pull/101)・[PR #102](https://github.com/takumi-sano22/proj-poker/pull/102)・[PR #103](https://github.com/takumi-sano22/proj-poker/pull/103) | [`issue-5-table-ui-narrow-overlap.md`](../taskLog/issue-5-table-ui-narrow-overlap.md)・[`issue-5-bet-placement-seat-count.md`](../taskLog/issue-5-bet-placement-seat-count.md)・[`issue-5-ui-design-recipes-table.md`](../taskLog/issue-5-ui-design-recipes-table.md) |

同時期の横断: 許可リストの調整 [#15](https://github.com/takumi-sano22/proj-poker/issues/15)・[#27](https://github.com/takumi-sano22/proj-poker/issues/27)（人間が手動で対応）、`permissions.ask` の廃止 [#28](https://github.com/takumi-sano22/proj-poker/issues/28)（[PR #29](https://github.com/takumi-sano22/proj-poker/pull/29)）。

## 次の Phase へ引き継いだ事項

- Side Pot・Short All-in の Reopen・2〜8 人・Position・Session → Phase 2
- 保存した Hand の一覧・再生（Replay）→ Phase 4
- Session Projection・Stack の持ち越しの保存 → Phase 2（持ち越し）と Phase 5（Resume）
