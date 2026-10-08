# Issue #150: CPU Memory の都度計算に Cache を足すか測って決める

## 概要

#139（PR #149）で、Hand の開始ごとに保存済みの全 Hand の Event から CPU の Observation・Hypothesis（Memory）を都度計算するようにした（D111 と同じく保存しない）。保存済みの Hand が増えたときの遅さを、実 SQLite（一時ファイルの DB）で 1,000 / 5,000 Hand まで測った。**Cache は実装していない**（測定と記録、手で実行する測定スクリプト `bench:memory` の追加だけ）。Event の型・`schema_version`・マイグレーション・Memory / Tilt / Table Tendency の計算・Hand Orchestrator は変えていない。

**結論: 5,000 Hand では Hand の開始の層の合計が約 1 秒で、依頼時の目安（数百 ms 未満）を超える。1,000 Hand（約 220 ms）までは目安内。** 「現時点では Cache 不要」とは言えない。ボトルネックは Memory（5,000 Hand で合計の約 85%）で、保存済みの Hand の数にほぼ比例して伸びる。Cache の形（永続のテーブルか、プロセス内か）は設計判断・マイグレーション判断なので確定せず、人間判断に返した。

## 初期調査

- #142 の作業ログは「400 Hand で Hand ごとに約 14 ms」。ただし測った Store はメモリ内（`InMemoryEventStore`）で、本番の `SqliteEventStore`（Hand ごとに `SELECT` と JSON の復元・upcast）は入っていない。今回の実測では同じ 400 Hand で Memory が 12 ms（メモリ内）→ 約 58 ms（SQLite）と約 5 倍で、メモリ内の値を SQLite の見積もりに使えない。
- Hand の開始（`HandOrchestrator.startHand`）で層を作る箇所は `opponentMemories` / `opponentTilts` / `opponentTableTendencies`（`apps/server/src/hand-orchestrator.ts`）。Memory は `buildOpponentMemoriesFromStore` → Observer（CPU）ごとに `buildOpponentHypothesesFromStore` → `extractObservedHandsFromStore` で、保存済みの全 Hand の Event を読み、観察の抽出・Hypothesis の推定をやり直す。1 回の計算の間、Event の読み出しは Observer 間で使い回す（`cachedObservationStore`）。
- Tilt と Table Tendency は今の Session の Hand だけを読むが、`finishedHandIds()` で保存済みの全 Hand を走査し、Hand ごとに `sessionIdOfHand` を引いて今の Session かを判定している（`opponents/tilt.ts` の `loadTiltSources`・`memory/table-tendency.ts` の `loadTableTendencySources`）。Event の読み出しは今の Session の Hand だけ。

## 測定の目安（測定の前に決めた線）

依頼時の目安は「Hand の開始が人の操作の待ちとして気にならない程度（例: 5,000 Hand でも合計が数百 ms 未満）」。これを次の線にした（測定結果を見る前の指示文に基づく。500 ms は「数百 ms 未満」の上限として置いた）。

| 層の計算の合計（中央値） | 判定 |
|---|---|
| 500 ms 未満 | 実用上十分（Cache 不要） |
| 500 ms 以上 | Cache 等を検討する（人間判断に返す） |

## 測定の手順

- スクリプト: `apps/server/src/testing/memory-bench.ts`（`pnpm --filter @proj-poker/server bench:memory [--checkpoints 400,1000,2000,5000] [--repeats 30] [--session-hands 250] [--window 20]`）。手で実行する script で、CI の `pnpm test` には入らない（`*.test.ts` ではない）。Claude も API キーも使わない。
- DB の作り方: 使い捨ての一時ファイルの SQLite（`mkdtemp`、終了時に削除。開発データ `apps/server/data/poker.sqlite` には触らない）に、本番の `HandOrchestrator`（RuleBot・既定の 6 人卓・Hero は Check できれば Check、できなければ Fold）で Hand を溜める。Session は 250 Hand ごとに、最初の CPU の判断を障害にして「Session 終了」を選び区切る（本番の D86 の経路。#142 の Eval と同じ方法。区切りの Hand 自体も保存済みの 1 Hand に数える）。CPU は Fixed CPU の Pool なので、Memory は Session を跨いで全 Hand を読む。
- 測るもの:
  - **A. 層ごとの計算時間**（各 checkpoint で、Hand の開始の直前の状態に対して孤立して 30 回。1 回の warm-up は捨てる）: (1) Memory（Observation → Hypothesis → 注入の要約。CPU 5 人分）、(2) Tilt、(3) Table Tendency、(4) その合計。入力は #142 の `buildLayersAt`（本番の組み立ての写し。毎判断で CPU に渡った値と一致することを `memory-eval.test.ts` が確かめている）。この PR で `buildLayersAt` の引数の型を `InMemoryEventStore` → `EventStore` に広げた（型だけ。中身は不変）。参考として Memory のうち Event の読み出し（SQLite の `SELECT`・JSON の復元・upcast）だけの時間を 1 Observer 分、同じ回数で測る（本番は 1 回の計算の間、読み出しを Observer 間で使い回すので、5 人分でも読み出しは 1 回分）。
  - **B. Hand の開始全体 (5)**: `HandOrchestrator.startHand` の所要時間。層の計算に加え、Engine の開始・Event の追記・RuleBot の CPU が Hero の手番まで進める分を含む。checkpoint の直後の 20 Hand（打ち切りの Hand を除く）の中央値・最大・最小。層が無いに等しい序盤（保存済み 20〜59 Hand）を基準にして、その差で層の分を見る。
