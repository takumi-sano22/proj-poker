# Issue #169: Web の Review の根拠の欄に卓の傾向（Table Tendency）を出す

## 概要

#153（PR #166）で Hero の Review（Pass A）の Evidence に入れた Table Tendency（D122）を、Web の Review の根拠の欄に出した。Review の文が卓の傾向を根拠にしたとき、Hero が根拠を確かめられる。表示するのは保存済みの Review Record の Evidence にある値だけで、画面で計算せず、Review AI の説明文から値を拾わない。完了条件:

- Review の根拠の欄に、卓の傾向の項目（数と分母・Hand 数・十分か）を出す。
- 375px・320px・1280×720 で崩れない（`ui-design-recipes`）。
- Persona・Memory・Tilt が画面に出ないことの検査。

## 初期調査

- `GET /api/reviews/hands/:handId/decisions/:index`（と `/versions/:version`）は保存済みの Review Record（`evidence` を含む）をそのまま返す（`ReviewService.snapshot` / `version`）。Evidence の `opponentObservation`（`unavailable` / `available` + `tableTendency`）はもう応答に入っている。**API は変更不要**（Evidence を作り直さず、LLM も呼ばない）。変えたのは Web の型と画面だけ。
- Web の `ReviewEvidence`（`lib/review-api.ts`）は `opponentObservation` を持っていなかったので型を足した。#153 より前に保存された記録は `opponentObservation` が `unavailable`（古いものはフィールド自体が無い可能性もある）なので、型は任意（`?`）にし、無ければ欄を出さない。
- 項目の名前は `STAT_TERMS`（Stats と同じ表記）を再利用し、Showdown だけ新しく置いた。`vpip`・`pfr`・`aggression_frequency` は Hero 以外の席の合計、`showdown` は Hand 単位（`memory/table-tendency-policy.ts`）。

## 設計方針

- 置き場所: 根拠の欄（`EvidenceSection`）の「相手の Range の仮定」と「Solver」の間に「卓の傾向（Table Tendency）」を畳んだ欄として置く。既定は閉じ、要点を先に読ませる（D04）。
- 値: `rate`（小数第 3 位の決定論の割合）を `Math.round(rate × 100)%` で出し、`numerator / denominator` を必ず併記する。機会が 0（`rate` が null）なら割合を出さず「—（0 / 0）」。`hands`（機会があった Hand）・`sufficient`（十分か）はそのまま。十分か保留かは色と文字の両方で示す。
- 数えた Hand の数（`tableTendency.hands`）を欄の先頭に「この判断より前の N Hand の…」と出し、「個々の相手の傾向ではない」「保留の項目は根拠にしない」と断る。
- 無いとき: `unavailable`（十分な項目が 1 つも無い Review）は「卓の傾向はありません」と 1 文だけ出す。`opponentObservation` 自体が無い記録は欄を出さない。どちらもエラーにしない。
- 出さないもの: CPU の Private Memory / Hypothesis・Persona・Tilt・Learning-only Reveal は Evidence に無く、画面は Evidence の決まった項目だけを読む（ほかのキーは描かない）。Pass B の画面・型には触れない。
- 「説明の根拠」の印: `evidenceIds.cited` に `tendency:` の id があれば、区分と項目に付ける（Review AI が根拠に挙げた項目が分かる）。
- レイアウト: 項目 1 つを 1 つの面（`.tendency__item`）にする。560px 以上は列をそろえた 4 列の grid（名前・割合・機会があった Hand・十分か）、それ未満は flex の折り返しで縦に積む。トークンは既存（`--color-assess-good` / `-caution`・`--radius-control`・`--color-border`）だけ。
- 新しい人間判断は不要（D122 の範囲の表示。`decision_log.yaml` は変えていない）。

## 変更内容

- `apps/web/src/lib/review-api.ts`: `TableTendencyItemId` / `TableTendencyItem` / `OpponentObservation` と、`ReviewEvidence.opponentObservation?`。
- `apps/web/src/lib/review.ts`: `TABLE_TENDENCY_TERMS` / `tendencyItemLabel`（知らない項目は ID のまま）/ `tendencyValueText`。
- `apps/web/src/components/ReviewEvidence.tsx`: `TableTendencyView`。`ReviewPass.tsx`: 根拠の欄に組み込み。`styles.css`: `.tendency*`。
- テスト: `apps/web/src/components/review.test.tsx`（表示・保留・無いとき・古い記録・紛れ込んだ Persona / Memory / Tilt / Reveal が出ない・知らない項目）、`apps/server/src/review/review-table-tendency.test.ts`（API の応答 = 保存済みの Evidence のまま。Memory / Hypothesis / Tilt / Persona を指す語と見えない札が無い）、`e2e/tests/review-tendency.spec.ts`（新規）。
- docs: `docs/05` §6（画面での扱い）・`docs/06` §10（Review の画面）・`docs/09`（テストの対応表と E2E の説明）・`README.md`（Phase 7 の記述と制約の 1 行）・`.claude/skills/ui-design-recipes/references/proj-poker.md`（既存部品の対応表）。`docs/03`・`docs/04` は実装の構造が変わっていない（Component の境界・Event・永続化・API は同じ）ので変えていない。

## E2E（`review-tendency.spec.ts`）

- 6 人卓の 1 つの Session で、Hero は毎 Hand Fold する（Call / Check だけだと数 Hand で Bust しうる）。Hero が判断した最初の Hand の Review は前の Hand が無いので「卓の傾向はありません」（API の Evidence は `unavailable`）。11 Hand を超えて Hero が判断した Hand の Review は、4 項目の値が `/api/reviews/hands/<handId>/decisions/0` の Evidence と一致する（Hand は開始の応答の handId で特定。画面の値と API の値の比較で、説明文から拾っていないことを確かめる）。
- 画面と API の応答に persona / memory / tilt / hypothesis が無く、Pass B（全員の札）には切り替えていない。
- 1280×720・375×667・320×568 で、横スクロールが無く、項目が画面に収まり、項目同士・項目の中の要素同士が重ならない。
- 実装を 1 か所壊すと落ちることを確かめた（割合の表示を +1 すると失敗）。

## 実行した確認

- ルートで `pnpm lint` / `pnpm typecheck` / `pnpm test`（server 776・web 147・engine）/ `pnpm format:check` を通した。
- 画面の確認（Playwright のスクリーンショット。リポジトリには入れていない）: 1280×720・375×667・320×568 の根拠の欄を見た。320px でも項目が折り返して縦に積まれ、保留の項目は色と文字（「サンプルが足りない（保留）」）で分かる。
- `pnpm e2e --repeat-each=10`（全 11 本 × 10 = 110 件。新しい 1 本を含む）:
  - 1 回目: 110 passed（12.2m）
  - 2 回目: 110 passed（12.0m）
- 第 2 段レビュー: Codex は STATUS=clean（本文を直読。P0〜P2 の指摘なし）。学習候補なし。
- 手順上の事故: 変異テストの後始末に `git checkout <file>` を使い、未コミットだった `lib/review.ts` の追加を一度消した（すぐ再適用。テストと確認は再適用後の状態で通した）。未コミットの変更があるファイルは、変異を入れる前にコミットかコピーを取る。

## 残課題

- 卓の傾向を実モデルの Review で使ったときの説明の品質（数値を作らない・保留を根拠にしない）は #153 の残課題のまま（実モデルの呼び出しが要る）。
- 画面は項目の id（`tendency:...`）そのものは出さない（「説明の根拠」の印で対応を示す）。Review の文の中の数値を Evidence と照合する検証は、画面にも Grounding にも無い（#153 の残課題のまま）。
