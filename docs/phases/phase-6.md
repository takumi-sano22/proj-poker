# Phase 6 — Session Learning

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 6 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §3.1「Phase 6」・§3.2（Phase Gate） |
| Parent | [#105](https://github.com/takumi-sano22/proj-poker/issues/105)（Phase 6 Parent。Close 済み）／ Post-MVP Parent [#104](https://github.com/takumi-sano22/proj-poker/issues/104) |
| 主な期間 | 2026-10-07〜08 |
| 主な判断 | D102〜D117 |
| 分解の記録 | [`phase6-planning.md`](../taskLog/phase6-planning.md) |
| 索引 | [Phase 履歴の索引](./README.md) ／ 前: [Phase 5](./phase-5.md) ／ 次: [Phase 7](./phase-7.md) |

## 目的と範囲

Session を通した学習のループを作る。Event Log から Stats・Score・弱点の仮説・Player Profile を作り直し、Session の終わりに振り返り、弱点の判断から一要素だけ変えた Drill を練習できるようにする。子 Issue は P6-0〜P6-8（#108・#112〜#119。D110）。

開始の前提は #104 の Documentation Gate（D102〜D109 の記録と docs の同期。[#108](https://github.com/takumi-sano22/proj-poker/issues/108)）を人間が確認すること。

## 到達した機能

Stats・Score・Profile・Hypothesis は Event Log（正本）と Pass A の Review から読むたびに作り直す Projection（保存しない）として作った。

- **Detailed Stats**（[#112](https://github.com/takumi-sano22/proj-poker/issues/112)）: 全 Player の VPIP・PFR・3-bet・Fold to 3-bet・C-bet・Fold to C-bet・Aggression を分子 / 分母 / 機会の数で再計算。画面に出すのは Hero の行だけで、Play 中の HUD は出さない
- **Ability Evidence と Score**（[#113](https://github.com/takumi-sano22/proj-poker/issues/113)）: Pass A の段階評価を Ability に決定論で割り当て、`ScoringPolicy phase6_provisional_v1` で Score・Confidence・件数・Evidence IDs・Trend を計算
- **User Read / Note / Tag**（[#115](https://github.com/takumi-sano22/proj-poker/issues/115)）: Hero の読みを Hero だけの Event（版 8）に、CPU ごとの Note / Tag を追記型の表（マイグレーション v5）に残す。CPU の入力・Hidden Persona と混ざらない
- **Weakness Hypothesis と Player Profile**（[#114](https://github.com/takumi-sano22/proj-poker/issues/114)）: Supporting / Counter Evidence から決定論で状態が変わる仮説（Snapshot はマイグレーション v6）と、Recent（直近 100 件）/ Long-term の Profile
- **Session Review**（[#116](https://github.com/takumi-sano22/proj-poker/issues/116)）: 判断の質（M 件中 N 件を Review 済み）・Ability ごとの Score・Strength / Leak・Important Hands・Hero の Stats・おすすめの Drill
- **Targeted Drill**（[#117](https://github.com/takumi-sano22/proj-poker/issues/117)）: Leak の判断から Effective Stack・Bet の額・相手の傾向のどれか一つだけを決定論で変えた類題（provenance は追記型の `drills`。マイグレーション v7）
- **Learning Reset**（[#118](https://github.com/takumi-sano22/proj-poker/issues/118)）: カテゴリごとに区切りの行を追記し（マイグレーション v8）、Reset より後の Hand だけで数え直す。Hand の記録・Review・Note / Tag・Stats は消えない
- **Critical E2E**（[#119](https://github.com/takumi-sano22/proj-poker/issues/119)）: Session の終わりまで Play → Review → Session Review → Profile → Drill → Learning Reset → 再起動後も同じ、を CI で通す（`e2e/tests/learning.spec.ts`）

## 主要な品質成果

- 「どちらが先か」の判定を壁時計から永続的な論理順序（`ordinals`。マイグレーション v9）へ移した（[#132](https://github.com/takumi-sano22/proj-poker/issues/132)。[#129](https://github.com/takumi-sano22/proj-poker/issues/129)・[#130](https://github.com/takumi-sano22/proj-poker/issues/130)・[#133](https://github.com/takumi-sano22/proj-poker/issues/133) を統合して [PR #134](https://github.com/takumi-sano22/proj-poker/pull/134) で修正）
- Learning-only の情報が Score・Profile に漏れない（Leakage 0）ことをテストで確かめた（[#119](https://github.com/takumi-sano22/proj-poker/issues/119)）
- Phase 6 のテストの考え方は `docs/09` §10、Phase 6 → Phase 7 の Gate は `docs/08` §3.2 にある

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D102: Post-MVP の Parent 構成と Phase 6 → 7 → 8 の順序
- D103〜D105: Stats の Projection・Profile と Hypothesis・User Read / Note / Tag の方針
- D106〜D109: Phase 7・8 の方針（Phase 6 の Documentation Gate で先に記録）
- D110〜D112: Phase 6 の分解・Projection を保存しない・User Read の Event（版 8）
- D113〜D116: Hypothesis の保存・Learning Reset・Score の対象・Drill の進め方
- D117: 意味上の順序を論理順序で決める

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| [#108](https://github.com/takumi-sano22/proj-poker/issues/108) P6-0 Post-MVP の判断の記録と docs の同期 | [PR #109](https://github.com/takumi-sano22/proj-poker/pull/109) | [`issue-108-post-mvp-docs-sync.md`](../taskLog/issue-108-post-mvp-docs-sync.md) |
| Phase 6 の分解と D110〜D112 | [PR #120](https://github.com/takumi-sano22/proj-poker/pull/120) | [`phase6-planning.md`](../taskLog/phase6-planning.md) |
| 実装前の人間判断 D113〜D116 | [PR #121](https://github.com/takumi-sano22/proj-poker/pull/121) | [`issue-105-phase6-decisions-d113-d116.md`](../taskLog/issue-105-phase6-decisions-d113-d116.md) |
| [#112](https://github.com/takumi-sano22/proj-poker/issues/112) P6-1 Stats Projection | [PR #122](https://github.com/takumi-sano22/proj-poker/pull/122) | [`issue-112-stats-projection.md`](../taskLog/issue-112-stats-projection.md) |
| [#113](https://github.com/takumi-sano22/proj-poker/issues/113) P6-2 ScoringPolicy | [PR #123](https://github.com/takumi-sano22/proj-poker/pull/123) | [`issue-113-scoring-policy.md`](../taskLog/issue-113-scoring-policy.md) |
| [#115](https://github.com/takumi-sano22/proj-poker/issues/115) P6-4 User Read / Note / Tag | [PR #124](https://github.com/takumi-sano22/proj-poker/pull/124) | [`issue-115-user-read-note-tag.md`](../taskLog/issue-115-user-read-note-tag.md) |
| [#114](https://github.com/takumi-sano22/proj-poker/issues/114) P6-3 Hypothesis と Profile | [PR #125](https://github.com/takumi-sano22/proj-poker/pull/125) | [`issue-114-hypothesis-profile.md`](../taskLog/issue-114-hypothesis-profile.md) |
| [#116](https://github.com/takumi-sano22/proj-poker/issues/116) P6-5 Session Review の画面 | [PR #126](https://github.com/takumi-sano22/proj-poker/pull/126) | [`issue-116-session-review-ui.md`](../taskLog/issue-116-session-review-ui.md) |
| [#117](https://github.com/takumi-sano22/proj-poker/issues/117) P6-6 Targeted Drill | [PR #127](https://github.com/takumi-sano22/proj-poker/pull/127) | [`issue-117-targeted-drill.md`](../taskLog/issue-117-targeted-drill.md) |
| [#118](https://github.com/takumi-sano22/proj-poker/issues/118) P6-7 Learning Reset | [PR #128](https://github.com/takumi-sano22/proj-poker/pull/128) | [`issue-118-learning-reset.md`](../taskLog/issue-118-learning-reset.md) |
| [#119](https://github.com/takumi-sano22/proj-poker/issues/119) P6-8 Critical E2E と README | [PR #131](https://github.com/takumi-sano22/proj-poker/pull/131) | [`issue-119-phase6-e2e-readme.md`](../taskLog/issue-119-phase6-e2e-readme.md) |
| [#132](https://github.com/takumi-sano22/proj-poker/issues/132)（横断）論理順序 | [PR #134](https://github.com/takumi-sano22/proj-poker/pull/134) | [`issue-132-logical-order.md`](../taskLog/issue-132-logical-order.md) |
| [#110](https://github.com/takumi-sano22/proj-poker/issues/110)（横断）harness の進捗管理の親 | [PR #111](https://github.com/takumi-sano22/proj-poker/pull/111) | [`issue-110-harness-post-mvp-parent.md`](../taskLog/issue-110-harness-post-mvp-parent.md) |

D113 により P6-4（#115）を P6-3（#114）より先に実装した。

## 次の Phase へ引き継いだ事項

- Score・Hypothesis・Drill の式と値は OI-006 の暫定値（永久仕様ではない）
- User Read / Note / Tag の対象は席 id を永続 Identity とみなさない参照にしてあり、Phase 7 の `cpuProfileId` と接続する（D105）
