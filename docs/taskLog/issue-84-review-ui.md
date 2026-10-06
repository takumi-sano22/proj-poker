# Issue #84: Review の UI を作り Replay から Important Spot へ飛べるようにする

## 概要

Phase 5 の子 Issue。#82（Pass A）・#83（Pass B・Follow-up）の API を Hero が画面で使えるようにした。Hand が終わった後に Hand Review を開き、Important Spot を先に並べた一覧（要点先行・D04）から判断を選ぶ。判断ごとに、判断時点の Review（段階評価 6 段階・確度・要点・結論が変わる条件・前提・根拠〔判断時点の卓・Math・Range・Solver・KB〕）と、Hand 後の答え合わせ（Pass B）を、タブと面の色で分けて見せる。どちらも Version を選べ、「詳しく作る」で review_deep を選べ、Pass・Version ごとに Follow-up の欄がある。Replay には Jump to Important Spot（D93）を足した。Event の形・永続化スキーマ（テーブル・マイグレーション）は変えていない。

## 初期調査

- 前提（main d84ff29）
  - Review の状態の API（`GET /decisions/:i`・`/reveal`）は最新の Version しか返さない。→ 画面で過去の Version を選ぶには、Version を指定して読む GET が要る。
  - Replay の応答の `importantSpots` は Important Spot だけ。Important Spot の規則（big_pot・all_in・river_big_bet・ruling）では、無い Hand も多い（実測で 5 Hand 中 3 Hand が 0 件）。→ Important Spot だけだと Review を開けない Hand が多くなるので、Hero の判断のすべてを step の位置で返す `decisions` を足した。
  - web は Tailwind ではなく `styles.css` のトークンと素の CSS。Review 用の部品は無く、Replay と卓の部品（`PlayingCard`・`Amount`・`.btn`・`.badge`・`.notice`）を使い回せる。
- 根拠: docs/05 §6〜§10、docs/06 §10・§11、D04・D05・D39・D49・D93・D97。ガイダンス ui / ai-boundary、台帳 LC-040・LC-041。

## 設計方針

- **server（読み取りの API を足すだけ）**
  - `replay.ts`: `decisions`（`heroDecisions` のすべての判断を、Important Spot と同じ写し方で判断時点の step へ写したもの。Hero 自身の Action だけ）を足した。写し方は `decisionStepIndex` に共通化した。
  - `review-service.ts`・`routes/reviews.ts`: `GET .../versions/:version`（Pass A）と `GET .../reveal/versions/:version`（Pass B）。無い Version は 404 `review_not_found`。
- **web**
  - 画面の状態（`App.tsx`）は `table` / `replay`（開く Hand と step）/ `review`（Hand と最初に開く判断）。Hand の終了後の Hero の欄と Replay から Review、Review から Replay の判断時点の step へ移れる。
  - `hooks/usePolled.ts`: GET の URL ごとに状態を読み、生成の待ちの間だけ読み直す。要求ごとに番号を振り最後の要求の応答だけを採る（LC-041）。URL が変わったら前の値は見せない。POST の応答も同じ状態に入れ、POST が失敗したら読み直して今の状態へ戻す。
  - `hooks/usePassReview.ts`: Pass ごとの状態・選んだ Version・生成の要求。最新以外の Version を選んだときだけその Version を読む。
  - Pass A の画面に Hand 後の情報を出さない: Pass A のパネルは Pass A の Record（判断時点の Evidence）だけを描き、Pass B はタブを開いたときだけ読む。一覧にも Hand の結果を出さない。
  - Solver は `status: supported` のときだけ結果を出し、Heads-Up の解・前提つき・唯一の正解ではないと添える。それ以外は理由（Multiway・Street・未導入等）と Fallback（Math・Range・KB）。サーバーの `detail` はパスや内部の本文を含みうるので出さず、理由の種類から文言を作る。
  - 待ちの案内は「Review を作っています…」だけ。40 秒を超えたら「時間がかかっています」を足す（docs/06 §11。モデル名・API は出さない）。失敗は種類ごとの案内（ログインし直す・枠が戻るまで待つ・もう一度作る）。
  - Follow-up は、送った質問を答えが届くまで入力欄に残す（答えの生成に失敗しても書き直さずに送り直せる）。
  - Action の書き方は進行ログ（`describeAction`）と同じにした（Call は出した額、Raise は「まで」）。そのため `describeAction` の引数を Action の 4 項目に広げた（呼び出し側は変わらない）。

