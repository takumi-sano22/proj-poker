# hand-summary の Property の網羅の確認が seed に依存して落ちる（#167）

## 目的

`hand-summary.property.test.ts` の「どの判断の Information Set にも…」が、Property 本体ではなく**網羅の確認**（`seen` の toEqual）で、seed によって落ちる（River まで進む Hand がその seed の 150 ケースに 1 つも出ない）。Engine が正しくても CI が赤くなるのを直す。

## 方針（人間の指示）

- Property の 150 ケースと不変条件は弱めない。Property は「任意の入力で不変条件が崩れない」だけを担当する。
- 「その種類の Hand を通したか」の存在は random の seed に期待せず、固定 Scenario（決定論）が担当する。Property 側の網羅の assert は固定 Scenario 側へ移す。

## 変更内容

- `packages/engine/src/testing/hand-summary-checks.ts`（新規・build 対象外）: Property にあった `checkHand` を移して export（Hero を引数に。通した Hand の種類を `seen` へ足す）。検査の中身は変えていない。
- `packages/engine/src/hand-summary.property.test.ts`: `checkHand` の呼び出しと、seed 依存だった網羅の assert の削除。150 ケースと検査は同じ。
- `packages/engine/src/hand-summary.test.ts`: 固定 Scenario 5 本 + 全種類の確認 1 本を追加。同じ `checkHand` を、積んだ Deck で作る Hand（River まで進む / All-in の Important Spot / Oversized Chip の裁定 / Out-of-Turn の拘束 / CPU の Emergency Bot と打ち切り）に通し、各 Hand が狙いの種類（river・spot・ruling・oot・aborted+system）を通したことを assert する。
- `docs/09` §9: Property と固定 Scenario の分担を 1 段落追記。

## same-root sweep

`packages/engine/src/*.property.test.ts` 全 9 ファイルと `fc.assert` を持つ `*.test.ts` を確認。`fc.assert` の後に random の出方へ期待する assert（`seen` 等）を持つのは `hand-summary.property.test.ts` だけ。他は修正不要。

## 実行した確認

- 修正前（`git stash` で property の変更を戻した状態）: `POKER_PROPERTY_SEED=1474173281 pnpm --filter @proj-poker/engine exec vitest run src/hand-summary.property.test.ts` → 失敗（`網羅の確認（seed=1474173281）` で `river` が無い）
- 修正後: 同コマンド → 1 passed。別 seed 1 / 2 / 3 / 42 / 987654321 と既定（実行ごとの乱数）も 1 passed。
- `hand-summary.test.ts` 23 passed。ルートで `pnpm lint` / `pnpm typecheck` / `pnpm format:check` は exit 0、`pnpm test` は engine 369・web 141・server 769 がすべて passed。

## 残課題

- なし（Property 側で網羅を「保証」しなくなったため、Property の検査が特定の種類の Hand に偏って空振りしても Property 単体では検知しない。固定 Scenario が各種類で同じ検査を通すことで担保する）。
