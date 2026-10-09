# Phase 2 — Full Poker Engine

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 2 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §3「Phase 2」 |
| Parent | [#2](https://github.com/takumi-sano22/proj-poker/issues/2)（MVP Parent。Close 済み） |
| 主な期間 | 2026-10-05 |
| 主な判断 | D77〜D81 |
| 索引 | [Phase 履歴の索引](./README.md) ／ 前: [Phase 1](./phase-1.md) ／ 次: [Phase 3](./phase-3.md) |

## 目的と範囲

NLHE Cash のルールを決定論の Engine で一通り扱えるようにする。2〜8 人・不均等 Stack・Side Pot・Short All-in の Reopen・Heads-Up・Position・Session（Hand を続ける）を、固定 Scenario と Property Test で確かめる。子 Issue は #31〜#36 の 6 つ（D77）。

## 到達した機能

- **Side Pot と不均等 Stack**（[#31](https://github.com/takumi-sano22/proj-poker/issues/31)）: Multi Side Pot・Side Pot 内の Split。Pot ごとに `POT_AWARDED` を出す（Event の版 2）
- **Short All-in の Reopen**（[#32](https://github.com/takumi-sano22/proj-poker/issues/32)）: 累積の Short All-in を含む TDA 準拠の再開規則を Rule Profile の暫定値に置き、`HAND_STARTED` に残す（版 3）
- **2〜8 人の卓**（[#33](https://github.com/takumi-sano22/proj-poker/issues/33)）: 人数を Config（`TABLE_SIZE`）で選び、UI の席配置を人数に合わせる
- **Position Engine**（[#34](https://github.com/takumi-sano22/proj-poker/issues/34)）: 次の Hand の Button・Blind と Heads-Up への転換（Heads-Up は Button = SB）
- **Session**（[#35](https://github.com/takumi-sano22/proj-poker/issues/35)）: Stack を Hand 間で持ち越し、Bust した CPU は退席。Hero の Bust か Hero だけが残ったら Session を終える
- **Scenario の総点検**（[#36](https://github.com/takumi-sano22/proj-poker/issues/36)）: `docs/02` §5 の必須 Scenario のうち Phase 2 の範囲を固定 Scenario でそろえた

## 主要な品質成果

- 必須 Scenario を期待値は手計算の固定 Scenario で揃えた（対応表は [`issue-36-phase2-scenarios.md`](../taskLog/issue-36-phase2-scenarios.md)）
- 2〜8 人・不均等 Stack のランダム Hand と、Stack を持ち越す複数 Hand の Session で、Chip 保存と Pot / Commit の一致を Property Test で確かめる形にした

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D77: Phase 2 の子 Issue の分解
- D78: Side Pot の Event（Pot ごとの `POT_AWARDED`・版 2）
- D79: Short All-in の Reopen 規則（OI-008 の暫定値）
- D80: Bust 時の退席・Session の終了・Button の進め方（OI-008 の暫定値）
- D81: Reopen 規則を Event に残す（版 3）

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| [#31](https://github.com/takumi-sano22/proj-poker/issues/31) Side Pot と不均等 Stack | [PR #37](https://github.com/takumi-sano22/proj-poker/pull/37) | [`issue-31-side-pot.md`](../taskLog/issue-31-side-pot.md) |
| [#32](https://github.com/takumi-sano22/proj-poker/issues/32) Short All-in の Reopen | [PR #38](https://github.com/takumi-sano22/proj-poker/pull/38) | [`issue-32-short-allin-reopen.md`](../taskLog/issue-32-short-allin-reopen.md) |
| [#33](https://github.com/takumi-sano22/proj-poker/issues/33) 2〜8 人の卓 | [PR #39](https://github.com/takumi-sano22/proj-poker/pull/39) | [`issue-33-table-size.md`](../taskLog/issue-33-table-size.md) |
| [#34](https://github.com/takumi-sano22/proj-poker/issues/34) Position Engine | [PR #40](https://github.com/takumi-sano22/proj-poker/pull/40) | [`issue-34-position-engine.md`](../taskLog/issue-34-position-engine.md) |
| [#35](https://github.com/takumi-sano22/proj-poker/issues/35) Session | [PR #41](https://github.com/takumi-sano22/proj-poker/pull/41) | [`issue-35-session.md`](../taskLog/issue-35-session.md) |
| [#36](https://github.com/takumi-sano22/proj-poker/issues/36) Scenario の総点検と README の更新 | [PR #42](https://github.com/takumi-sano22/proj-poker/pull/42) | [`issue-36-phase2-scenarios.md`](../taskLog/issue-36-phase2-scenarios.md) |
| [#43](https://github.com/takumi-sano22/proj-poker/issues/43) `PHASE1_CASH_PRESET` のコメントの修正 | [PR #44](https://github.com/takumi-sano22/proj-poker/pull/44) | — |

## 次の Phase へ引き継いだ事項

- BB 補助表示・Fast Forward → Phase 4、再起動後の Session の Resume → Phase 5（`docs/08` §3「Phase 2」の注記）
- Oversized Chip・String Bet・Out of Turn の Scenario → Phase 4、Ante の Scenario → Phase 8
