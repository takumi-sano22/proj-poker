# Issue #9: TypeScript プロジェクトスケルトン（pnpm workspace・Engine / Server / Web）

## 概要

Phase 0「TypeScript Project Skeleton」として、pnpm workspace に Engine / Server / Web の空の骨組みを置いた。ポーカーのロジックは Phase 1 の担当のため作っていない。Lint / Test / Format / CI は #10 の担当のため入れていない。

## 設計方針（セッション冒頭で人間が確定済みの値）

- 構成: `packages/engine`（`@proj-poker/engine`・純粋 TS・runtime 依存ゼロ）、`apps/server`（`@proj-poker/server`・Fastify・`GET /api/health` のみ）、`apps/web`（`@proj-poker/web`・Vite + React の SPA・空の画面・dev で `/api` を server へ proxy）。
- pnpm は corepack で有効化し、`packageManager` に厳密な版を書く。`.nvmrc` は `24`、`engines.node` は `>=24 <25`。依存は厳密版で固定し、`pnpm-lock.yaml` をコミットする。
- server は `127.0.0.1` に固定バインドし、API キーは読まない（Phase 3 の担当）。
- docs は `decision_log.yaml` に D67〜D69 を追記し、`10_DECISION_TRACEABILITY.md`・`00_DOCUMENTATION_INDEX.md` の範囲表記と `03_SYSTEM_ARCHITECTURE.md` §1 を同期した。

## 実装上の判断

- **TypeScript は 6.0.3 で固定した**: npm の latest は 7.0.2 だが、D69 で採用した typescript-eslint（8.71.0）の peer 範囲が `typescript >=4.8.4 <6.1.0` のため、#10 で ESLint を入れられる最新の 6.0.x に揃えた。
- **Engine の tsconfig は `types: []`**: Node / DOM の型を読み込まず、I/O の誤 import を型検査で拒否できるようにした。
- **esbuild の build script は明示的に拒否した**: pnpm の `allowBuilds` に `esbuild: false` を置いた。tsx が使う esbuild は optionalDependencies のバイナリで動き、postinstall は検証のみのため。
- **`@types/node` は 24.x**: Node 24 に型を合わせた（最新の 26.x は使わない）。
- **root の `dev` は `pnpm --parallel --filter ... dev`**: 並行起動の追加依存（concurrently 等）を入れないため。
- **server は `buildApp()` と `listen` を分けた**: 後続 Issue でテストから起動せずに叩けるようにするため。
- **Engine は apps から参照していない**: Phase 1 で必要になった時点で workspace 依存を足す（先回りしない）。

## 変更ファイル

- 新規: `package.json`・`pnpm-workspace.yaml`・`pnpm-lock.yaml`・`.nvmrc`・`tsconfig.base.json`
- 新規: `packages/engine/{package.json,tsconfig.json,src/index.ts}`
- 新規: `apps/server/{package.json,tsconfig.json,src/app.ts,src/index.ts}`
- 新規: `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx}`
- 変更: `.gitignore`（`node_modules/`・`dist/`・`*.tsbuildinfo`）
- 変更: `docs/decision_log.yaml`（D67〜D69 追記・先頭の範囲表記）、`docs/10_DECISION_TRACEABILITY.md`、`docs/00_DOCUMENTATION_INDEX.md`、`docs/03_SYSTEM_ARCHITECTURE.md`
- 触っていない: `.claude/**`・`CLAUDE.md`・`AGENTS.md`・`README.md`

## 実行した確認

確認結果は PR の Test plan に実出力の要点を記載した（`pnpm install` / `pnpm build` / `pnpm typecheck`、`pnpm dev` での server 直接と web proxy 経由の `/api/health`、`node apps/server/dist/index.js` での起動。起動したプロセスは停止済み）。

## 残課題

- 範囲表記 `D01〜D66` が、本 Issue の担当外の場所に残っている: `README.md:148`（#11 の担当）、`.claude/skills/sync-check/SKILL.md`・`.claude/skills/test-and-review/SKILL.md`（統制面）。親が別途更新する。
- `CLAUDE.md`「品質チェック」と `github-workflow`「共有物の symlink」節の pnpm 読み替え（pnpm の確定は本 Issue で行った）は統制面のため、親・#10 / #11 で更新する。
- Lint / Prettier / Vitest / fast-check / CI は #10。
