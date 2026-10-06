# Issue #95: Engine の hand-summary Property Test の一度きりの失敗を調べ、反例を記録できるようにする

## 概要

#85 の作業中に `packages/engine/src/hand-summary.property.test.ts` が 1 回だけ失敗し、出力を残せず、その後 46 回（約 6,900 ケース）流しても再現しなかった。原因を特定し、Property Test が落ちたときに seed を拾って再現できるようにした。

## 結論

- **原因はテストの前提の誤り（Engine の不具合ではない）**: vitest の 1 テストの時間切れが既定の 5 秒のままで、この Property Test は単独で 1.7〜2.2 秒かかる（150 ケース）。CPU に負荷がかかる環境（#85 では Playwright・dev server・実 Solver の smoke を同時に動かしていた）では 5 秒を超え、`Test timed out in 5000ms` で落ちる。時間切れの失敗には fast-check の seed も反例も出ないので、「反例の分からない一度きりの失敗」に見えた。
- 再現: 16 個の CPU busy loop（8 コアの WSL）をかけて同テストを 6 回流すと、5 回が `Error: Test timed out in 5000ms.`（所要 5.9〜7.1 秒。1 回は 4.71 秒で通過）。修正後に同じ負荷で 6 回流すと 6 回とも通過（所要 4.8〜6.5 秒）。
- 反例（Engine の不具合）は見つからなかった。seed を変えて合計 約 15 万ケースを流して失敗 0（下の「Soak」）。

## 初期調査

- fast-check 4.10.2 の `fc.assert` は、Property が偽になったときのエラーに `{ seed, path }` と縮小済みの `Counterexample` を既に出す（意図的に落とした Property で確認）。つまり「反例が出ない」のは Property の反例ではなく、時間切れなど Property の外の失敗だった。
- Property の外で落ちうる箇所: ① テストの時間切れ（上記）、② `fc.assert` の後の網羅の確認（`seen` の `toEqual`。seed がメッセージに無い）。② は 400 回（150 ケースずつ）の測定で一度も外れなかった（6 種のどれも毎回通った）。
- 他の Property Test: 単独の所要は hand-engine 0.8〜1.1 秒・ruling 0.5 秒・他は 0.3 秒以下。`hand-evaluator.test.ts` の全列挙（3.5 秒）は個別に `timeout: 120_000` を持っていた。

## 変更内容

- `packages/engine/vitest.config.mjs`（新規）: 1 テストの時間切れを 30 秒にした（`POKER_PROPERTY_RUNS_FACTOR` 倍で延びる）。
- `packages/engine/src/testing/property.ts`（新規）: `propertyParams(numRuns)` が `{ numRuns, seed }` を返す。seed は `POKER_PROPERTY_SEED` で注入でき、無ければ実行ごとの乱数。`POKER_PROPERTY_RUNS_FACTOR` でケース数を倍にできる（Soak 用）。Engine は I/O を持たず `types: []` なので `globalThis` から env を読む。
- same-root sweep: `fc.assert` を使う全 11 ファイル 26 か所を `propertyParams(...)` 経由にした（`hand-summary` / `hand-engine` / `ruling` / `hand-evaluator` / `hand-strength` / `equity` / `position` / `pot-split` の各 property テストと `chips` / `rng` / `side-pots` のテスト）。ケース数は変えていない。
- `hand-summary.property.test.ts`: 網羅の確認のメッセージに seed を入れた（`網羅の確認（seed=…）`）。
- `docs/09_TEST_STRATEGY.md` §9: seed の見方・`POKER_PROPERTY_SEED` / `POKER_PROPERTY_RUNS_FACTOR`・時間切れ 30 秒の理由を追記した。

## 失敗時の出力（意図的に落とした Property で確認。確認用ファイルは削除済み）

```
Error: Property failed after 2 tests
{ seed: 1541408657, path: "1:2:2:0:2:2:2:5", endOnFailure: true }
Counterexample: [700,[0,0,0]]
Shrunk 7 time(s)
```

`POKER_PROPERTY_SEED=12345` を 2 回流すと、どちらも同じ `{ seed: 12345, path: "8:2:4:0:1:3:5" }` と `Counterexample: [700,[0,0,0]]` になり、seed で再現できる。

## Soak（再現しない場合の記録）

- 修正前の測定: `hand-summary` の Property を 150 ケースずつ 400 回（合計 60,000 ケース・seed はランダム）。失敗 0・網羅の外れ 0。
- 修正後: `POKER_PROPERTY_SEED={101,202,303,404,505,606} POKER_PROPERTY_RUNS_FACTOR=100 vitest run src/hand-summary.property.test.ts`（1 seed 15,000 ケース × 6 = 90,000 ケース）。6 つとも passed（所要 約 208〜213 秒）。
- 他の Property Test: `POKER_PROPERTY_SEED={505,606} POKER_PROPERTY_RUNS_FACTOR=20 vitest run property`。`hand-summary` 以外の 7 ファイル・21 テストが passed（`hand-summary` は時間切れの倍率を入れる前の実行で 30 秒で落ちたため、上の Soak で別に確認した）。

## 実行した確認

- ルートで `pnpm lint`（エラー 0）・`pnpm typecheck`（3 パッケージとも Done）・`pnpm test`（engine 333・web 117・server 412 件 passed）・`pnpm format:check`（All matched files use Prettier code style）を通した。

## 残課題

- `poker-engine-testing` skill §5 に `POKER_PROPERTY_SEED` / `POKER_PROPERTY_RUNS_FACTOR` と `propertyParams` の使い方を足す提案（`.claude/` は本 Issue の範囲外のため、親へ報告）。
