# Issue #174: observed_hand_cache の DB の大きさ（Observer ごとの Event の重複）を測って決める

## 概要

#165（PR #173・D124）の v12 `observed_hand_cache` を入れた後の `bench:memory` で、5,000 Hand の DB が 42.9 MiB（#150）→ 106.1 MiB（約 2.5 倍）になった。Cache の JSON（`observed` + `events`）の合計は 21.4 MiB で、ファイル全体の差（約 63 MiB）を説明しきれていない。この Issue は **測定だけ**を行い、Schema（表の形）を変えずに Close できるかを決める。実装・マイグレーション（v13）・Cache の挙動の変更はしない（表を変えるなら D124 の範囲を確認する人間判断になる）。

切り分けたいこと: 膨張が (1) 実データ（Observer ごとの行に同じ `events` を重複して持つ分・索引・ページの余白）か、(2) 空きページ（`bench:memory` は各 checkpoint の層の測定で Cache を `DELETE FROM observed_hand_cache` で全削除してから作り直すので、freelist や断片化が残りうる）か。

## 判定の基準（結果を見る前に決めた。後から動かさない）

判定は **VACUUM 後の「実データ」の大きさ**（=温めた Cache の行を全部持った、空きページの無い DB）で行う。

1. **膨張の大部分が freelist / 断片化** — 「温めた状態の DB」と「Cache 無し（Event Log だけ）の fresh な DB」の差（= 膨張分）のうち、`VACUUM` で縮む分が過半 → **現設計を維持して Close**（空きページは SQLite が再利用する。気になれば手動の `VACUUM` で解消できると記録する）。
2. **実データが支配的でも許容できる** — 次をすべて満たすなら、測定結果を残して **Close**。
   - 10,000 Hand の見込み（VACUUM 後。5,000 Hand の値を 2 倍して見る）が **300 MiB 以下**
   - Cache 分の増分が **Event Log の増分（Hand あたり）の 2 倍以内**
   - 理由: ローカル単一ユーザー用途。Hand を 1 つ約 1 分で遊ぶと 10,000 Hand は約 170 時間のプレイ。数百 MiB の SQLite は読み書きに問題が無く、Memory の時間は #165 で目安（500 ms）に入っている。
3. **NEEDS_HUMAN（実装せず返す）** — 10,000 Hand の見込みが **1 GiB を超える**、または Cache 分の増分が **100 KiB / Hand を超える**、または 300 MiB〜1 GiB の中間で **`events` 列の重複が Cache の実データの過半かつ重複除去で 3 分の 1 以上減らせる**場合。表の正規化は D124 の範囲の確認とマイグレーションを伴うので、実装せず人間判断にする。

「Hand あたりの増分」は (5,000 Hand の値 − 空の DB の固定分) / 5,000 の概算で、10,000 Hand の見込みは線形外挿（Hand 数に比例する表だけなので、Event Log・Cache とも線形と見る）。

## 変更したもの

- `apps/server/src/testing/memory-bench.ts` のみ: `--size-report`（既定は off。手で実行する script のまま・CI の `pnpm test` には入らない）を足した。各 checkpoint の層の測定の直前（Cache を全削除する前）に DB ファイルを使い捨てのコピーへ複製して「そのままの大きさ・freelist・Cache の実データ・dbstat・VACUUM 後・Cache を消して VACUUM（Event Log だけ）」を測り、実行の最後の DB も同様にコピーして S1〜S6 の状態を測る。元の DB（一時ファイル）・開発データ（`apps/server/data/`）には触れない。Cache の挙動（`observation-cache.ts`）・Schema・マイグレーション・プロダクトのコードは変えていない。
- 測定結果は下記。プロダクトの挙動を変えないので `docs/03` / `docs/04` の更新は無い。

## 測定の経緯（1 回目は測り方の欠陥を見つけて捨て、2 回目を採用した）

