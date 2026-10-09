# proj-poker ドキュメント索引

状態: Architecture / Requirements Baseline v1  
日付: 2026-10-04

## 1. このドキュメント群の目的

この `docs/` は、Claude Codeと人間レビューの双方が参照する**実装上の正本**です。

このプロジェクトの目的は単なるポーカーゲームではありません。

**ライブ実戦を意識したNo-Limit Texas Hold'em練習環境 + AIコーチングシステム**として、基本ルールは分かるが実践経験・判断ノウハウが不足しているユーザーを、カジュアルな経験者と勝負できるレベルまで引き上げることを目的とします。

## 2. 文書言語規約

**人間向けの文章は原則として日本語で記述します。**

英語をそのまま保持してよいもの:
- コード識別子
- 型名・関数名
- API名
- 外部ライブラリ名
- モデル名
- ポーカー業界で一般的な専門用語
- 外部仕様の正式名称

専門用語は、必要に応じて「日本語説明（英語）」の形で併記します。

Claude Codeが新しいMarkdown、Issue本文、PR本文、README、設計メモ等を作成する場合も、この規約を継承してください。

## 3. ドキュメントの優先順位

ドキュメント間に矛盾がある場合は、以下の順で優先します。

1. `decision_log.yaml` — 採用済みの人間判断
2. `01_PRODUCT_REQUIREMENTS.md` — プロダクト要件
3. `02_DOMAIN_RULES_AND_POLICIES.md` — ドメインルール・Invariant
4. `03_SYSTEM_ARCHITECTURE.md` — システムアーキテクチャ
5. `04_DATA_AND_EVENTS.md` — データ・Event設計
6. `05_AI_OPPONENTS_AND_REVIEW.md` — AI CPU・Review設計
7. `06_UI_UX.md` — UI/UX
8. `07_LEARNING_AND_ANALYTICS.md` — 学習・分析
9. `08_MVP_AND_ROADMAP.md` — MVPと実装順
10. `09_TEST_STRATEGY.md` — テスト戦略
11. `research/*` — Research Pack
12. 実装コメント・生成コード

**Research Packは根拠資料であり、プロダクト仕様そのものではありません。**

一般的な戦略記事が、採用済みの人間判断を上書きしてはいけません。

### 3.1 優先順位の外にある文書（入口・手順・履歴・記録）

次の文書は上の優先順位に入りません。仕様を定めず、矛盾したら上の正本（と実装）を優先して、こちらを直します。

| 文書 | 層 | 役割 |
|---|---|---|
| ルート `README.md` | 入口 | 何のプロジェクトか・現在の状態の短い要約・最短の起動手順・文書への導線だけを置く。Phase の作業履歴や Issue / PR / D 番号の列挙は置かない |
| `guides/*` | 手順 | セットアップ・開発コマンド・E2E・画面の使い方・現在の制約の一覧。コマンドと既定値は `package.json`・`.nvmrc`・実装に合わせる |
| `phases/*` | 履歴 | Phase 0〜8 の当時の到達点・判断の参照・Issue / PR / 作業ログへの導線。最新仕様の正本ではない |
| `taskLog/*` | 記録 | Issue ごとの作業の原本（調査・実行したコマンド・結果）。後から書き換えない |

### 3.2 読む順番

1. ルート [`README.md`](../README.md) で、何のプロジェクトかと現在の状態をつかむ
2. 動かすなら [`guides/SETUP_AND_DEVELOPMENT.md`](./guides/SETUP_AND_DEVELOPMENT.md)、使い方と制約は [`guides/USAGE_AND_LIMITATIONS.md`](./guides/USAGE_AND_LIMITATIONS.md)
3. 仕様はこの索引（§4）から、触る領域の Domain docs（`01`〜`09`）を読む。判断の理由は `decision_log.yaml` と `10_DECISION_TRACEABILITY.md`、未確定の事項は `11_OPEN_ITEMS.md`
4. 経緯を知りたいときは [`phases/README.md`](./phases/README.md) から Phase の履歴を読み、細部は `taskLog/` の作業ログをたどる

## 4. 各ファイルの責務

| ファイル | 責務 |
|---|---|
| `decision_log.yaml` | D01〜D132の採用済み人間判断 |
| `01_PRODUCT_REQUIREMENTS.md` | 機能要件・非機能要件・スコープ |
| `02_DOMAIN_RULES_AND_POLICIES.md` | Poker Engine、裁定、Information Boundary、Invariant |
| `03_SYSTEM_ARCHITECTURE.md` | Component境界、Data Flow、AI/Solver/KB責務 |
| `04_DATA_AND_EVENTS.md` | Event Log、KnowledgeState、永続化、Review Version |
| `05_AI_OPPONENTS_AND_REVIEW.md` | CPU AI、人格、記憶、Review Pipeline |
| `06_UI_UX.md` | 実卓UI、チップ、宣言、Dealer、用語表示 |
| `07_LEARNING_AND_ANALYTICS.md` | Session Review、統計、弱点仮説、Drill |
| `08_MVP_AND_ROADMAP.md` | MVP Definition of Done、実装Phase |
| `09_TEST_STRATEGY.md` | Deterministic / AI / E2E test |
| `10_DECISION_TRACEABILITY.md` | D01〜D132と実装領域の対応 |
| `11_OPEN_ITEMS.md` | 意図的に未確定の事項 |
| `research/*` | ポーカードメインの調査・出典 |
| `guides/*` | セットアップ・開発・使い方・現在の制約（手順。§3.1） |
| `phases/*` | Phase 0〜8 の履歴（§3.1） |
| `taskLog/*` | Issue ごとの作業記録（§3.1） |

## 5. コア設計原則

### 5.1 ポーカールールは決定論的、戦略判断は確率的

Poker Engineが担当:
- 合法Action
- Pot / Side Pot
- Hand Ranking
- Button / Blind
- チップ移動

LLMが担当:
- 合法候補の中から戦略的に何を選ぶか

### 5.2 CPUごとに情報世界を分離する

各CPUへは専用 `KnowledgeState` だけを渡します。

global `GameState` をそのままLLMへ渡してはいけません。

### 5.3 Reviewで結果論を混ぜない

Decision ReviewとReveal Reviewを明確に分離します。

### 5.4 AIの文章より根拠を先に作る

Math / Range / Solver / KB / Observationを構造化してからReview AIへ渡します。

### 5.5 段階実装

最初に `Play -> Event Log -> Review` の縦一本を完成させます。

最終形を一度に実装しないでください。

## 6. 明示的な非目標

現段階では以下を作りません。

- Real Money Gambling
- Online Multiplayer
- SaaS / Multi Tenant
- 認証基盤
- 3D Casino
- Voice Recognition
- LLM出力の完全な決定論的再現
- 全Multiway SpotのGTO Solver完全対応

## 7. 実装開始前の停止条件

進行手順:

1. ドキュメント確定
2. GitHub Repository作成
3. ドキュメントPR作成
4. Parent / Trigger Issue作成
5. **ここで停止**
6. 人間が他プロジェクト由来の汎用Claude Skills / Harnessを投入
7. その後にClaude Code実装を開始

この停止条件をClaude Codeが自己判断で解除してはいけません。
