# Issue #116 P6-5 Session Review / Learning の画面

## 概要

Session の終わりに見る Session Review / Learning の画面を作る。Hands・Duration・実額の収支（BB は補助）、Decision Quality Summary（M 件中 N 件を Review 済み・Overall と Confidence / Sample）、Ability、Strength / Leak、Important Hands、Hero の Stats、Recommended Drill の入口、Recent / Long-term の Player Profile（Weakness Hypothesis を含む）を出す。D16・D32・D34・D49・D111・D115・D116。

## 初期調査

- #113 の `computeScoreReport`・#114 の `computePlayerProfile` / Snapshot の関数・#112 の `projectPlayerStats` は、Hand の Event Log の配列と Pass A の `reviews` を受け取る純粋な計算で、表示用の API はまだ無かった。
- Event Store には Session ごとに Hand を引く口が無かった（`hands.session_id` はあるが、Interface は `listHands(limit)` と `latestSessionProjection()` だけ）。Event の中に sessionId を持つのは Session の最初の Hand の `SESSION_STARTED` だけ。
- Session が終わったときの web の表示は、卓の中央（広い画面）か Hero の欄（狭い画面）の `HandResult` / `SessionEnded` で、「新しい Session を始める」だけを持つ。画面の切り替えは `App.tsx` の `Screen` 型。
- `hypothesis_snapshots` を作り直す呼び出し元はまだ無かった。

## 設計方針（判断）

1. **Session の Hand の引き方**: Event Store の Interface に `sessionHandIds(handId)`（同じ Session の終わった Hand・開始の古い順）と `finishedHandIds()`（全期間）を足した。SQLite は既存の `hands` テーブルを読むだけで、マイグレーション・Event の形は変えていない（D111・D76）。
2. **API**: `GET /api/learning/session-review/:handId`（その Hand の Session）と `GET /api/learning/profile`。どちらも都度計算で、Review を作らない（D115）。Pass B の Store は Learning に渡さない。
3. **Hypothesis**: Profile を読むたびに、Profile と同じ Evidence から作った Hypothesis で Snapshot を入れ替え（`writeHypothesisSnapshot`）、読み直した行（`readHypothesisSnapshot`。作り直した時刻つき）を返す。Snapshot は作り直せる派生データ（D113）で、正本（Event Log・`reviews`）は書き換えない。差し替え口 `HypothesisSnapshotStore`（SQLite / メモリ内）を `buildApp` に足した。
4. **Strength / Leak・Important Hands（OI-006 の暫定値。`phase6_session_review_v1`）**: Strength は `strong`、Leak は `major_leak` / `improvement_suggested`。Important Hands は Important Spot（判断時点の情報だけで選ぶ）か Strength / Leak がある Hand を、Leak の数 → Important Spot の数 → Hand の順で 5 Hand まで。収支（結果）では選ばない（Hindsight を混ぜない・「負けたから下手」にしない）。
5. **収支**: Hero の実額（`HAND_FINISHED` − `HAND_STARTED` の Stack の和）。BB は最後の Hand の BB で割った補助（D49）。画面では判断の質の下の「事実の欄」に小さく置き、「収支は短期の結果で運を含む」と添えた。
6. **Stats**: `projectPlayerStats` の Hero の行だけを返す（D32）。分子 / 分母を必ず出す。
7. **Recommended Drill**: 候補（Leak の最初の判断）と押せない Button だけ（Drill は #117）。
8. **Drill の除外（D116）**: `excludeHandIds` は `NO_EXCLUDED_HANDS`（空集合）で通しておく。#117 で `drills` から作る。
9. **入口**: Session 終了の案内（卓の中央の結果 / Session 終了の欄と、狭い画面の Hero の欄）に「この Session を振り返る」を足した。Session Review の Strength / Leak・Important Hands の行から Hand Review を開く。

## 変更ファイル

- server: `event-store.ts`・`sqlite-event-store.ts`（`sessionHandIds` / `finishedHandIds`）、`learning/session-review.ts`（新規）、`learning/learning-service.ts`（新規）、`learning/hypothesis-snapshot.ts`（`HypothesisSnapshotStore`）、`routes/learning.ts`（新規）、`app.ts`・`index.ts`（配線）
- server テスト: `learning/session-review.test.ts`・`routes/learning.test.ts`（新規）、`event-store.test.ts`・`learning/hypothesis-snapshot.test.ts`（追加）
- web: `components/SessionReviewScreen.tsx`・`lib/learning-api.ts`・`lib/learning.ts`（新規）、`App.tsx`（`session_review` の画面と入口）、`styles.css`（`.learning-*`）、`components/session-review.test.tsx`（新規）
- docs: `docs/03` §1（Event Store・`learning/`・API の表・Session Review の画面）・`docs/06` §14（新規）・`docs/07` §4〜§6・`docs/11` OI-006（暫定値の記録）

## 実行したコマンドと結果

- `pnpm lint` / `pnpm typecheck` / `pnpm format:check`: 通過
- `pnpm test`: engine 355・web 136・server 518 件すべて通過
- UI の実測（Playwright。一時的な spec で 6-max・固定 seed・RuleBot・固定応答の Review。Hero が毎手番 All-in して 45 Hand で Bust → 1 判断の Review を作った状態）:
  - Session 終了の案内: 1280×900・375×667 で横スクロール 0。375 の Hero の欄で「この Session を振り返る」の中心の `elementFromPoint` が Button 自身（覆われていない）
  - Session Review: 1280×900・375×667・320×568 で横スクロール 0。Long-term への切り替え後も 0。Important Hands の行から Hand Review を開けた
  - 一時的な spec はコミットしていない（Critical E2E は #119 でまとめる）

## 残課題

- Drill の生成・開始と `drills` による除外は #117、Learning Reset の区切り（D114）は #118。
- Strength / Leak・Important Hands の選び方は OI-006 の暫定値。Playtest 後に Version を上げて見直す。
- Session Review は Session 終了時の案内からだけ開ける（Session の途中の振り返りの入口は無い）。