- 回数: A は各 checkpoint 30 回、B は各 checkpoint 19〜20 回。1 回の実行（Hand の生成に 2,706 秒＝約 45 分。Hand の開始が保存済みの数に比例して遅くなるため）。同じ条件の再実行はしていない。
- 環境: Node v24.18.0、AMD Ryzen 5 7500F 6-Core（8 スレッド）・メモリ 20 GiB・Linux（WSL2）x64、SQLite 3.53.1（`node:sqlite`）、DB は WSL の ext4 上の `/tmp` の一時ファイル。測定中は他の重い処理を並行させていない。

## 結果（ミリ秒。中央値 / 最大）

### A. 層ごとの計算時間（CPU 5 人分）

| 保存済みの Hand | 今の Session の Hand | Event 行数 | DB (MiB) | (1) Memory | うち Event の読み出し（1 Observer 分） | (2) Tilt | (3) Table Tendency | (4) 合計 |
|---|---|---|---|---|---|---|---|---|
| 400 | 149 | 7,342 | 3.2 | 57.81 / 70.45 | 21.43 / 26.62 | 19.21 / 28.74 | 21.80 / 27.63 | 99.35 / 119.68 |
| 1,000 | 232 | 20,975 | 8.5 | 147.64 / 181.02 | 53.47 / 71.53 | 36.70 / 52.08 | 34.69 / 42.41 | 219.00 / 255.94 |
| 2,000 | 228 | 41,440 | 17.0 | 338.01 / 398.02 | 191.87 / 223.34 | 47.55 / 58.67 | 50.50 / 65.76 | 434.33 / 498.70 |
| 5,000 | 216 | 105,344 | 42.9 | 831.08 / 961.90 | 263.98 / 302.57 | 74.46 / 83.48 | 72.31 / 88.73 | 981.59 / 1,112.78 |

### B. Hand の開始全体 `startHand`（(5)）

序盤の基準（保存済み 20〜59 Hand・40 回）: 中央値 26.66 / 最大 49.60 / 最小 14.51。

| 保存済みの Hand（開始時） | 回数 | startHand 中央値 | 最大 | 最小 | 基準との差（中央値） |
|---|---|---|---|---|---|
| 400〜419 | 20 | 95.23 | 105.67 | 79.28 | 68.56 |
| 1,000〜1,019 | 19 | 220.55 | 248.71 | 188.03 | 193.89 |
| 2,000〜2,019 | 20 | 393.07 | 495.34 | 350.61 | 366.41 |
| 5,000〜5,019 | 20 | 983.47 | 1,072.91 | 935.44 | 956.81 |

## 読み取り