- 同じ条件（`pnpm --filter @proj-poker/server bench:memory --size-report`。既定の引数・Node v24.18.0・AMD Ryzen 5 7500F・WSL2・SQLite 3.53.1・page_size 4096・Hand の生成は各 約 1,530 秒）で 2 回走らせた。
- 1 回目は実行の最後の DB（S1〜S6 だけ）を測った。S1（bench の最後の DB）は freelist が 33.5%・VACUUM で 106.1 → 69.8 MiB に縮んだため、いったん「空きページが主因」に見えた。
- しかし S5（Cache 無しの DB に Cache を温め直す）は 69.8 MiB で、行数が 11,041 行。**bench の層の測定は `DELETE FROM observed_hand_cache` の後、今の卓の CPU・Guest の Observer の分だけを作り直す**ので、全削除の前（Hand の開始ごとに足してきた全 Observer の Cache。2 回目の測定で 23,375 行）より小さい。つまり S1 の freelist は **測定のための全削除が作った**もので、5,000 Hand の checkpoint で 106.1 MiB を測った時点（全削除の前）には freelist が無かった。VACUUM の前後を比べる対象を間違えていた。
- そこで 2 回目は、全削除の前の DB を複製して測る処理（C1b）を足した。**採用する値は 2 回目の C1b**（本番の運用に近い、全削除をしていない増え方の DB）。`#165` の作業ログと bench の表の「Cache の行数 / JSON」（10,984 行 / 21.4 MiB）は、全削除→作り直しの後の値で、全 Observer の分ではない（表の見出しに注記した）。

## 測定結果（2 回目。5,000 Hand の checkpoint の直前 = 全削除の前の DB）

### (d)(e) ページと VACUUM（使い捨てのコピー）

| 保存済みの Hand | ファイル (MiB) | page_size | page_count | freelist_count | VACUUM 後 (MiB) | 縮んだ割合 | (a) Cache を消して VACUUM（Event Log だけ・MiB）|
|---|---|---|---|---|---|---|---|
| 400 | 6.49 | 4096 | 1,661 | 0 | 6.44 | 0.7% | 3.15 |
| 1,000 | 20.34 | 4096 | 5,208 | 0 | 20.20 | 0.7% | 8.42 |
| 2,000 | 40.86 | 4096 | 10,461 | 0 | 40.52 | 0.9% | 16.72 |
| 5,000 | 106.11 | 4096 | 27,165 | 0 | 105.27 | 0.8% | 42.16 |

- **freelist は 0、VACUUM で縮むのは 0.8%（0.84 MiB）だけ**。膨張（106.11 − 42.16 = 63.95 MiB）の大部分は空きページ・断片化ではなく、Cache の実データ。
- 5,000 Hand の Event Log だけの DB（fresh）は 42.16 MiB（実行の最後の S4 は 42.35 MiB で、#150 の 42.9 MiB と一致）。

### (b)(c) Cache の行数と実データ（5,000 Hand・全削除の前）

| 項目 | 値 |
|---|---|
| 行数 | 23,375 行（座っている行 14,426・座っていない Hand の NULL 行 8,949・Observer 15 人）。1 Hand あたり 4.7 行（座っている行 2.9） |
| `observed` の列 | 13.03 MiB |
| `events` の列 | 36.38 MiB |
| 鍵の列（`observer_key`・`hand_id`・`extraction_version`・`hero_player_id`） | 1.73 MiB |
| 実データの合計 | 51.14 MiB |
| 参考: Event Log の `payload` | 約 22.6 MiB（105,812 行。実行の最後の値） |
| `events` の Observer 間の重複（Hand ごとに 1 回だけ持つなら 11.66 MiB） | **24.72 MiB**（`events` 列の 68%・Cache の実データの 48%・DB 全体の約 23%） |

### dbstat（5,000 Hand・全削除の前。使用 MiB = ページの合計 / 実データ payload MiB）

| 表・索引 | 使用 | payload | ページ内の未使用 |
|---|---|---|---|
| `events`（表） | 34.76 | 31.83 | |
| `events` の索引 2 つ | 7.21 | 5.83 | |
| `observed_hand_cache`（表） | 62.08 | 51.40 | 10.35（ページ内の未使用） |
| `observed_hand_cache` の主キーの索引 | 1.14 | 0.95 | |
| その他 | 0.92 | | |

Cache の表のページ使用 62.08 MiB は実データ 51.40 MiB より 10.7 MiB 大きい（VACUUM 後も変わらないページ内の余白）。1 行の平均は約 2.3 KiB で、4 KiB のページに 2 行目が入らない行があるなど、ページへの詰まり方による余白と考えられる。この測定では原因までは切り分けていない。

### 実行の最後の DB（参考。S1〜S6。Cache は全削除→今の卓の Observer の分だけ作り直し済み）

