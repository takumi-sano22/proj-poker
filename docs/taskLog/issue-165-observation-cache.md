# Issue #165: CPU Memory の永続 Cache を足す（D124）

## 概要

#150（PR #164）の測定で、実 SQLite の Hand の開始が 5,000 Hand で約 0.98 秒（中央値。約 85% が Memory）だった。人間判断 D124（PR #172）で、Hand ごとに抽出した Observation（Observer 別・抽出の Version 付き）をマイグレーション v12 の派生の表に Cache し、Hand の開始で Memory を読むときに足りない分だけ補うことに決まった。この Issue はその実装と効果の測定。

## 初期調査

- Memory の入口は Hand Orchestrator の `opponentMemories` → `buildOpponentMemoriesFromStore`（`memory/memory-summary.ts`）→ CPU ごとに `buildOpponentHypothesesFromStore` → `extractObservedHandsFromStore`（`memory/observation.ts`）。1 回の計算の間、Hand の Event と Session の参加者の読み出しは CPU 間で使い回していた（`cachedObservationStore`）が、保存済みの Hand の一覧・Hand の Session・論理順序（`finishedHandIds` / `sessionIdOfHand` / `savedOrder`）は CPU ごとに引き直していた。
- `extractObservedHands` の結果のうち Query に依るのは、(a) Observer、(b) Hero の席、(c) 今の Session（前の Session の Hand では Guest の Subject を引かない。D118）、(d) Reset の区切り（候補の Hand を外すだけ）。(a)(b) は Cache の鍵に、(c) は読むときの変換に、(d) は候補の選び方（Event Log 側）に分けられる。
- 1,000 Hand の使い捨て DB（scratchpad。本番の Orchestrator・RuleBot で生成）で試作を測ると、Cache の有無より、CPU ごとの `sessionIdOfHand` / `savedOrder` の引き直し（1 Observer で約 16 ms × CPU 5 人）の方が大きい部分があった。これは計算の間だけの使い回しで消せる（結果は変わらない）ので、同じ PR に入れた。

## 設計方針（D124 の範囲）

- **表**: マイグレーション v12 で `observed_hand_cache` を 1 つ足す。主キー `(observer_key, hand_id)`、列は `extraction_version`・`hero_player_id`・`ord`・`observed`（Observer の席・context・席→参加者・Event ごとの行為者）・`events`（Observer が見た public の Event の列）。座っていない Hand は両方 NULL の行（読み直さないため）。DELETE を許し、追記専用の Trigger は付けない（v6 の `hypothesis_snapshots` と同じ）。`hands` を外部キーで参照しない（Cache が正本の行の削除を妨げない）。既存の表・列・行・Trigger は変えない（D76）。
- **Version**: `OBSERVATION_EXTRACTION_VERSION = "phase7_observation_v1"` を新設し、表には `EVENT_SCHEMA_VERSION` と組にした値（`phase7_observation_v1+event_schema_v8`）を書く。Cache の `events` は upcast 後の形なので、Event の版が上がったときも古い形を使わないため。違う Version の行は読まず、プロセスで最初に読むときに消して作り直す。
- **更新**: Hand の開始で Memory を作るとき、Observer ごとに候補の Hand（`observationCandidates`。Event Log 側で選ぶ）のうち、Cache に行の無い Hand（`ord` と `hand_id` で引く）だけを Event Log から抽出して足す。Hand の保存のトランザクションは変えない。行の形が合わなければ作り直して置き換える。
- **判定は Event Log 側**: Observer が参加者か・Guest の Observer は今の Session だけ・Opponent Memory Reset の区切り・論理順序は、候補を選ぶとき（今までの `loadObservationSources` と同じ規則を `observationCandidates` に切り出した）に判定し、Cache に持たない。Cache の行はその Hand の Session を「今」として抽出し、前の Session の Hand の Guest を null にする扱いは読むときに当てる。
- **失敗**: Cache の読み書きに失敗しても Memory は Event Log から計算を続け、結果を変えない（warn に残す）。メモリ内の Event Store（テスト用）では Cache を使わない。
- Hypothesis の recency / Sample の集計（`opponent-hypothesis.ts`）・Tilt・Table Tendency・Prompt は変えていない。

