# Issue #208: Review の数値 Grounding が N の無い波括弧の数値（{481}）を通し、保存する文に残る

## 概要

#202（D132）の Tournament の Review Eval の録画で、Review AI が assumptions に `標準 {481} Combo` と書き、数値 Grounding（#168・D131）は `{N3}` の参照・`{}` の無い `N3`・単位付きの数値だけを見るので検査を通り、保存する文に波括弧が残った。検査は変えず、保存の前の置換（`resolveNumericRefs`）で波括弧だけを外すようにした。

## 初期調査・判断

- 方針は親が確定済み（D131 の範囲内の実装修正で、新しい人間判断は不要）。検査（`checkNumericGrounding`）を変えると録画の出力が不正扱いになり、再録画（実モデル呼び出し）が要る。
- `resolveNumericRefs` は Pass A（`generate.ts`）と Follow-up（`followup.ts`）の保存の経路が共通で通る（grep で確認）。ここに足せば両方に効く。
- 単位の無い数は D131 で照合の対象外なので、`{481}` を `481` にしても扱いは変わらない。値そのものは変えない。

## 変更内容

- `apps/server/src/review/numeric-grounding.ts`: `BARE_BRACE_NUMBER_PATTERN`（`{` 数字〔桁区切り・小数〕`}`。全角の括弧・数字も読む）と `stripBareBraceNumbers`。`resolveNumericRefs` の文の置換で、参照の置き換えの後に波括弧だけを外す。`checkNumericGrounding`・`resolveNumericText`・Prompt は変えない。
- `apps/server/src/review/numeric-grounding.test.ts`: 回帰テスト。`{481}`・`{1,200}`・`{0.5}`、`{N3}` は従来どおり、波括弧の中が数字以外（`{abc}` `{N999}` `{12a}` `{}` `{1.}` `{1,20}`）は触らない、全角、検査が変わらないこと、Pass A と Follow-up の保存まで通した 2 件。
- `docs/05_AI_OPPONENTS_AND_REVIEW.md` §8 と `docs/09_TEST_STRATEGY.md` §6 に 1 文ずつ反映。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（server 69 files・902 tests、web 含め全通過）/ `pnpm format:check`。
- 録画の再生（Cash `review-eval.json`・Tournament `review-tournament-eval.json`）は録画ファイルを触らず、再生のテストが変わらず通ること。実モデル呼び出しは無し。

## 残課題

- なし。