| 状態 | ファイル (MiB) | page_count | freelist_count | 空き割合 |
|---|---|---|---|---|
| S1 bench の最後の DB（そのまま） | 106.11 | 27,165 | 9,110 | 33.5% |
| S2 S1 を VACUUM | 69.75 | 17,855 | 0 | 0% |
| S3 S1 の Cache を全削除（VACUUM なし） | 106.11 | 27,165 | 16,136 | 59.4% |
| S4 S3 を VACUUM（Event Log だけ） | 42.35 | 10,841 | 0 | 0% |
| S5 S4 に Cache を 1 回温める（今の卓の Observer の分だけ・11,044 行・1,157 ms） | 69.79 | 17,866 | 0 | 0% |
| S6 S5 を VACUUM | 69.74 | 17,854 | 0 | 0% |

S1 の freelist 9,110 ページ（約 35.6 MiB）は、層の測定の全削除（23,375 → 11,041 行に減る）が作ったもの。本番の運用（Cache を全削除しない）では出ない。S5 → S6 で VACUUM しても縮まない（69.79 → 69.74 MiB）。

### Hand あたりの増分と 10,000 Hand の見込み

| | Event Log | Cache | 合計（VACUUM 後） |
|---|---|---|---|
| 5,000 Hand の大きさ (MiB) | 42.16 | 63.11 | 105.27 |
| Hand あたり (KiB) | 8.6 | 12.9 | 21.5 |
| 400 → 1,000 → 2,000 → 5,000 の Cache の Hand あたり (KiB) | | 8.4 → 12.1 → 12.2 → 12.9（2,000 → 5,000 の限界値は 13.4） | |
| 10,000 Hand の見込み（5,000 の値の 2 倍） | 約 84 MiB | 約 126 MiB | **約 211 MiB** |

Cache は Observer の数に比例して少し増える（Observer は 7 → 15 人）ので、Hand 数に対してわずかに線形より傾く（2,000 → 5,000 の限界値 13.4 KiB / Hand で見ても 10,000 Hand は約 215 MiB）。上限の目安: 座っている行は 1 Hand に最大 5 行（卓の CPU の数）で、今の bench は 2.9 行なので、最悪（毎 Hand 5 行）でも Cache は約 1.7 倍、10,000 Hand で約 310 MiB 程度（1 GiB には届かない）。

## 判定（事前に決めた基準に当てる）

1. 基準 1（膨張の大部分が freelist / 断片化）: **該当しない**。VACUUM で縮むのは膨張分 63.95 MiB のうち 0.84 MiB（1.3%）。空きページ仮説は棄却。
2. 基準 2（実データが支配的でも許容できる）: **満たす**。
   - 10,000 Hand の見込み 約 211 MiB ≤ 300 MiB（最悪の上限の見積もりでも約 310 MiB で 1 GiB を大きく下回る）
   - Cache 分の Hand あたり増分 12.9 KiB は Event Log の 8.6 KiB の 1.50 倍 ≤ 2 倍
3. 基準 3（NEEDS_HUMAN）: **該当しない**（1 GiB 超でも 100 KiB / Hand 超でもない。中間の帯でもない）。

**結論: Schema を変えずに Close する。** 実データの重複（`events` の 24.72 MiB = DB の約 23%）は確かにあるが、ローカル単一ユーザー用途で 10,000 Hand（約 170 時間のプレイ）でも約 211 MiB、SQLite には問題の無い大きさで、Memory の時間は #165 で目安に入っている。表の正規化（Hand ごとの public の Event を 1 行にする）は D124 の範囲の確認とマイグレーションが要るのに、得られるのは約 23% の縮小なので、いまは見合わない。

## 残課題（Close する Issue には影響しない）

- もし将来 DB の大きさが問題になったら、`events` の重複（Hand ごとの public の Event を 1 行）と、Cache の表のページ内の余白（10 MiB 超。原因は未切り分け）が削る候補。その時点で実測してから別の人間判断にする。
- 手動の `VACUUM` は Event Log の削除や Cache の全削除をした後の空きページの回収に使える（Cache は Version を上げたときだけ全削除される）。運用手順としては今は足さない。

## 実行した確認

- `pnpm --filter @proj-poker/server bench:memory --size-report`（上の 2 回）。測定中、他の重い処理は並行させていない
- 小さい実行での動作確認: `bench:memory --checkpoints 100,300 --repeats 3 --size-report`（値は使わない）
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check`（下のコミットの時点）