## 変更ファイル

- `apps/server/src/db/database.ts`: マイグレーション v12（`observed_hand_cache`）
- `apps/server/src/memory/observation-cache.ts`（新規）: Version 定数・`ObservationCacheReader`（Cache を通した抽出）・`SqliteObservationCache`
- `apps/server/src/memory/observation.ts`: 候補の選び方を `observationCandidates` に切り出し（`loadObservationSources` はそれを使う。規則は不変）
- `apps/server/src/memory/memory-summary.ts`: `observationCache` を受け取り、Cache を通して抽出する。1 回の計算の間、`finishedHandIds` / `sessionIdOfHand` / `savedOrder` も CPU 間で使い回す
- `apps/server/src/hand-orchestrator.ts`・`app.ts`・`index.ts`: Cache の配線（起動時は同じ DB の `SqliteObservationCache`）
- `apps/server/src/testing/opponent-eval/memory-eval.ts`・`testing/memory-bench.ts`: bench が本番と同じく Cache を使い、Cache なし・Cache を消した直後の 1 回も測る
- テスト: `memory/observation-cache.test.ts`（新規）・`db/database.test.ts`（v11→v12・表の制約。古い版の検査は新しい表を除外）・`memory/observation-isolation.test.ts`（検査の入口に `observation-cache.ts`）
- docs: `docs/04` §6・§11・§12、`docs/03`（`memory/`）、README（Phase 7 の記述）

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（ルート。server 60 files / 769 tests・engine 363・web 141 が通過）
- `pnpm --filter @proj-poker/server bench:memory --checkpoints 100,300 --repeats 3`（bench の改修の動作確認。値は使わない）
- `pnpm --filter @proj-poker/server bench:memory`（既定: checkpoints 400,1000,2000,5000・repeats 30。下の測定。1 回の実行）
- PR の CI（check・e2e）が pass

## 測定（bench:memory）

- 手順は #150（`docs/taskLog/issue-150-memory-perf.md`）と同じ（同じスクリプト・既定の引数・同じマシン。Node v24.18.0・AMD Ryzen 5 7500F・WSL2・SQLite 3.53.1）。違いは、Hand Orchestrator と層の測定 (1)〜(4) が本番と同じく Cache（`SqliteObservationCache`）を使うこと。(1) は Hand の開始ごとに足りない Hand を足してきた温まった状態。比べるため、同じ時点で Cache なし（Event Log から都度抽出。この PR の CPU 間の使い回しは入る）を同じ回数、Cache を全部消した直後の 1 回（全 Hand を作り直して Cache に足す）も測った。
- 1 回の実行（Hand の生成に 1,329 秒。#150 は 2,706 秒）。Cache の読み書きの失敗（warn）は 0 回。測定中は他の重い処理を並行させていない（PR の CI は GitHub 側）。

### A. 層ごとの計算時間（ミリ秒。中央値 / 最大。CPU 5 人分）

| 保存済みの Hand | DB (MiB) | Cache の行数 / JSON (MiB) | (1) Memory（Cache あり） | Memory（Cache なし） | Memory（Cache を消した直後の 1 回） | (2) Tilt | (3) Table Tendency | (4) 合計（Cache あり） |
|---|---|---|---|---|---|---|---|---|
| 400 | 6.5 | 549 / 1.2 | 16.28 / 22.29 | 42.03 / 56.95 | 102.89 | 17.55 / 24.87 | 17.36 / 22.08 | 51.49 / 64.55 |
| 1,000 | 20.4 | 1,730 / 4.4 | 52.51 / 67.39 | 126.73 / 158.08 | 296.79 | 38.46 / 51.02 | 36.24 / 53.32 | 129.40 / 171.05 |
| 2,000 | 40.9 | 3,194 / 8.2 | 106.52 / 121.44 | 238.74 / 278.70 | 416.69 | 41.81 / 54.00 | 41.52 / 50.35 | 194.20 / 212.01 |
| 5,000 | 106.1 | 10,984 / 21.4 | 310.48 / 348.31 | 699.32 / 823.43 | 1,115.08 | 78.57 / 102.34 | 73.10 / 88.32 | 466.37 / 505.57 |

