# Phase 履歴（Phase 0〜8）

proj-poker の実装を Phase ごとに振り返るための**履歴**です。各 Phase の目的・到達した機能・品質上の成果・重要な判断（D 番号）・Issue / PR / 作業ログへの導線を 1 ファイルずつにまとめています。

> **Phase 履歴は最新仕様の正本ではありません。** 各ファイルは「その Phase の完了時点で何が到達したか」の記録で、後の Phase で変わった仕様は書き換えません。現在の仕様・可否は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs（`docs/01`〜`09`）・[`decision_log.yaml`](../decision_log.yaml)・実装を正本とし、矛盾したらそちらを優先します。Phase の計画と Gate は [`08_MVP_AND_ROADMAP.md`](../08_MVP_AND_ROADMAP.md)、各 Phase の Definition of Done は Parent Issue が一次情報です。

## 一覧

| Phase | 名前 | Parent | 主な判断 | 要点 |
|---|---|---|---|---|
| [Phase 0](./phase-0.md) | Repository / Docs / Tooling | [#2](https://github.com/takumi-sano22/proj-poker/issues/2) | D01〜D69 | 設計 docs・Harness・pnpm workspace・品質ツールと CI |
| [Phase 1](./phase-1.md) | Vertical Poker Slice | [#2](https://github.com/takumi-sano22/proj-poker/issues/2) | D70〜D76 | 6-max 1 Hand・Basic UI・SQLite の Event Log |
| [Phase 2](./phase-2.md) | Full Poker Engine | [#2](https://github.com/takumi-sano22/proj-poker/issues/2) | D77〜D81 | 2〜8 人・Side Pot・Reopen・Position・Session |
| [Phase 3](./phase-3.md) | AI Opponents | [#2](https://github.com/takumi-sano22/proj-poker/issues/2) | D82〜D88 | KnowledgeState・Claude の CPU・Persona・Fallback |
| [Phase 4](./phase-4.md) | Live Mechanics | [#2](https://github.com/takumi-sano22/proj-poker/issues/2) | D89〜D93 | Chip 操作と宣言・Ruling・Dealer Feedback・Replay |
| [Phase 5](./phase-5.md) | MVP Review | [#2](https://github.com/takumi-sano22/proj-poker/issues/2) | D94〜D101 | Resume・Math / Range / KB / Solver・Review（Pass A / B）・E2E。**MVP 完成** |
| [Phase 6](./phase-6.md) | Session Learning | [#105](https://github.com/takumi-sano22/proj-poker/issues/105) | D102〜D117 | Stats・Score・Hypothesis・Session Review・Drill・Learning Reset |
| [Phase 7](./phase-7.md) | Rich Opponent Simulation | [#106](https://github.com/takumi-sano22/proj-poker/issues/106) | D118〜D126 | Fixed CPU / Guest・Memory・Tilt・Table Tendency |
| [Phase 8](./phase-8.md) | Tournament | [#107](https://github.com/takumi-sano22/proj-poker/issues/107) | D127〜D130 | 6-max STT・Blind / Ante・Payout・ICM・Tournament の CPU / Review |

MVP（Phase 0〜5）の Parent は [#2](https://github.com/takumi-sano22/proj-poker/issues/2)、Post-MVP（Phase 6〜8）は Post-MVP Parent [#104](https://github.com/takumi-sano22/proj-poker/issues/104) の下の Phase Parent です（D102）。いずれも Close 済みです。Phase 8 の完了後に行った横断の整理（D131・D132 など）は [Phase 8 の末尾](./phase-8.md#phase-8-完了後の横断整理) にまとめています。`docs/08` のロードマップは Phase 8 までです。

## 読む順番

1. まず [ルート README](../../README.md) で現在の状態をつかむ
2. 知りたい機能が入った Phase のファイルを読む（上の表の「要点」から選ぶ）
3. 判断の理由は D 番号で [`decision_log.yaml`](../decision_log.yaml) と [`10_DECISION_TRACEABILITY.md`](../10_DECISION_TRACEABILITY.md) を引く
4. 実装の細部・試行錯誤は、各ファイルの表から [`docs/taskLog/`](../taskLog/) の作業ログを開く

## 各ファイルの構成

各 Phase のファイルは同じ構成です: 目的と範囲 / 到達した機能 / 主要な品質成果 / 重要な判断 / Issue / PR / 作業ログ / 次の Phase へ引き継いだ事項。

## 更新のしかた

Phase（またはそれに相当するまとまり）を終えたら、`release-readme-sync` skill に従って、ここに新しいファイルを足し、上の一覧に 1 行足します。ルート README には Phase の作業の履歴を積み増さず、短い「現在の状態」だけを更新します。過去の Phase のファイルは、誤記やリンク切れの修正を除いて書き換えません。