## 変更内容

- `apps/server/src/replay.ts`（`ReplayDecision`・`replayDecisions`・`decisionStepIndex`）、`routes/replay.test.ts`（`decisions` の検査）
- `apps/server/src/review/review-service.ts`（`version`・`revealVersion`）、`routes/reviews.ts`（Version 指定の GET 2 本）、`routes/reviews.test.ts`
- `apps/web/src/lib/api.ts`（`getJson` / `postJson` を公開、Review の失敗の種類、`ReplayHand` の `importantSpots` / `decisions`）
- `apps/web/src/lib/review-api.ts`（新規。Review の応答の型と URL・POST）、`lib/review.ts`（新規。表示の文言）、`lib/config.ts`（`REVIEW_POLL_MS`・`REVIEW_DELAY_NOTICE_MS`。暫定値）、`lib/view-model.ts`（`describeAction` の引数）
- `apps/web/src/hooks/usePolled.ts`・`usePassReview.ts`（新規）、`hooks/useReplay.ts`（開く step の指定・`jump`）
- `apps/web/src/components/ReviewScreen.tsx`・`ReviewPass.tsx`・`ReviewEvidence.tsx`・`FollowUp.tsx`（新規）、`ReplayScreen.tsx`（Jump to Important Spot・Review への入口）、`App.tsx`、`styles.css`
- `apps/web/src/components/review.test.tsx`（新規）
- docs: `docs/03` §1（Replay の応答・Web UI・Version 指定の API）、`docs/06` §10

## 判断理由