- **合計は Memory が支配し、保存済みの Hand の数にほぼ比例する**。Memory は 1 Hand あたり約 0.15〜0.17 ms（400: 0.145 / 1,000: 0.148 / 2,000: 0.169 / 5,000: 0.166）。5,000 Hand で合計の約 85%。Memory のうち Event の読み出し（1 Observer 分）は 5,000 Hand で約 264 ms（Memory の約 32%）、残り約 570 ms は観察の抽出・Hypothesis の推定（5 人分）の計算。
- **Tilt と Table Tendency は今の Session の Hand 数にも比例する**（Session は約 220 Hand で一定）が、保存済みの全 Hand の数でも伸びる（Tilt: 1,000 Hand 37 ms → 5,000 Hand 74 ms、Session の Hand 数はほぼ同じ）。原因は `finishedHandIds()` の全走査と Hand ごとの `sessionIdOfHand` の引き（Event を読むのは今の Session の Hand だけ）。保存済みの Hand が増えても Session の Hand が増えなければ、この分の伸びはあるが小さい（5,000 Hand で 2 層合計 約 147 ms）。
- (5) の `startHand` の基準との差（957 ms）は、(4) の合計（982 ms）とほぼ一致する。Hand の開始の遅さの大半は層の計算で、CPU を Hero の手番まで進める分（序盤の基準 約 27 ms）は小さい。
- 目安との突き合わせ: 1,000 Hand（合計 約 220 ms）・2,000 Hand（約 434 ms）は 500 ms 未満で十分。**5,000 Hand（約 982 ms、最大 約 1.1 秒）は線を超える**。Hand の開始のたびに約 1 秒待つ（CPU の手番の演出の前の、Hand が始まらない待ち）。
- どの Hand 数から目安を超えるか: Memory がほぼ線形なので、合計 500 ms は保存済みの Hand が約 2,400 前後（2,000 Hand の 434 ms と 5,000 Hand の 982 ms の線形補間）。
- #142 の見積もり（400 Hand で Hand ごとに約 14 ms）は、メモリ内の Store で測った値。実 SQLite では同じ 400 Hand で合計 約 99 ms（Memory 約 58 ms）で、約 7 倍。

## 判断

**Cache の要否は、目安を超える（5,000 Hand で約 1 秒）ので「現時点では不要」とは言えない。** ただし次の理由で Cache の形は確定せず、人間判断に返す。

1. 永続 Cache（Observation・Hypothesis のスナップショットのテーブル）はマイグレーション（スキーマ変更）で、設計判断・人間確認の対象（`github-workflow`「必ず人間確認で停止する条件」・`implementation-guidance/references/db.md` の停止条件）。
2. 永続化しない手（プロセス内のメモリ Cache・計算の増分化・Tilt / Table Tendency の走査の絞り込み）も、Memory の抽出の単位・無効化（Opponent Memory Reset・Guest の Session 限りの扱い・再起動）に関わる設計判断。
3. 保存済みの Hand は append-only（Event・`hands` は UPDATE / DELETE を拒否する）なので、Hand ごとの観察の抽出結果は Hand が保存された後は変わらない。この性質は Cache の根拠になるが、Projection を正本にしない（消しても Event Log から作り直せる）条件は守る。

選択肢（要約）:

- **A. 現状維持**（Cache を足さない）。1,000 Hand 前後までは目安内。5,000 Hand で約 1 秒を許容するか、Hand 数が増えた時点で再測定する。
- **B. マイグレーション無しの最適化**: (B-1) Tilt / Table Tendency の全 Hand 走査を今の Session の Hand だけにする（5,000 Hand で 2 層合計 約 147 ms のうち走査分を削る。小さい）。(B-2) Memory の Hand ごとの抽出結果をプロセス内で使い回す（再起動で消える。初回の 1 回だけ全 Hand を読む）。
- **C. 永続 Cache**（マイグレーション v12 など。Hand の保存と同じトランザクションで更新、または消して Event Log から作り直せる形）。
- 推奨: **B（まず B-2 と B-1）**。スキーマ変更が要らず、Projection を正本にしない条件を守りやすい。C は B で足りないと測って分かってから。

## 実行した確認

- `pnpm --filter @proj-poker/server bench:memory`（既定の checkpoint 400 / 1,000 / 2,000 / 5,000・30 回・Session 250 Hand）: 上の結果。動作確認として `--checkpoints 100,200 --window 10 --repeats 5` も実行し、同じ形で出力されることを確かめた（11 秒）。
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`: すべて通過（server 57 files / 729 tests・web 9 files / 141 tests）。

## 変更ファイル

- `apps/server/src/testing/memory-bench.ts`（新規）: 手で実行する測定スクリプト
- `apps/server/package.json`: `bench:memory`
- `apps/server/src/testing/opponent-eval/memory-eval.ts`: `buildLayersAt` の `store` の型を `EventStore` に広げた（型のみ。中身は不変）
- `docs/taskLog/issue-150-memory-perf.md`: 本ログ
- 触っていない: `apps/web/`・`e2e/`・`docs/decision_log.yaml`・Memory / Tilt / Table Tendency の計算・Hand Orchestrator・マイグレーション

## 残課題

- Cache の要否・形（上の A / B / C）の人間判断。判断後に別 Issue（#106 配下）で実装する。
- Tilt / Table Tendency の `finishedHandIds()` の全走査（Hand 数に比例する小さな伸び）は、B-1 を採るときにまとめて直す。
- 測定は 1 回の実行（Hand の生成が約 45 分かかるため再実行していない）。層の測定は各 checkpoint 30 回の中央値・最大。
