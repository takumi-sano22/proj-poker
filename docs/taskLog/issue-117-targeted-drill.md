# Issue #117 [Phase6] P6-6 過去 Hand から決定論で Targeted Drill を作る

## 目的

過去の Hand の Hero の判断（Pass A の Review があるもの）から、一要素だけ変えた類題（Targeted Drill）を決定論で作り、Poker Engine の Validation を通して出題する。Drill の判断の Review は既存の Pass A の経路を使い、結果は通常の Score と別の系列に置く（D105・D110・D116）。

## 前提（人間判断）

- D105: Drill は過去 Hand からの決定論の変形（一要素だけ）。provenance を持つ。結果は通常の Score へ混ぜない
- D110: Phase 6 は決定論の変形だけ。LLM で Spot を作る経路は作らない
- D116: Drill は専用の Session の通常の Hand として Engine で終局まで進め、Event の形は変えない。追記型の `drills` テーブル（マイグレーション v7）で区別し、通常の集計（Stats・Score・Profile・Hypothesis・Resume・Replay）から除く。Review は既存の Pass A の経路

## 設計

- **Spot はHero に見えた情報だけから作る**: Engine の `buildDrillSpot` が判断時点の `HeroInformationSet` だけを受け取る（他者の札・判断より後の Board・Learning-only Reveal は入力の経路に無い）。Hero の札・判断時点の Board は元の Deck 位置へ、残りは seed でシャッフルして埋める
- **Script**: 判断の直前までの全員の公開の `ACTION_TAKEN` を Canonical Action に戻して再現する（bet / raise は to 額）
- **変形**: `effective_stack`（開始時の全員の Stack を倍率で）/ `bet_size`（Hero が直面した最初の Bet の額を Pot 比で）/ `opponent_tendency`（Spot は変えず、判断の後の相手を Preset の Persona の RuleBot にする。Preset は Drill の設定として Hero に見せる。元の CPU の Persona は読まない）
- **Validation**: `startDrillHand` が startHand → SESSION_STARTED → Script を Engine で適用し、全 Action の受理・Chip の保存・同じ Street で Hero の手番・判断数の一致を確かめる。通らなければ出さない
- **選び方**: seed で種類の順 → 値の順（値の多い種類へ偏らせない）。最初に通る候補
- **実行**: `HandOrchestrator.startDrill` が専用の Session の Hand を始める。今の Session（`this.session`）は変えない。CPU は RuleBot だけ（LLM を呼ばない）
- **記録**: `drills` の行は Drill の Hand を始める前に足す（Hand の保存より先に除く対象へ入れる）。`drill_hand_id` は `hands` を参照しない
- **除外**: `listHands(limit, exclude)`・`latestSessionProjection(exclude)` を足し（SQLite は `json_each`）、Replay の一覧・Resume から除く。Learning は既存の `excludeHandIds` に `drills` の Hand を渡す
- **Drill の系列**: `AbilityEvidenceOptions.firstDecisionIndex` を足し、Drill の Hand の Script が再現した判断を数えずに `computeScoreReport` を呼ぶ
- **UI**: `useHandSession` に開始の要求の差し替え口を足し、2 つ目のインスタンスで Drill の Hand を遊ぶ。卓の部品は `TableScreen` に切り出して共有。Session Review に Drill の入口と結果の欄

## 変更ファイル

- Engine: `packages/engine/src/drill.ts`（新規）・`drill.test.ts`（新規）・`index.ts`
- Server: `apps/server/src/drill/`（`drill-plan.ts`・`drill-store.ts`・`drill-service.ts` とテスト。新規）・`routes/drills.ts`・`routes/drills.test.ts`（新規）・`db/database.ts`（v7）・`db/database.test.ts`・`event-store.ts`・`sqlite-event-store.ts`・`hand-orchestrator.ts`・`app.ts`・`index.ts`・`replay.ts`・`learning/ability-evidence.ts`・`learning/learning-service.ts`・`learning/session-review.ts`・`learning/learning-isolation.test.ts`・`learning/session-review.test.ts`・`routes/learning.test.ts`
- Web: `apps/web/src/App.tsx`・`hooks/useHandSession.ts`・`components/SessionReviewScreen.tsx`・`components/DrillBanner.tsx`（新規）・`lib/drill-api.ts`（新規）・`lib/drill.ts`（新規）・`lib/api.ts`・`lib/learning-api.ts`・`styles.css`・`components/session-review.test.tsx`
- Docs: `docs/03`・`docs/04` §10 / §12・`docs/06` §14・`docs/07` §2 / §3 / §4 / §6 / §7・`docs/11` OI-006

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 363・web 138・server 534 件 pass）/ `pnpm format:check`（ルート）
- 除外の配線を外すと `routes/drills.test.ts` の 2 件（Replay・Learning・Resume の除外、Drill の系列）が落ちることを一時的な変更で確かめた（変更は戻した）
- UI の実測（Playwright・使い捨ての DB・`REVIEW_PROVIDER=fake`・`TABLE_SIZE=2`）: Session Review の「Drill を始める」→ Drill の卓 → Fold → 「練習した判断の Review」→ Review の画面、「卓に戻る」で通常の卓に戻ることを 1280×900・375×760 で確認。説明の面と上の席の札の重なり・横スクロールを 1280×900・375×760・320×568 で測り、重なり 0・横スクロール 0（説明の面の下の余白を広い画面 32px・狭い画面 20px にして解消）。ページエラーなし
- 実測用の server / web は止めた

## 残課題

- Pass A の Review は Event Log の判断時点の情報だけから作るので、Drill の設定（相手の傾向の Preset）は Review の入力に入らない（D116 の「既存の Pass A の経路をそのまま使う」に従った）
- 途中で止まった Drill の Hand（再起動で消える）は保存されず、`drills` の行だけが残る（一覧では `finished: false`）

## Codex レビューへの対応

- [P1] Drill の開始の再送で別の Drill ができる（CONFIRMED）: 同じ元の判断の Drill の Hand がこのプロセスで進行中なら、新しく作らずその Drill を 200 で返すようにした（`DrillService.ongoingDrill`）。`routes/drills.test.ts` に再送のテストを足した
