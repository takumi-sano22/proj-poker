# Phase 7 — Rich Opponent Simulation

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 7 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §3.1「Phase 7」・§3.2（Phase Gate） |
| Parent | [#106](https://github.com/takumi-sano22/proj-poker/issues/106)（Phase 7 Parent。Close 済み）／ Post-MVP Parent [#104](https://github.com/takumi-sano22/proj-poker/issues/104) |
| 主な期間 | 2026-10-08 |
| 主な判断 | D118〜D126（方針は Phase 6 の Gate で記録した D106・D107） |
| 分解の記録 | [`phase7-planning.md`](../taskLog/phase7-planning.md) |
| 索引 | [Phase 履歴の索引](./README.md) ／ 前: [Phase 6](./phase-6.md) ／ 次: [Phase 8](./phase-8.md) |

## 目的と範囲

CPU を「覚えていて、揺れる」相手にする。Persona（Secret）・Session を跨ぐ Long-term Memory・Session の中だけの Tilt・卓の傾向（Table Tendency）を層として分け、どれも Event Log から Hand の開始時に作り直す Projection にする。Hero の画面・API・Review には Hidden の層を出さない。子 Issue は P7-0〜P7-9（#135〜#144。D121）で、依存順に直列で進めた。

## 到達した機能

- **Fixed CPU と Guest**（[#136](https://github.com/takumi-sano22/proj-poker/issues/136)）: 席と別の永続の `cpuProfileId`。Fixed Pool（`phase7_pool_v1`。8 人）と、1 卓に最大 1 席の Guest（その Session 限り）。編成は追記型の `session_participants`（マイグレーション v10）
- **Observation**（[#137](https://github.com/takumi-sano22/proj-poker/issues/137)）: CPU が卓で実際に見た public の Event だけを、provenance 付きで Event Log から決定論で取り出す
- **Private Hypothesis**（[#138](https://github.com/takumi-sano22/proj-poker/issues/138)）: Observer × Subject × context（cash / tournament）ごとに recency decay（`phase7_memory_v1`）を掛けた傾向
- **Memory の注入**（[#139](https://github.com/takumi-sano22/proj-poker/issues/139)）: その CPU 自身の Memory だけを、上限付きの構造化データ（`phase7_memory_injection_v1`）として KnowledgeState と Prompt に渡す
- **Tilt**（[#140](https://github.com/takumi-sano22/proj-poker/issues/140)）: Version 付きの決定論 State Machine（`phase7_tilt_v1`。0〜3 段）。Session の終わりで 0 に戻る
- **Table Tendency**（[#141](https://github.com/takumi-sano22/proj-poker/issues/141)）: その CPU が座っていた Hand の public の Event だけから作る卓の傾向（`phase7_table_tendency_v1`）
- **層の合成と Eval**（[#142](https://github.com/takumi-sano22/proj-poker/issues/142)）: RuleBot は Persona → Tilt → Table Tendency → Memory の順に上限付きでしきい値をずらす（`phase7_rulebot_composition_v1`）。Opponent Memory の Eval を CI で回す
- **Opponent Memory Reset**（[#143](https://github.com/takumi-sano22/proj-poker/issues/143)）: 区切りの行を追記型の表（マイグレーション v11）に足す API。正本は消さない
- **Critical E2E**（[#144](https://github.com/takumi-sano22/proj-poker/issues/144)）: Fixed CPU と Guest の卓で複数 Session を Play し、Memory の持ち越し・Guest の破棄・Private Memory の分離・Tilt の Reset・Memory Reset を CI で通す（`e2e/tests/opponent-memory.spec.ts`）

Phase の途中で人間判断を経て足したもの:

- **Hero の Review に卓の傾向**（[#153](https://github.com/takumi-sano22/proj-poker/issues/153)・D122）と、その Review の根拠の欄の表示（[#169](https://github.com/takumi-sano22/proj-poker/issues/169)）
- **CPU Memory の Cache**（[#150](https://github.com/takumi-sano22/proj-poker/issues/150) の測定 → D124 → [#165](https://github.com/takumi-sano22/proj-poker/issues/165)）: Hand ごとの Observation を、消しても作り直せる派生の表（マイグレーション v12）に Cache
- **Memory 付き Prompt の Claude CPU の Eval**（[#155](https://github.com/takumi-sano22/proj-poker/issues/155)・D123、River の追加測定 [#171](https://github.com/takumi-sano22/proj-poker/issues/171)・D126）: API キーを使わず OAuth 経路で録画し、CI は再生だけで回す

## 主要な品質成果

- CPU 同士の Private Memory の隔離・Learning-only Reveal が Memory に入らないこと・Cash / Tournament の context の分離をテストで確かめた（Phase 7 → 8 の Gate とテストの対応は `docs/09` §8・§11）
- 実 SQLite で 5,000 Hand のときの Hand の開始の遅さを測り（[#150](https://github.com/takumi-sano22/proj-poker/issues/150)）、Cache の追加後に測り直した（[#165](https://github.com/takumi-sano22/proj-poker/issues/165)）。DB の大きさも測った（[#174](https://github.com/takumi-sano22/proj-poker/issues/174)）
- 画面の配置の不具合（[#158](https://github.com/takumi-sano22/proj-poker/issues/158)・[#163](https://github.com/takumi-sano22/proj-poker/issues/163)）を E2E の配置の検査（`session-end-layout.spec.ts`・`table-layout.spec.ts`）で固定した

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D106・D107: Fixed CPU / Guest の Memory と Tilt の方針（Phase 6 の Gate で記録）
- D118〜D121: `session_participants`・OI-011 の暫定 Policy・Opponent Memory Reset・Phase 7 の分解と Memory の渡し方
- D122: Hero の Review の Evidence に卓の傾向を入れる
- D123・D126: Memory 付き Prompt の Claude CPU の Eval の録画（初回と River の追加）
- D124: CPU Memory の永続 Cache
- D125: Review の文の数値の機械照合を Phase 7 では行わない（後の D131 で実装）

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| [#135](https://github.com/takumi-sano22/proj-poker/issues/135) P7-0 D118〜D121 の記録と docs の同期 | [PR #145](https://github.com/takumi-sano22/proj-poker/pull/145) | [`phase7-planning.md`](../taskLog/phase7-planning.md) |
| [#136](https://github.com/takumi-sano22/proj-poker/issues/136) P7-1 Fixed CPU Identity / Pool / Guest | [PR #146](https://github.com/takumi-sano22/proj-poker/pull/146) | [`issue-136-cpu-identity.md`](../taskLog/issue-136-cpu-identity.md) |
| [#137](https://github.com/takumi-sano22/proj-poker/issues/137) P7-2 Observation | [PR #147](https://github.com/takumi-sano22/proj-poker/pull/147) | [`issue-137-observation-extract.md`](../taskLog/issue-137-observation-extract.md) |
| [#138](https://github.com/takumi-sano22/proj-poker/issues/138) P7-3 Private Hypothesis | [PR #148](https://github.com/takumi-sano22/proj-poker/pull/148) | [`issue-138-private-hypothesis.md`](../taskLog/issue-138-private-hypothesis.md) |
| [#139](https://github.com/takumi-sano22/proj-poker/issues/139) P7-4 Memory の注入 | [PR #149](https://github.com/takumi-sano22/proj-poker/pull/149) | [`issue-139-memory-knowledge.md`](../taskLog/issue-139-memory-knowledge.md) |
| [#140](https://github.com/takumi-sano22/proj-poker/issues/140) P7-5 Tilt | [PR #151](https://github.com/takumi-sano22/proj-poker/pull/151) | [`issue-140-tilt.md`](../taskLog/issue-140-tilt.md) |
| [#141](https://github.com/takumi-sano22/proj-poker/issues/141) P7-6 Table Tendency | [PR #152](https://github.com/takumi-sano22/proj-poker/pull/152) | [`issue-141-table-tendency.md`](../taskLog/issue-141-table-tendency.md) |
| [#142](https://github.com/takumi-sano22/proj-poker/issues/142) P7-7 合成と Opponent Eval | [PR #154](https://github.com/takumi-sano22/proj-poker/pull/154) | [`issue-142-opponent-eval.md`](../taskLog/issue-142-opponent-eval.md) |
| [#143](https://github.com/takumi-sano22/proj-poker/issues/143) P7-8 Opponent Memory Reset | [PR #156](https://github.com/takumi-sano22/proj-poker/pull/156) | [`issue-143-opponent-memory-reset.md`](../taskLog/issue-143-opponent-memory-reset.md) |
| [#144](https://github.com/takumi-sano22/proj-poker/issues/144) P7-9 Critical E2E と README | [PR #159](https://github.com/takumi-sano22/proj-poker/pull/159) | [`issue-144-phase7-e2e-readme.md`](../taskLog/issue-144-phase7-e2e-readme.md) |
| [#153](https://github.com/takumi-sano22/proj-poker/issues/153)・[#155](https://github.com/takumi-sano22/proj-poker/issues/155) の判断 D122・D123 | [PR #160](https://github.com/takumi-sano22/proj-poker/pull/160) | — |
| [#153](https://github.com/takumi-sano22/proj-poker/issues/153) Hero の Review に卓の傾向 | [PR #166](https://github.com/takumi-sano22/proj-poker/pull/166) | [`issue-153-review-table-tendency.md`](../taskLog/issue-153-review-table-tendency.md) |
| [#155](https://github.com/takumi-sano22/proj-poker/issues/155) Memory 付き Prompt の Eval | [PR #170](https://github.com/takumi-sano22/proj-poker/pull/170) | [`issue-155-memory-prompt-eval.md`](../taskLog/issue-155-memory-prompt-eval.md) |
| [#150](https://github.com/takumi-sano22/proj-poker/issues/150) Memory の都度計算の測定 | [PR #164](https://github.com/takumi-sano22/proj-poker/pull/164) | [`issue-150-memory-perf.md`](../taskLog/issue-150-memory-perf.md) |
| [#165](https://github.com/takumi-sano22/proj-poker/issues/165) の判断 D124 | [PR #172](https://github.com/takumi-sano22/proj-poker/pull/172) | — |
| [#165](https://github.com/takumi-sano22/proj-poker/issues/165) Observation の Cache（v12） | [PR #173](https://github.com/takumi-sano22/proj-poker/pull/173) | [`issue-165-observation-cache.md`](../taskLog/issue-165-observation-cache.md) |
| [#168](https://github.com/takumi-sano22/proj-poker/issues/168)・[#171](https://github.com/takumi-sano22/proj-poker/issues/171) の判断 D125・D126 | [PR #175](https://github.com/takumi-sano22/proj-poker/pull/175) | — |
| [#171](https://github.com/takumi-sano22/proj-poker/issues/171) River の追加測定 | [PR #177](https://github.com/takumi-sano22/proj-poker/pull/177) | [`issue-171-river-eval.md`](../taskLog/issue-171-river-eval.md) |
| [#169](https://github.com/takumi-sano22/proj-poker/issues/169) Review の根拠の欄の卓の傾向 | [PR #180](https://github.com/takumi-sano22/proj-poker/pull/180) | [`issue-169-review-tendency-ui.md`](../taskLog/issue-169-review-tendency-ui.md) |
| [#174](https://github.com/takumi-sano22/proj-poker/issues/174) observed_hand_cache の DB の大きさ | [PR #181](https://github.com/takumi-sano22/proj-poker/pull/181) | [`issue-174-db-size.md`](../taskLog/issue-174-db-size.md) |
| [#158](https://github.com/takumi-sano22/proj-poker/issues/158) Session 終了後の Button の配置 | [PR #162](https://github.com/takumi-sano22/proj-poker/pull/162) | [`issue-158-session-end-buttons.md`](../taskLog/issue-158-session-end-buttons.md) |
| [#157](https://github.com/takumi-sano22/proj-poker/issues/157)（横断）Learning Reset Store の順序の源 | [PR #161](https://github.com/takumi-sano22/proj-poker/pull/161) | [`issue-157-learning-reset-ordinals.md`](../taskLog/issue-157-learning-reset-ordinals.md) |
| [#163](https://github.com/takumi-sano22/proj-poker/issues/163)（横断）720〜1023px の Hero 欄 | [PR #178](https://github.com/takumi-sano22/proj-poker/pull/178) | [`issue-163-mid-width-layout.md`](../taskLog/issue-163-mid-width-layout.md) |
| [#167](https://github.com/takumi-sano22/proj-poker/issues/167)（横断）Property の網羅の確認 | [PR #176](https://github.com/takumi-sano22/proj-poker/pull/176) | [`issue-167-property-coverage.md`](../taskLog/issue-167-property-coverage.md) |

## 次の Phase へ引き継いだ事項

- Fixed Pool の内訳は OI-005、Memory・Tilt・Table Tendency・合成の値は OI-011 の暫定値（永久仕様ではない）
- Memory 付き Prompt の Claude CPU の Eval は、戦略への反映の向きについて結論が出ていない（Prompt / Policy は変えていない。`docs/09` §5）
- Review の文の数値の機械照合（[#168](https://github.com/takumi-sano22/proj-poker/issues/168)）は Phase 7 の範囲外とした（D125）→ Phase 8 の後に D131 で実装（[Phase 8 の末尾](./phase-8.md#phase-8-完了後の横断整理)）
- Opponent Memory Reset には画面の入口が無い（Hero に Fixed CPU の名前・`cpuProfileId` を見せないため）
