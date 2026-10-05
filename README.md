# proj-poker

![緑のポーカーテーブルとカードを描いたproj-pokerのヒーロー画像](./docs/assets/README-hero-proj-poker.png)

*完成イメージ（実装済みの画面ではありません）。*

**ライブ実戦を意識した No-Limit Texas Hold'em（NLHE）の練習・AIコーチング環境**です。

> 現在の状態: Phase 1（Vertical Poker Slice）の到達点 / ブラウザで **6-max Cash の 1 Hand を CPU 5 人と遊べます**。終わった Hand の Event Log は SQLite に残ります（Replay・Review・AI の CPU はまだありません）

## このプロジェクトを作る理由

ポーカーは、ルールを知っていることと、実際の卓で妥当な判断を続けられることの間に大きな差があります。

このプロジェクトでは、基本ルールは理解しているものの、以下のような実戦経験が不足しているプレイヤーを主な対象にします。

- 不完全情報の中での意思決定
- レンジ（Range）、エクイティ（Equity）、ポットオッズ（Pot Odds）、期待値（EV）
- バリューベット、ブラフ、フォールド判断
- 相手の傾向を観察して戦略を調整すること
- 実卓でのチップ操作・宣言・裁定
- 結果論に引きずられない振り返り

最終的な目標は、**カジュアルな経験者と実戦で勝負できるレベルまで、実践的な判断力を引き上げること**です。

## プロダクト概要

このアプリでは、以下を一つの学習ループとして統合します。

- **2〜8人のNLHE卓**
- **AI CPUプレイヤー**
  - 実力差
  - プレイスタイル差
  - 継続的な観察記憶
  - 人間らしいリークや一時的なティルト
- **ライブ卓を意識したチップ操作**
  - 数字入力だけではなく、実際のチップ額面を扱う
  - 宣言とチップ操作の組み合わせも練習する
- **ディーラー裁定**
  - One-chip rule
  - String bet
  - Out of turn
  - Minimum raise など
- **ハンドレビュー**
  - 判断時点で知り得た情報だけを使う評価
  - ハンド終了後の全手札開示による答え合わせ
- **数学 + レンジ分析 + Solver + AI解説**
- **長期的な傾向分析と弱点別ドリル**

## 設計上の重要原則

### 1. ポーカーのルールは決定論的に処理する

カード配布、合法Action、ポット、サイドポット、ハンドランク、チップ移動などは**決定論的なPoker Engine**が担当します。

LLMは「どのActionを選ぶか」を判断しますが、**そのActionが合法かどうかは判断しません**。

### 2. 各CPUの情報世界を分離する

CPUごとに独立した `KnowledgeState` を構築します。

CPUへ渡してはいけない情報:

- 他プレイヤーの非公開Hole Cards
- 未来のカード
- 学習用に特別開示したカード
- 他CPUだけが知っている情報
- ユーザーの学習用弱点プロフィール

### 3. レビューで結果論を混ぜない

ハンドレビューは二段階に分けます。

1. **Decision Review**
   - 判断した時点で知り得た情報だけで評価
2. **Reveal Review**
   - ハンド終了後に全手札を開示し、読みと実際を比較

後から見えたカードを理由に、当時の妥当な判断を誤り扱いしないことを重要なInvariantとします。

### 4. AIの文章より先に根拠を構造化する

レビューは概ね次の順に処理します。

```text
Hand Events
  ↓
判断時点の情報を再構築
  ↓
決定論的な数学計算
  ↓
Range分析
  ↓
対応可能ならSolver
  ↓
ローカルKnowledge Base
  ↓
根拠不足時のみWeb検索
  ↓
Review AI
```

AIは「もっともらしい答えを作る計算機」ではなく、**複数の根拠を統合して説明するコーチ**として使います。

## 技術構成

- **pnpm workspace**（D68）
  - `packages/engine`: 決定論的Poker Engine（純粋TypeScript。I/O・DB・LLMをimportしない。lintでも禁止）
  - `apps/server`: Local Runtime（常駐Node / Fastify。`127.0.0.1`だけで待ち受け。Claude APIとSQLiteはここだけが扱う）
  - `apps/web`: Local Browser UI（Vite + ReactのSPA。SSRなし。ブラウザへAPI Keyを渡さない）
- **品質ツール**（D69）: ESLint（typescript-eslint）・Prettier（版を厳密固定）・Vitest・fast-check・`tsc --noEmit`。CIはGitHub Actions。pre-commit hookは使いません
- Node 24 LTS（`.nvmrc`）。pnpmの版は`package.json`の`packageManager`で固定（corepack）
- SQLite（Node 24内蔵の`node:sqlite`。ORMなし・生SQL・自前マイグレーション。D72）: 終わったHandのEvent Logを保存
- 対戦CPU: Claude Haiku級を初期候補 / Review: より上位のClaudeモデルを初期候補
- ローカルSolverをAdapter経由で接続（必要ならRust / Python / C++の専門解析器もAdapter越しに利用）

具体的なモデル名・Solverは固定せず、実装時にコスト・速度・品質をPoCで比較します。構成の詳細は [`docs/03_SYSTEM_ARCHITECTURE.md`](./docs/03_SYSTEM_ARCHITECTURE.md) を参照してください。

## セットアップ

前提: Node 24（`.nvmrc`）。

```bash
corepack enable          # package.json の packageManager に書いた版の pnpm を使う
pnpm install
pnpm dev                 # apps/server（127.0.0.1:3001）と apps/web（Vite）を同時に起動
```

