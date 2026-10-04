# Issue #10: Lint / Typecheck / Test / Format と CI の整備

## 概要

Phase 0「Lint / Typecheck / Test」として、ESLint・Prettier・Vitest・fast-check と GitHub Actions の CI を入れた。ポーカーのロジックは作っていない（Phase 1 の担当）。pre-commit hook は人間判断（D69）で入れない。

## 設計方針（D69 と親からの指示で確定済み）

- ESLint は flat config（`eslint.config.mjs`）。typescript-eslint の `recommendedTypeChecked` を使い、`no-floating-promises`・`no-misused-promises` は明示的に `error` にした。React の hooks ルールは `apps/web` にだけ当てた。
- `packages/engine` だけ `no-restricted-imports` を入れた。対象は fastify・react・react-dom・node の I/O 系（`node:` 接頭辞あり・なしの両方）・`@anthropic-ai/*`・SQLite 系。D68 の境界を、tsconfig の `types: []`（型だけを拒否する）より強い import 拒否で補強する目的。
- Prettier は `3.9.9` をキャレットなしで固定。設定ファイルは置かず既定値を使う（既存の TS / JSON / YAML は既定値のまま全て適合していた）。
- Vitest・fast-check は `packages/engine` の devDependencies に置いた。ルートに置くのは lint / format のツールだけ。

## 実装上の判断

- **Markdown を Prettier の対象外にした**: 既定値で `prettier --check` すると 57 ファイル（docs・skill・README）が差分になる。対象に含めると一括整形で本 Issue の差分が文書の整形で埋もれ、表セルの `*` / `|` を壊す既知の事故（`implementation-guidance/references/docs-harness.md` 10）もある。対象外にすれば既存ファイルの差分は 0 になるため、差分が最小になるこちらを選んだ。対象は TS / TSX / JSON / YAML / config。
- **`.claude/**` も整形対象外にした**: `.claude/settings.json` が既定値に適合しない。統制面は本 Issue の担当外で、harness 専用の Issue / PR で編集するため。
- **`apps/server/src/app.ts` の health handler から `async` を外した**: `require-await`（recommendedTypeChecked）が検出した。await が無い関数に `async` を付けていただけで、Fastify は同期 handler の戻り値をそのまま返すため挙動は変わらない。
- **テストの配置規約は `packages/engine/src/**/*.test.ts`（コロケーション）**: Vitest の既定の include と一致する。プロパティテストは `*.property.test.ts` とした（fast-check）。`tsconfig.json` は typecheck 用でテストを含め、build は新設の `tsconfig.build.json`（`src/**/*.test.ts` を除外）に切り替えて、テストを `dist` へ出さない。Engine の `types: []` のままでも、vitest は明示 import のため動く。
- **ルート `test` は `pnpm -r test`**: `test` script を持つパッケージだけが実行される（現在は engine のみ）。`apps/*` にテストを足すときは、そのパッケージに vitest と `test` script を足す。
- **TypeScript は 6.0.3 のまま**: typescript-eslint 8.71.0 の peer 範囲（`>=4.8.4 <6.1.0`）のため。
- **CI**: `actions/checkout@v7`・`pnpm/action-setup@v6`・`actions/setup-node@v7`（いずれもメジャータグ）。pnpm の版は `packageManager` から読まれる。permissions は `contents: read` のみ。

## 変更ファイル

- 新規: `eslint.config.mjs`・`.prettierignore`・`.github/workflows/ci.yml`・`packages/engine/tsconfig.build.json`・`packages/engine/src/index.test.ts`・`packages/engine/src/index.property.test.ts`
- 変更: `package.json`（scripts 5 つ・devDependencies）・`packages/engine/package.json`（`test` script・build を `tsconfig.build.json` へ・devDependencies）・`pnpm-lock.yaml`・`apps/server/src/app.ts`（`async` 除去）
- 触っていない: `.claude/**`・`CLAUDE.md`・`AGENTS.md`・`README.md`・`docs/decision_log.yaml`

## 実行した確認

- ローカルで 5 コマンド（`pnpm lint` / `typecheck` / `test` / `format` / `format:check`）の緑を確認（実出力は PR の Test plan）。
- 一時ファイルで lint ルールの検出を確認して削除済み: Engine から `node:fs`・`net`・`fastify`・`react`・`@anthropic-ai/sdk`・`better-sqlite3` を import すると `no-restricted-imports`、`no-floating-promises` が検出される。`apps/web` では条件付き hooks（`rules-of-hooks`）と async の onClick（`no-misused-promises`）が検出される。

## 残課題

- `CLAUDE.md`「品質チェック」へのコマンド追記、`github-workflow` / `test-and-review` skill の pnpm・コマンドの読み替え、README の更新は #11 の担当（統制面・README のため本 Issue では触っていない）。
- `apps/server` / `apps/web` のテストは未整備（Phase 1 以降で必要になった時点で追加）。
