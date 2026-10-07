# Issue #119: Phase 6 の Eval・Critical E2E と README を更新する

## 概要

Phase 6（Session Learning）の最終 PR（P6-8）。Phase 6 の学習の流れ（Session の終わりまで Play → Review → Session Review → Player Profile → Targeted Drill → 練習した判断の Review → Learning Reset → 再起動）を Playwright の Critical E2E として 1 本足し、Hidden Persona / Learning-only Reveal の Leakage 0 の統合テストを足し、README と `docs/09` を Phase 6 の到達点に更新した。Event の形・永続化スキーマ・マイグレーションは変えていない。

## 初期調査

- 前提（main 1cde59f。#112〜#118 がマージ済み）
  - Session Review の画面の入口は、Session が終わった後（Hero の Bust・Hero だけが残った・AI 障害）の「この Session を振り返る」だけ。Player Profile・Drill の結果・Learning Reset はその画面の下にある。→ E2E は Session を終わらせる必要がある。6-max で Call / Check だけだと終わらないので、2 人卓で Hero が All-in できる手番は All-in する（固定 seed で 20 Hand 前後で終わる）。
  - Recommended Drill の候補は Leak（Pass A の「改善の余地あり」「大きな損失」）の最初の判断。E2E の固定応答（`REVIEW_PROVIDER=fake`）の Pass A は常に `reasonable` なので、候補が出ず「Drill を始める」が押せない。→ 固定応答の Pass A の段階評価を起動時の環境変数で選べる口（`FAKE_REVIEW_ASSESSMENT`。既定 `reasonable`）を足す（テスト用の注入点。本番の既定・Claude の経路は変えない）。
  - 既存の `e2e/tests/session.spec.ts` は 6-max の Play・Review・Replay・Resume・User Read / Note / Tag を通している。→ 重ならないよう、新しい E2E は Session の終わりからの学習の流れだけにする。
  - 既存のテストで、Stats の再計算（`stats.test.ts`）・Score の Policy Version の再計算（`score.test.ts`・`learning-reset.test.ts`）・Hypothesis（`hypothesis.test.ts`）・Profile（`profile.test.ts`）・Drill の provenance と Validation（`drills.test.ts`・`drill-plan.test.ts`）・Reset（`learning-reset.test.ts`）はそろっている。Leakage は経路ごと（`learning.test.ts`・`session-review.test.ts`・`drills.test.ts`・`evidence.test.ts`）にあるが、(1) Learning の API のテストは Pass B の Store が空で、Learning-only Reveal の文が混ざらないことを実データで見ていない、(2) Note / Tag・読みの後の HeroView の応答に CPU の Persona の語が無いことを見ていない。→ この 2 つを 1 本の統合テストで足す。
- 根拠: `docs/09` §8、`docs/08` §3.2（Phase 6 → 7 Gate）、D98（E2E の方式）・D105・D114・D115・D116、`release-readme-sync` skill。ガイダンス ui / ai-boundary / docs-harness。

## 設計方針

- **server（テスト用の注入点だけ）**: `apps/server/src/review/fake-review-query.ts` に `createFakeReviewQuery(assessment)` と `parseFakeReviewAssessment`（`FAKE_REVIEW_ASSESSMENT`。未設定・空なら `reasonable`、知らない値は起動時に止める）を足し、`index.ts` は `REVIEW_PROVIDER=fake` のときだけ読む。既定の `fakeReviewQuery` は `reasonable` のまま（既存の E2E とテストは変わらない）。
- **E2E（`e2e/tests/learning.spec.ts`）**: `startServer(dbPath, overrides)` で `TABLE_SIZE=2`・`FAKE_REVIEW_ASSESSMENT=improvement_suggested` を足す（`e2e/support/server.ts` に overrides の引数と、手元の環境の `FAKE_REVIEW_ASSESSMENT` を持ち込まない処理を足した）。
  1. Session が終わるまで Play（All-in できる手番は All-in、それ以外は Call / Check）
  2. 最後の Hand の Review で Pass A（「改善の余地あり」）と Pass B を作る
  3. Session Review: M 件中 1 件・Leak 1 行・Hero の Stats・Drill の候補。Pass B の文が出ない
  4. Player Profile: 全期間の M 件中 1 件・弱点の仮説がある・直近 / 全期間の切り替え。Profile・Session Review の応答に Pass B の文・`persona` が無い
  5. おすすめの Drill を始め、Drill の Hand を最後まで遊び（Call / Check）、練習した判断の Review を作る
  6. Drill の結果は別の欄（練習した判断 M 件中 1 件）。Session Review・Profile の件数は 1 件のまま（D105）
  7. Learning Reset（全カテゴリ・確認の初期フォーカスは「やめる」）: Profile は「Reset 後の判断 0 件中 0 件」、Session Review は変わらない。Replay の一覧・元の判断と練習した判断の Pass A・Drill の一覧は Reset の前と同じ。Drill の系列の Score に区切り（`since`）が付く
  8. server を再起動して、Session Review・Profile・Drill の一覧・Replay の一覧・2 つの Pass A の応答が再起動の前と同じ（Hypothesis の `computedAt` は読むたびの時刻なので除く）。画面の Replay の一覧から Hand を開ける