ブラウザで Vite が表示するURL（既定は `http://127.0.0.1:5173`）を開き、「Hand を始める」を押すと、Hero として 6-max の 1 Hand を遊べます（CPU 5 人。終わったら「次の Hand へ」）。

| 環境変数 | 既定 | 内容 |
|---|---|---|
| `POKER_DB_PATH` | `apps/server/data/poker.sqlite`（gitignore 済み） | Event Log を保存する SQLite ファイル。`:memory:` なら保存しない |
| `TABLE_SIZE` | `6` | 卓の人数（Hero + CPU）。2〜8 の整数。範囲外・不正値は 6 に戻す |
| `BOT_THINK_DELAY_MS` | `600` | CPU の思考に見せる待ち時間（演出のみ） |
| `PORT` | `3001` | `apps/server` の待ち受けポート（`127.0.0.1` 固定） |

## 開発コマンド

リポジトリのルートで実行します。CI（`.github/workflows/ci.yml`）も同じ4つを実行します。

| コマンド | 内容 |
|---|---|
| `pnpm lint` | ESLint |
| `pnpm typecheck` | 全パッケージの `tsc --noEmit` |
| `pnpm test` | Vitest（`packages/engine`・`apps/server`・`apps/web`） |
| `pnpm format:check` | Prettier の整形チェック（適用は `pnpm format`） |

## MVPの完成条件

MVPは「ポーカーが遊べる」だけでは完成としません。

最低限、以下が一気通貫で動くことをMVPとします。

1. AI CPU相手にNLHE Cashを1セッション遊べる
2. 実卓寄り2D UIとチップ操作を使える
3. Hand Event Logを保存できる
4. Replayできる
5. 判断時点の情報だけを使ってReviewできる
6. ハンド終了後に全Hole Cardsを学習用に確認できる
7. 数学・AI・対応可能なSolverによる解析を受けられる
8. 追加質問できる

**Hand Reviewまで含めてMVPです。**

## ドキュメント

実装時の正本は [`docs/`](./docs) 配下です。

最初に読む順番:

1. [ドキュメント索引](./docs/00_DOCUMENTATION_INDEX.md)
2. [プロダクト要件](./docs/01_PRODUCT_REQUIREMENTS.md)
3. [ドメインルールとポリシー](./docs/02_DOMAIN_RULES_AND_POLICIES.md)
4. [システムアーキテクチャ](./docs/03_SYSTEM_ARCHITECTURE.md)
5. [MVPとロードマップ](./docs/08_MVP_AND_ROADMAP.md)
6. [人間判断のトレーサビリティ](./docs/10_DECISION_TRACEABILITY.md)
7. [Research Pack](./docs/research/README.md)

D01〜D81の確定した人間判断は、機械可読な [`docs/decision_log.yaml`](./docs/decision_log.yaml) にも保存しています。

## ドキュメント言語

**このプロジェクトの人間向け文章は原則として日本語で記述します。**

例外:
- コード識別子
- API名
- 型名
- ライブラリ名
- 一般的なポーカー専門用語
- 外部仕様上そのまま保持すべき名称

これらは必要に応じて英語を保持し、日本語説明を併記します。

## 開発方針

AI駆動開発を前提にしていますが、AIに設計判断を丸投げしません。

実装前に:

- 人間判断をDecision Logへ固定
- ポーカードメインをResearch Packで調査
- ArchitectureとInvariantを明示
- 未確定事項をOpen Itemsへ隔離
- deterministic testを実行可能な仕様として使う

という順で進めます。

## 現在のフェーズ

**Phase 1 — Vertical Poker Slice** の到達点です（[`docs/08_MVP_AND_ROADMAP.md`](./docs/08_MVP_AND_ROADMAP.md) §3）。

できていること:

- 設計ドキュメント（`docs/`）と人間判断（D01〜D81）、Claude Code Skills / Harness（`.claude/`）、Lint / Typecheck / Test / Format と CI（Phase 0）
- 決定論的なPoker Engine（`packages/engine`）: 6-max Cash・全員100BBの均等Stack・単一Potで、Fold / Check / Call / Bet / Raise / All-in・Minimum Raise・Showdown・Hand Ranking・Split Pot（端数はButtonの左から。D75）を扱います。Scenario・Invariant・Property のテスト付き
- ブラウザで遊べる Basic UI（`apps/web`）: 2Dの卓・実額表示（BBは補助）・合法Actionだけの宣言ボタン・進行ログ・Hero Fold 後の観戦
- 暫定CPU（D71）: seed付きの決定論ルールBot。そのCPUに見える情報だけで合法Actionから選びます
- Event Log（D37）: Handの進行はすべてEventで表し、終わったHandのEventをSQLiteへ1トランザクションで保存します（Completed Handが保存の境界。D62）

制約・未実装:

- 1 Hand ずつの独立した練習です。Stackは毎Hand均等に戻り、Sessionの集計・Stackの持ち越しはありません
- Side Pot・Short All-in Reopen・2〜8人の可変人数はPhase 2です（Phase 1では未対応の状態をEngineがエラーにします）
- 保存したHandを画面から開くReplay・Hand Review・LLMのCPU・Chip操作（Click + Drag）は未実装です
- Hand の途中でサーバーを止めると、そのHandは保存されません（終わったHandだけが残る）
- MVPの完成条件（[親 Issue #2](https://github.com/takumi-sano22/proj-poker/issues/2) のDefinition of Done）はまだ満たしていません

次は **Phase 2 — Full Poker Engine**（2〜8人・Side Pot・Heads-Up・Deterministic Tests）です。
