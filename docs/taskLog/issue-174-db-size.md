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
