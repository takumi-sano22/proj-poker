# Issue #118 [Phase6] P6-7 Learning 系のカテゴリ別 Reset と Projection の作り直しをそろえる

## 目的

Learning Reset（Ability Score・Weakness Hypothesis・自然言語の Player Profile）をカテゴリ別に実行でき、Event Log・Review の正本を壊さずに、Score / Hypothesis / Profile を Reset 後の Evidence だけで作り直せるようにする。Policy Version を変えた後も正本から再計算でき、過去の自然言語の Profile を入力に再利用しないことをテストで確かめる。

## 前提（人間判断）

- D114: Learning Reset は削除ではなく、追記型のテーブル（Reset の時刻・対象カテゴリ）に区切りの行を足す。Score / Profile / Hypothesis はそれぞれ、そのカテゴリを含む最後の Reset より後の Evidence だけで計算し、Hypothesis の Snapshot（D113）はその条件で作り直す。正本と削除拒否の Trigger は残す。User Read / Note / Tag はどの Reset でも消さない
- マイグレーション v8（`learning_resets`）は D114 の人間判断の範囲。ほかのスキーマ変更はしない
- 範囲外: Opponent Memory Reset（P7-8）・Hand History Delete・Factory Reset

## 設計

- **カテゴリ**: `score`（Ability / Overall Score。Profile の Recent / Long-term と M 件中 N 件、Drill の系列の Score〔暫定〕）・`hypothesis`（Weakness Hypothesis と Snapshot）・`profile`（自然言語の Player Profile）。docs/04 §11 の「削除」の 3 項目（Ability Score・User Hypothesis・Generated Player Profile）と 1 対 1。Opponent Memory は別テーブルにし、名前を分ける
- **テーブル**: v8 の `learning_resets`（`seq`・`reset_id`・`created_at`・`category`〔CHECK〕・`UNIQUE(reset_id, category)`）。1 回の Reset はカテゴリごとの行を 1 トランザクションで足す。`UPDATE` / `DELETE` は Trigger で拒否
- **区切りの判定**: Hand の終わりの Event（`HAND_FINISHED` / `HAND_ABORTED`）の `recorded_at` が、そのカテゴリの Reset の時刻（最も遅いもの）より**後**の Hand だけを使う（同じ時刻は含めない）。Review の作成時刻では切らない（M と N を同じ Hand で数えるため。Reset 前の Hand を Reset 後に Review しても入らない）
- **計算の置き場所**: 純粋関数（`computePlayerProfile` 等）は変えず、`LearningService` が区切りより後に終わった Hand だけを渡す。カテゴリごとに Structured Profile を作り、Score 部分・Hypothesis・文をそれぞれ取る
- **Snapshot**: `hypothesis` を含む Reset の時点と Profile を読むたびに、区切りより後の Evidence の Hypothesis で全行を入れ替える
- **変えないもの**: Stats（D114 の対象外）・Session Review（1 Session の振り返り。暫定。docs/04 §11・docs/07 §6 に明記）・Event Log・reviews・Note / Tag・Drill の一覧
- **Drill の系列**: 迷ったので指示どおり `score` のカテゴリに従わせ、docs に暫定と書いた
- **UI**: Player Profile の下に Learning Reset の欄（チェックで項目を選ぶ → 確認の面〔危険色の縁・初期フォーカスは「やめる」〕→ `.btn--danger` の「数え直す」）。送信中は状態と ref の 2 層で二重送信を防ぎ、画面を離れた後の応答は捨てる。Reset 後は欄ごとに「Reset 後」と区切りの時刻を出す

## 変更ファイル

- Server: `apps/server/src/db/database.ts`（v8）・`db/database.test.ts`・`learning/learning-reset.ts`（新規）・`learning/learning-reset.test.ts`（新規）・`learning/learning-service.ts`・`learning/hypothesis-snapshot.ts`（コメント）・`drill/drill-service.ts`・`routes/learning.ts`・`routes/learning.test.ts`・`routes/drills.test.ts`・`app.ts`・`index.ts`
- Web: `apps/web/src/components/LearningReset.tsx`（新規）・`components/SessionReviewScreen.tsx`・`components/session-review.test.tsx`・`lib/learning-api.ts`・`lib/learning.ts`・`lib/drill-api.ts`・`styles.css`
- Docs: `docs/03` §1（learning / drill の説明・API 表・UI）・`docs/04` §11 / §12・`docs/06` §14・`docs/07` §2 / §3 / §4 / §5 / §6 / §7

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 363・web 141・server 549 件 pass）/ `pnpm format:check`（ルート）
- 区切りを無視する変更（`endedAfter(s, null)`）を一時的に入れると、`learning-reset.test.ts` の 4 件と `routes/learning.test.ts` の 1 件が落ちることを確かめた（変更は戻した）
- マイグレーション: 版 7 の DB に v8 を当てても既存のテーブルの定義と行が変わらないこと、`learning_resets` の追記専用・カテゴリの CHECK・一意制約をテストで確認
- UI の実測（Playwright の一時的な spec・使い捨ての DB・`REVIEW_PROVIDER=fake`・`TABLE_SIZE=2`・Hero が毎手番 All-in で 22 Hand で Session 終了 → 1 判断の Review を作った状態）:
  - Learning Reset の欄（通常・確認の面）: 1280×900・375×667・320×568 で横スクロール 0。375 で確定の Button の中心の `elementFromPoint` が Button 自身。確認を開くと「やめる」にフォーカス
  - 数え直した後: Profile が「Reset 後の判断 0 件中 0 件」と区切りの時刻を出し、Hero の Stats（全期間）の表示は前と同じ、Session Review の「この Session の判断 … 件中 1 件」と Replay の Hand 数（22）は変わらない。ページエラーなし
- 一時的な spec は消した。実測用の server / web は止めた

## 残課題

- Session Review を Reset の対象にしない・Drill の系列を `score` に従わせる、はどちらも暫定（docs に明記）。使ってみて変えるなら別 Issue で決め直す
- Reset の取り消し（区切りを無効にする行）は作っていない（D114 の範囲外。UI で「取り消せない」と示す）