- **Leakage の統合テスト（`apps/server/src/routes/learning-leakage.test.ts`）**: Hand API で Persona つきの RuleBot と Hand を進め、User Read・Note / Tag を記録し、固定応答（`improvement_suggested`）で Pass A と Pass B を作り、Drill を始めた後に、Session Review・Profile・Drill の一覧・Note / Tag・読みの後の HeroView・Pass A の User Read の Evidence に `forbiddenKeys`・`personaTerms` が 0、Learning の応答に Pass B の文・`readComparison`・`reveal` が無い、Profile と Drill の一覧に札が無く Session Review の札は Hero 自身の札だけ、を確かめる。Drill の一覧の `variant` / `change`（`opponent_tendency` の Preset）は Drill 自身の設定なので外して調べる（`docs/07` §7）。
- **docs**: `docs/09` §8 に Phase 6 の Critical E2E、§10 に Phase 6 → 7 Gate の項目とテストの対応表を足した。README を Phase 6 の到達点に更新した（`docs/08` には進捗の記法を書かない）。`docs/03` / `docs/04` は、Component 境界・Event / 永続化設計・ディレクトリ構造が変わらないので更新しない。

## 変更内容

- `apps/server/src/review/fake-review-query.ts`・`fake-review-query.test.ts`（1 件追加）・`apps/server/src/index.ts`
- `apps/server/src/routes/learning-leakage.test.ts`（新規・1 件）
- `e2e/support/server.ts`・`e2e/tests/learning.spec.ts`（新規・1 件）
- `docs/09_TEST_STRATEGY.md`（§8・§10）・`README.md`・本ログ

## 実行した確認

- 着手時の `pnpm e2e`（main と同じ内容）: 1 回目 1 failed / 3 passed（`session.spec.ts` の Resume の Stack の検査）、直後の再実行で 4 passed → #129 に起票（下の残課題）。
- 単体の実行（`apps/server` で `npx vitest run`）: `src/review/fake-review-query.test.ts` 4 passed・`src/routes/learning-leakage.test.ts` 1 passed。
- `npx playwright test tests/learning.spec.ts`: 繰り返し実行（`--repeat-each=12` で 11 passed / 1 failed、`--repeat-each=15` で 15 passed）。失敗はどれも「Reset の後の Drill の系列の Score が 0 件」の検査で、原因を次のように確かめた。
  - 失敗した回の DB を残して読むと、`learning_resets.created_at`（15:43:19.716）が、操作の順では前にある Drill の Hand の `HAND_FINISHED`（15:43:20.055）と練習した判断の Review（15:43:20.571）より早かった（Playwright の Trace の操作の順は Drill の Hand の終わり → Review → Reset）。
  - この WSL の壁時計を 90 秒測ると、約 27 秒ごとに約 2.1 秒と約 0.6 秒、後ろへ戻っていた（`Date.now()` と `performance.now()` の差。累計 -8.2 秒）。
  - Reset の区切りは壁時計の時刻で比べる（`endedAfter`）ので、Reset の 2〜3 秒前に終わった Drill の Hand が Reset の後に数えられる。→ E2E からこの検査を外し（境界は時刻を注入する `drills.test.ts` が確かめる）、区切りの壁時計依存を #130（#105 の sub-issue）に起票した。Session の Hand は Reset の 8 秒以上前に終わるので、Profile の「Reset 後の判断 0 件中 0 件」の検査は残した。
- 最終の品質チェック（ルート）: `pnpm lint` 0・`pnpm typecheck` 0・`pnpm test` 0（engine 363・web 141・server 551 passed）・`pnpm format:check` 0・`pnpm e2e` 0（5 passed）。

## 残課題

- 既存の Critical E2E（`session.spec.ts` の Resume）が手元で 1 回だけ失敗し、再実行では再現しなかった → #129（[横断]・#104 の sub-issue）に失敗の出力を添えて起票した。上の壁時計の巻き戻り（Replay の一覧の並び）が原因の候補であることを #129 にコメントした。
- Learning Reset の区切りが壁時計の巻き戻りで揺れる → #130（[Phase6]・#105 の sub-issue）。直したら、E2E で外した Drill の系列の Score の検査を戻せるか確かめる。
- 固定応答の Pass A の文（「実戦的に妥当な範囲です」）は段階評価によらず同じ。E2E 用で画面の文言は検査しないので、そのままにした。