- `decisions` を足したのは、Important Spot の無い Hand でも Review を開けるようにするため。Important Spot は一覧の先頭に置くので要点先行（D04）は崩れない。Hero 自身の Action だけで、情報境界は変わらない。
- 生成は自動で始めず、Hero が「作る」を押したときだけにした。Review は Claude の利用枠を使うので、一覧を開くだけで判断の数だけ呼ばないため。
- Pass A / Pass B をタブで分けたのは、同じ縦の流れに並べると Pass A を読んでいる途中で相手の札が目に入るため（不変条件 3）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 328・web 117・server 400 passed）/ `pnpm format:check` をルートで実行し、すべて通った。
- 実機（Playwright 1.62・headless Chromium。リポジトリ外のスクリプト）: worktree の `buildApp` をメモリの Store・RuleBot・Fake の Review AI（Claude を呼ばない。3 秒待って検証を通る出力を返す）で 3001 に起動し、web の dev サーバー（5173）を使った。API で 5 Hand を Call / Check で進めた（Important Spot は 0・0・0・4・1 件）。1280×900 と 375×760（モバイル・タッチ）で:
  - Replay: Important Spot 4 件の Hand で Jump のボタン 4 つ。「1. Turn」で 1 / 42 → 22 / 42（判断の直前。押したボタンが `aria-pressed="true"`）、「3. River」で 30 / 42。
  - 「この判断の Review を見る」→ 判断の画面（「ターン（Turn）・コール（Call） 5」「大きい Pot」）。「Review を作る」→「Review を作っています…」→ 約 3 秒後に「妥当（Reasonable）／確度（Confidence）: 中くらい」。Pass A の欄に「全員の札」は無い。3 人の Pot なので Solver の欄は「3 人以上で Pot を争う場面（Multiway）は、Solver の対象外です。」と Fallback の文。
  - Follow-up: 1 ターン目を送った直後、入力欄は質問を残したまま無効、答えが届くと空になった。2 ターン目は範囲外の答えで「この Review（判断時点の情報）の範囲外の質問です。…」。
  - 「作り直す」で Version の選択肢が「Version 2（最新）」「Version 1」。Version 2 の Follow-up は 0 件、Version 1 を選ぶと 2 件に戻る。「詳しく作る」で「詳しい Review を作っています…（標準より時間がかかります）」→ 選択肢 3 つ・「詳しく」の印。
  - 「Hand 後の答え合わせ」→「答え合わせを作る」→ 相手 5 人の札（10 枚）・最後の Board・Equity・説明。段階評価の印は 0。面の色は Pass B が背景 rgb(34, 23, 30)・上の線 rgb(240, 163, 196)、Pass A が rgb(22, 29, 35)・rgb(224, 170, 62)。
  - 一覧: Important Spot 4 行・ほかの判断 3 行。状態は「妥当」と「Review 未作成」。
  - 「Replay でこの場面を見る」→ 22 / 42（Jump のボタンが押された状態）。
  - Solver が Supported の表示は、応答を差し替えて確認した（「Heads-Up（2 人）の場面を Solver で解いた結果です。…唯一の正解ではありません。」と頻度のバー・Hero の札の頻度）。
  - 生成の失敗（応答を差し替えて `usage_limit`）は「AI の利用枠の上限に達したため、Review を作れませんでした。枠が戻ってから、もう一度作ってください。」と「Review を作る」「詳しく作る」。
  - 卓で Hand を終えると「この Hand の Review」が出て、押すと Hand Review が開いた。最初の版は卓の中央の結果の欄に置いたが、375px では結果の欄が Hero の席と重なってボタンを押せなかった（Playwright のクリックが席の要素に遮られた）。→ 画面下に固定した Hero の欄（「Hand が終了しました。」の横）へ移し、1280px と 375px で押せることを確かめた。なお、375px で結果の欄（獲得額の一覧と「次の Hand へ」）が席と重なるのは、この変更の前からある見た目で、ここでは直していない。
  - 各画面で横スクロール 0（`scrollWidth − innerWidth = 0`）。ページのエラー・コンソールのエラーは無し。
  - 375px の最初の版では、Jump のボタンと Review のボタンが折り返して Hero 欄（画面下に固定）が高くなり、卓をほぼ隠した。→ 狭い画面では 1 行に並べ、溢れた分はその行の中だけで横に送るようにして直した。
  - dev サーバーは確認後に停止した（3001 / 5173 の LISTEN が無いことを `ss -ltnp` で確認）。

## レビュー対応

- Codex（1 回目・`STATUS=clean`・P2 1 件）: 生成の待ちの間に状態の GET が 1 回でも失敗すると `usePolled` の読み直しが止まり、待ちの表示のまま操作できなくなる（再読み込みのボタンも出ない）。CONFIRMED。→ 待ちの間は失敗しても読み直しを続けるようにした（失敗のたびに状態の値が新しくなるので次の読み直しが仕掛け直される）。同根の箇所（Pass A / Pass B / Follow-up / 一覧の行）はすべて `usePolled` を通るので、この 1 か所で直る。Playwright で、生成の待ちの間の GET を 2 回続けて落としても、その後に段階評価が出ることを確かめた。

## 残課題

- 当時の User Read（Review Interview・docs/05 §12）と、Good Decisions / Improvement Opportunities のまとめ（docs/06 §10 の初期表示）はまだ無い。
- 実際の Claude（review_standard / review_deep）での画面の通しはしていない（Fake で確認）。review_deep の Latency は未測定（#82 の残課題のまま）。
- `REVIEW_POLL_MS`（1500ms）・`REVIEW_DELAY_NOTICE_MS`（40 秒）は暫定値。
- 375px で卓の中央の結果の欄が席と重なる（この変更の前から）。卓 UI の体系（#5）で扱う。
