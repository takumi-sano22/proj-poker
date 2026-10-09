# Phase 0 — Repository / Docs / Tooling

> **これは当時の履歴であり、最新仕様の正本ではありません。** Phase 0 の完了時点で何が到達したかを残す記録です。現在の仕様と可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs・[`decision_log.yaml`](../decision_log.yaml)・実装を正本としてください。D 番号はここでは主題だけを書き、判断の原文は `decision_log.yaml` を読みます。

| 項目 | 内容 |
|---|---|
| 計画 | [`docs/08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md) §3「Phase 0」 |
| Parent | [#2](https://github.com/takumi-sano22/proj-poker/issues/2)（MVP Parent。Phase 0〜5。Close 済み） |
| 主な期間 | 2026-10-04（PR のマージ日） |
| 主な判断 | D01〜D66（設計の初期判断）・D67〜D69 |
| 索引 | [Phase 履歴の索引](./README.md) ／ 次: [Phase 1](./phase-1.md) |

## 目的と範囲

設計ドキュメントを正本として確定し、Claude Code の Skills / Harness と TypeScript のプロジェクト骨格・品質チェックをそろえて、プロダクト実装を始められる状態にする。プロダクト機能（Poker Engine・画面）は範囲外。

Phase 0 の終わりには「実装開始 Gate」（親 #2 の Gate。`docs/00` §7・`docs/08` §5）があり、人間が Skills / Harness を開発規約として確認するまで Phase 1 の実装に入らない運用でした。

## 到達した機能

- **設計ドキュメント一式**: `docs/00`〜`11`・`decision_log.yaml`（D01〜D66）・Research Pack を確立した（[PR #1](https://github.com/takumi-sano22/proj-poker/pull/1)）
- **初期 UI アセット**: ヒーロー画像などの初期アセット（[PR #8](https://github.com/takumi-sano22/proj-poker/pull/8)）
- **Claude Code 資産**: 汎用の skills / agents / hooks / `CLAUDE.md` / `AGENTS.md` を proj-poker 向けに移設し（[#3](https://github.com/takumi-sano22/proj-poker/issues/3)）、固有 skill（`poker-invariant-review`・`poker-engine-testing`・`phase-planning`・`solver-poc`）を作った（[#4](https://github.com/takumi-sano22/proj-poker/issues/4)）
- **プロジェクト骨格**: pnpm workspace（`packages/engine`・`apps/server`・`apps/web`）と、Vite + React の SPA / 常駐 Node（Fastify）の Local Runtime という構成（[#9](https://github.com/takumi-sano22/proj-poker/issues/9)）
- **品質ツールと CI**: ESLint・Prettier（版を厳密固定）・Vitest・fast-check・`tsc --noEmit` と GitHub Actions。pre-commit hook は使わない（[#10](https://github.com/takumi-sano22/proj-poker/issues/10)）
- **ハーネスの実値化**: ハーネス資産のツールチェーン記述を実際の値に更新した（[#11](https://github.com/takumi-sano22/proj-poker/issues/11)）

## 主要な品質成果

- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check` の 4 つを CI で回す土台ができた（以後の全 Phase の品質ゲート）
- Engine は I/O・DB・LLM を import しない純粋 TypeScript とし、lint でも禁止する境界を最初から置いた

## 重要な判断

判断の原文は [`decision_log.yaml`](../decision_log.yaml)、実装領域との対応は [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を参照。

- D01〜D66: 設計の初期段階で確定したプロダクト要件・ドメイン・UI・学習・CPU の判断
- D67: Web Stack（Vite + React の SPA と常駐 Node の Local Runtime）
- D68: pnpm workspace と Engine の純粋性
- D69: 品質ツールと CI（pre-commit hook 不採用）

## Issue / PR / 作業ログ

| Issue | PR | 作業ログ |
|---|---|---|
| （設計ドキュメント） | [PR #1](https://github.com/takumi-sano22/proj-poker/pull/1) | — |
| 初期 UI アセット | [PR #8](https://github.com/takumi-sano22/proj-poker/pull/8) | [`issue-2-initial-ui-assets.md`](../taskLog/issue-2-initial-ui-assets.md) |
| [#3](https://github.com/takumi-sano22/proj-poker/issues/3) Claude Code 資産の移設 | [PR #6](https://github.com/takumi-sano22/proj-poker/pull/6) | [`issue-3-claude-assets.md`](../taskLog/issue-3-claude-assets.md) |
| [#4](https://github.com/takumi-sano22/proj-poker/issues/4) 固有 skill の新規作成 | [PR #7](https://github.com/takumi-sano22/proj-poker/pull/7) | [`issue-4-poker-skills.md`](../taskLog/issue-4-poker-skills.md) |
| [#9](https://github.com/takumi-sano22/proj-poker/issues/9) TypeScript スケルトン | [PR #12](https://github.com/takumi-sano22/proj-poker/pull/12) | [`issue-9-ts-skeleton.md`](../taskLog/issue-9-ts-skeleton.md) |
| [#10](https://github.com/takumi-sano22/proj-poker/issues/10) Lint / Typecheck / Test / Format と CI | [PR #13](https://github.com/takumi-sano22/proj-poker/pull/13) | [`issue-10-quality-ci.md`](../taskLog/issue-10-quality-ci.md) |
| [#11](https://github.com/takumi-sano22/proj-poker/issues/11) ツールチェーン記述の実値化 | [PR #14](https://github.com/takumi-sano22/proj-poker/pull/14) | [`issue-11-harness-toolchain.md`](../taskLog/issue-11-harness-toolchain.md) |

## 次の Phase へ引き継いだ事項

[`issue-11-harness-toolchain.md`](../taskLog/issue-11-harness-toolchain.md) の「持ち越したもの」にある 5 件を、それぞれ最初に必要になる Issue で決める方針にした。

- Chip の数値表現 → Phase 1 で D74（整数の最小単位）
- ORM / マイグレーション → Phase 1 で D72（`node:sqlite`・生 SQL・自前マイグレーション）
- Scenario の形式と置き場 → Phase 1 の [#17](https://github.com/takumi-sano22/proj-poker/issues/17) で確定（`packages/engine/src/hand-scenarios.test.ts` の `HandScenario`。`poker-engine-testing` skill）
- Eval の置き場と実行コマンド → Phase 3 の AI Opponent Eval（[#53](https://github.com/takumi-sano22/proj-poker/issues/53)）
- worktree ごとの dev サーバーのポート採番 → 未作成のまま（`github-workflow` skill に記載）
