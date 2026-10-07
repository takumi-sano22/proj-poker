# Issue #114 P6-3 Hypothesis Lifecycle / Player Profile

## 概要

Weakness Hypothesis を Supporting / Counter Evidence（Ability Evidence の ID）から決定論で状態遷移させ、reviews から作り直せる Snapshot（マイグレーション v6 の `hypothesis_snapshots`）に保存する。Recent / Long-term の Structured Player Profile を都度計算し、自然言語の Profile は LLM を呼ばず決定論のテンプレート文で作る。D104・D111・D113・D115・D116。

## 初期調査

- #113 の `buildAbilityEvidence`（`apps/server/src/learning/ability-evidence.ts`）は、Pass A の `reviews` の判断ごとの最新の Version から Ability Evidence を作り、Pass B の Store は型の上でも受け取らない。Hypothesis / Profile も同じ入口に乗せれば、Score と同じ入力の境界（Pass A だけ・Review 済みだけ・Drill の除外）をそのまま使える。
- `computeScoreReport` は Evidence の作成と集計を 1 つの関数に持っていた。Profile の Recent / Long-term は同じ集計を Evidence の部分列に当てる必要がある。
- CPU の入力を作るのは `opponents/` と `hand-orchestrator.ts`（KnowledgeState は Engine で作り、Engine は apps/server を import できない）。

## 設計方針（判断）

1. **Evidence**: Ability Evidence をそのまま使う。Supporting は `improvement_suggested` / `major_leak`、Counter は `strong` / `reasonable`。`mixed_marginal` と `insufficient_evidence` は数えない（OI-006 の暫定値）。Ability Evidence に判断時点の特徴（`features`）を足し、type の分類に使う（追加だけ）。
2. **type**: Street と「Bet / Raise に直面していたか」で主の type を 1 つ、額を引き上げた判断は `bet_raise` にも入れる（5 種。Version 付きの一覧）。
3. **状態遷移**: n < 3 は insufficient_data。直近 5 件の窓より古い Evidence があり窓の Supporting が 0 なら resolved、1 以下で strong / supported なら improving。それ以外は割合と件数で strong（4 件以上・6 割以上）/ supported（2 件以上・4 割以上）/ suspected。Counter Evidence が増えると strong → supported → improving → resolved と弱くなる。しきい値は整数の比較で、浮動小数の誤差で揺れないようにした。
4. **Snapshot（v6）**: 列は D113 の範囲（`hypothesis_id`・`policy_version`・`type`・`status`・`supporting_evidence_ids`・`counter_evidence_ids`・`computed_at`）。sample_size・confidence は配列の長さと status から分かるので持たない。作り直しは全行を 1 トランザクションで入れ替える（派生データなので追記専用の Trigger は付けない）。`type` は Policy の Version ごとの一覧なので CHECK で固定せず、`status` は D104 の状態を CHECK する。
5. **Policy の Version**: `HypothesisPolicy phase6_hypothesis_v1` が使う `ScoringPolicy` を持つので、Snapshot の `policy_version` 1 つで両方が決まる。Profile は `ProfilePolicy phase6_profile_v1`（`recentDecisions: 100`）。
6. **有効 Decision**: Pass A の Review がある判断（D115）。Recent は判断の順で末尾 100 件。
7. **Profile と Snapshot**: Profile は Snapshot を読まず、同じ Evidence から同じ関数（`hypothesesFromEvidence`）で Hypothesis を作る（Profile を都度計算・保存しない D111 と、Snapshot を正本にしない D113 の両方を守る）。
8. **自然言語**: `renderProfileText` は Structured Profile だけを受け取るテンプレート。Structured Profile は文を持たない（過去の文を次の入力にしない）。
9. **情報境界**: `opponents/` と `hand-orchestrator.ts` から相対 import をたどって `learning/` に届かないことをテストする（陽性の対照つき）。
10. **集計の再利用**: `computeScoreReport` の集計部分を `scoreEvidence` に切り出した（`computeScoreReport` の結果は変えない。既存テストで確認）。

## 変更ファイル

- `apps/server/src/db/database.ts`（v6）・`db/database.test.ts`（表の一覧・v5 → v6 で既存の定義と行が変わらない）
- `apps/server/src/learning/ability-evidence.ts`（`features`）・`score.ts`（`scoreEvidence`）
- 新規: `learning/hypothesis-policy.ts`・`hypothesis.ts`・`hypothesis-snapshot.ts`・`profile.ts`・各テスト（`hypothesis.test.ts`・`hypothesis-snapshot.test.ts`・`profile.test.ts`・`learning-isolation.test.ts`）・`testing/learning-fixtures.ts`
- Docs: `docs/03` §1（`learning/`）・`docs/04` §7・§12・`docs/07` §4・§5・`docs/11` OI-006（暫定値の記録）

## 実行したコマンドと結果

- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`: 通過
- `pnpm test`: engine 355・web 126・server 504 件すべて通過

## 残課題

- 表示用の API・UI は #116、Learning Reset の区切り（D114）は #118、`drills` テーブル（D116）は #117。
- type の分類としきい値は OI-006 の暫定値。Playtest 後に Version を上げて見直す。
