# Phase 4 — Live Mechanics

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 4 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §3「Phase 4」 |
| Parent | [#2](https://github.com/takumi-sano22/proj-poker/issues/2)（MVP Parent。Close 済み） |
| 主な期間 | 2026-10-06 |
| 主な判断 | D89〜D93 |
| 索引 | [Phase 履歴の索引](./README.md) ／ 前: [Phase 3](./phase-3.md) ／ 次: [Phase 5](./phase-5.md) |

## 目的と範囲

ライブの卓を意識した操作を練習できるようにする。実際の Chip の額面を出す操作と宣言、TDA 準拠の Dealer の裁定、裁定の説明、終わった Hand の Replay を作る。子 Issue は #62〜#68 の 7 つ（D89）。

## 到達した機能

- **Chip の額面と構成**（[#62](https://github.com/takumi-sano22/proj-poker/issues/62)）: 1（白）・5（赤）・25（緑）・100（黒）・500（紫）の Preset から、額の Chip の構成を自動で組んで卓に描く
- **Ruling Engine**（[#63](https://github.com/takumi-sano22/proj-poker/issues/63)）: 版付き Rule Profile `phase4_provisional_v1` で Oversized Chip・String Bet / Raise・Out of Turn を裁定する。物理的な誤操作をするのは Hero だけで、CPU は Canonical Action で行動する
- **宣言・操作・裁定の Event**（[#64](https://github.com/takumi-sano22/proj-poker/issues/64)）: `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` / `DEALER_RULING`（版 5）
- **Chip の Click / Drag と宣言 Button の UI**（[#65](https://github.com/takumi-sano22/proj-poker/issues/65)）: 数値入力の Bet Box を使わない。手番でなくても操作でき、Out of Turn として裁定される
- **Dealer Feedback と Poker Vocabulary**（[#66](https://github.com/takumi-sano22/proj-poker/issues/66)）: 裁定を Ruling・Etiquette・Coaching の 3 分類で出す（文言は決定論）。卓の用語の定義・例・関連概念を開ける
- **BB 補助表示と Fast Forward**（[#67](https://github.com/takumi-sano22/proj-poker/issues/67)）: BB 換算の ON / OFF（実額は常に表示）、Hero Fold 後の CPU の思考待ちの短縮
- **Replay**（[#68](https://github.com/takumi-sano22/proj-poker/issues/68)）: 保存済みの Event を Hero の視点で一手ずつ再生する（Re-simulation ではない）

## 主要な品質成果

- Ruling を固定 Scenario と Property Test で確かめた
- Replay は保存済みの Event だけを使い、AI や Engine で作り直さない（D38）形で実装した。宣言・操作・裁定も Event として再生できる

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D89: Phase 4 の子 Issue の分解
- D90: 宣言・物理操作・裁定の Event（版 5）
- D91: Ruling の規則と、誤操作は Hero だけ（OI-008 の暫定値）
- D92: Chip の額面 Preset（OI-004 の暫定値）
- D93: Replay の操作と、BB 補助表示・Fast Forward の扱い
- 既存の判断の実装: D38（Replay は Re-simulation ではない）・D45（用語表示）・D49（実額を常時表示し BB は補助）

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| [#62](https://github.com/takumi-sano22/proj-poker/issues/62) Chip の額面 Preset と構成表示 | [PR #69](https://github.com/takumi-sano22/proj-poker/pull/69) | [`issue-62-chip-denominations.md`](../taskLog/issue-62-chip-denominations.md) |
| [#63](https://github.com/takumi-sano22/proj-poker/issues/63) Ruling Engine | [PR #70](https://github.com/takumi-sano22/proj-poker/pull/70) | [`issue-63-ruling-engine.md`](../taskLog/issue-63-ruling-engine.md) |
| [#64](https://github.com/takumi-sano22/proj-poker/issues/64) 宣言・物理操作・裁定の Event（版 5） | [PR #71](https://github.com/takumi-sano22/proj-poker/pull/71) | [`issue-64-live-events-v5.md`](../taskLog/issue-64-live-events-v5.md) |
| [#65](https://github.com/takumi-sano22/proj-poker/issues/65) Chip の Click / Drag と宣言 Button | [PR #72](https://github.com/takumi-sano22/proj-poker/pull/72) | [`issue-65-chip-interaction-ui.md`](../taskLog/issue-65-chip-interaction-ui.md) |
| [#66](https://github.com/takumi-sano22/proj-poker/issues/66) Dealer Feedback と Poker Vocabulary | [PR #73](https://github.com/takumi-sano22/proj-poker/pull/73) | [`issue-66-dealer-feedback-vocabulary.md`](../taskLog/issue-66-dealer-feedback-vocabulary.md) |
| [#67](https://github.com/takumi-sano22/proj-poker/issues/67) BB 補助表示と Fast Forward | [PR #74](https://github.com/takumi-sano22/proj-poker/pull/74) | [`issue-67-bb-toggle-fast-forward.md`](../taskLog/issue-67-bb-toggle-fast-forward.md) |
| [#68](https://github.com/takumi-sano22/proj-poker/issues/68) Replay と README | [PR #75](https://github.com/takumi-sano22/proj-poker/pull/75) | [`issue-68-replay.md`](../taskLog/issue-68-replay.md) |

## 次の Phase へ引き継いだ事項

- 未完了の Hand はメモリにだけあり再起動で消える → Hand の中断・再開の Event 化は Phase 5 の Session Resume で設計
- Learning-only Full Reveal と Jump to Important Spot → Phase 5 の Review
- Replay の一覧の上限（100 件）・再生の間隔は暫定値