（Event 行数・今の Session の Hand は #150 と同じ: 400 / 7,342・149、1,000 / 20,975・232、2,000 / 41,440・228、5,000 / 105,344・216。Event の読み出し〔1 Observer 分〕は 5,000 Hand で 264.98 ms と #150 の 263.98 ms とほぼ同じで、条件がそろっている。）

### B. Hand の開始全体 `startHand`（ミリ秒。中央値 / 最大 / 最小）

序盤の基準（保存済み 20〜59 Hand）: 31.57 / 44.20 / 25.04。

| 保存済みの Hand（開始時） | 回数 | 中央値 | 最大 | 最小 | 基準との差（中央値） |
|---|---|---|---|---|---|
| 400〜419 | 20 | 65.18 | 76.58 | 58.54 | 33.61 |
| 1,000〜1,019 | 19 | 150.68 | 218.59 | 123.16 | 119.12 |
| 2,000〜2,019 | 20 | 214.85 | 258.08 | 196.33 | 183.29 |
| 5,000〜5,019 | 20 | 476.68 | 546.48 | 454.16 | 445.12 |

### #150 との比較（中央値・ミリ秒）

| 保存済みの Hand | Memory: #150 → #165 | 層の合計: #150 → #165 | startHand: #150 → #165 |
|---|---|---|---|
| 1,000 | 147.64 → 52.51（-64%） | 219.00 → 129.40（-41%） | 220.55 → 150.68（-32%） |
| 5,000 | 831.08 → 310.48（-63%） | 981.59 → 466.37（-52%） | 983.47 → 476.68（-52%） |

### 読み取り

- 5,000 Hand で層の合計は約 0.47 秒になり、#150 の目安（500 ms 未満）に入った（最大は 505.57 ms で線の上下）。Memory は Hand 数にまだほぼ比例する（1 Hand あたり約 0.06 ms。#150 は約 0.166 ms）。Hypothesis の recency / Sample の集計（D124 で Cache しない）と、候補の選び方（Hand ごとの Session・`ord`・参加者の引き。1 回の計算で 1 回）が残る。
- 内訳: 同じ時点の Cache なし（699.32 ms）と #150（831.08 ms）の差は、この PR の CPU 間の使い回し（`finishedHandIds` / `sessionIdOfHand` / `savedOrder`）の分。Cache あり（310.48 ms）との差が Cache の分。
- Cache を全部消した直後の 1 回（5,000 Hand で 1,115 ms）は Cache なしより遅い（全 Hand を抽出して Cache に書くため）。デプロイ直後・Version を上げた直後の最初の Hand の開始だけで、次からは温まった値になる。
- DB の大きさ: 5,000 Hand で 106.1 MiB（#150 は 42.9 MiB）。Cache の JSON は 21.4 MiB（10,984 行。Observer ごとに public の Event の列を持つ）。ファイル全体の差（約 63 MiB）が JSON の量より大きい理由（主キーの索引・各 checkpoint の全行の DELETE で空いたページ等）はこの測定では切り分けていない。
- Tilt と Table Tendency は #150 とほぼ同じ（触っていない）。

## 残課題

- Hypothesis の集計を Cache しない（D124）ので、Memory は Hand 数に比例して伸び続ける（5,000 Hand で約 0.31 秒）。さらに Hand が増えて目安を超えたら、集計の Cache は D124 の範囲外の設計判断なので別の人間判断にする。
- DB の大きさの増え方（Cache が Event Log の約 1.5 倍の割合で増えた）を切り分けていない。気になる量になったら別 Issue で測る。
