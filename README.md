# proj-poker

![緑のポーカーテーブルとカードを描いたproj-pokerのヒーロー画像](./docs/assets/README-hero-proj-poker.png)

*完成イメージ（実装済みの画面ではありません）。*

**ライブ実戦を意識した No-Limit Texas Hold'em（NLHE）の練習・AIコーチング環境**です。

> 現在の状態: Phase 2（Full Poker Engine）の到達点 / ブラウザで **2〜8 人（既定 6-max）の NLHE Cash を CPU 相手に Session として続けて遊べます**（Stack は Hand をまたいで持ち越し、Bust した CPU は退席）。Side Pot・Short All-in の Reopen・Heads-Up への移行を Engine が扱います。終わった Hand の Event Log は SQLite に残ります（Replay・Review・AI の CPU はまだありません）

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
  - `apps/server`: Local Runtime（常駐Node / Fastify。`127.0.0.1`だけで待ち受け。ClaudeとSQLiteはここだけが扱う）
  - `apps/web`: Local Browser UI（Vite + ReactのSPA。SSRなし。ブラウザへClaudeの資格情報を渡さない）
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

ブラウザで Vite が表示するURL（既定は `http://127.0.0.1:5173`）を開き、「Hand を始める」を押すと、Hero として遊べます（既定は 6-max で CPU 5 人。人数は `TABLE_SIZE`）。Hand が終わったら「次の Hand へ」で Stack を持ち越して続けます。Hero が Bust するか、CPU が全員 Bust すると Session が終わり、「新しい Session を始める」で均等 Stack から始め直せます。

| 環境変数 | 既定 | 内容 |
|---|---|---|
| `POKER_DB_PATH` | `apps/server/data/poker.sqlite`（gitignore 済み） | Event Log を保存する SQLite ファイル。`:memory:` なら保存しない |
| `TABLE_SIZE` | `6` | 卓の人数（Hero + CPU）。2〜8 の整数。範囲外・不正値は 6 に戻す |
| `BOT_THINK_DELAY_MS` | `600` | CPU の思考に見せる待ち時間（演出のみ） |
| `OPPONENT_TIMEOUT_MS` | `30000`（暫定値） | CPU の 1 回の判断を待つ上限。超えたら障害として Hand を止める。1 以上の整数。不正値は既定に戻す |
| `OPPONENT_PROVIDER` | `rulebot` | CPU の判断に使う実装。`claude` で Claude（下の「Claudeの認証」が前提）。それ以外の値は起動時にエラーで止める |
| `CPU_PERSONAS` | `tag_regular,lag,nit,calling_station,weak_tight_recreational,maniac` | CPU の Persona を席順（CPU 1 から）に割り当てる順番。Preset ID（`tag_regular` / `lag` / `calling_station` / `nit` / `maniac` / `weak_tight_recreational`）のカンマ区切りで、CPU が多ければ先頭から繰り返す。知らない ID は起動時にエラーで止める。Persona は画面に出さない |
| `PORT` | `3001` | `apps/server` の待ち受けポート（`127.0.0.1` 固定） |

### Claudeの認証（CPU を Claude にするとき）

CPU の Claude 呼び出しは、API キーではなく **Claude Code の OAuth 認証（サブスクリプション枠）** を Claude Agent SDK 経由で使います（D87。D84 を変更）。既定の CPU は RuleBot なので、Claude に切り替えない限りこの手順は不要です。

1. **ログイン**: ターミナルで `claude` を起動し、`/login` でサブスクリプションのアカウントにログインします。
2. **動作確認**: `claude -p "OK とだけ返して"` が応答すれば、ログインできています。
3. **`ANTHROPIC_API_KEY` が無いことの確認**: server を起動するシェルで `[ -z "${ANTHROPIC_API_KEY:-}" ] && echo "未設定（OK）" || echo "設定あり（unset してください）"` を実行します。環境に `ANTHROPIC_API_KEY` があると、Agent SDK はそちらを優先し、サブスク枠ではなく **API 課金** になります（server は Claude を呼ぶ子プロセスの環境から外しますが〔#50〕、シェル側にも置かないでください）。
4. **CPU を Claude に切り替える**: server を起動するシェルで `OPPONENT_PROVIDER=claude` を設定して起動します（例: `OPPONENT_PROVIDER=claude pnpm dev`）。モデルは `opponent_fast` Role（暫定値 `claude-haiku-4-5`）です。起動ログに `"provider":"claude"` が出れば切り替わっています。

守ること:

- 資格情報は Claude Code が `~/.claude/` に持つものを使います。リポジトリ・`.env`・`apps/web`（ブラウザ）へ置かない・コピーしない・渡しません。Claude を呼ぶのはローカルの `apps/server` だけです（`claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` は使いません）。
- 本人のログインを本人がローカルで使う前提です。第三者が自分の製品で claude.ai ログインを提供することは公式に認められていないので、配布・共有はしないでください。
- サブスクの利用枠は、開発で使う Claude Code と**共有**です。CPU の判断を Claude にすると、そのぶん開発側の枠も減ります。
- ログイン切れ・利用枠の上限に達すると、CPU の判断が失敗し、障害として Hand が止まり、卓の中央に続け方を選ぶダイアログが出ます（Retry / Emergency Bot で続行 / Session を終了）。対処は、ログイン切れなら `claude` で `/login` し直してから Retry／上限なら枠が戻るまで待って Retry／すぐ続けたいときは Emergency Bot（その CPU を Session の終わりまで RuleBot で動かす）、のいずれかです。
- CI と `pnpm test` は Claude を呼びません（Fake と録画済み応答だけ）。開発中の実呼び出しは制限しません。

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

D01〜D88の確定した人間判断は、機械可読な [`docs/decision_log.yaml`](./docs/decision_log.yaml) にも保存しています。

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

**Phase 2 — Full Poker Engine** の到達点です（[`docs/08_MVP_AND_ROADMAP.md`](./docs/08_MVP_AND_ROADMAP.md) §3）。

できていること:

- 設計ドキュメント（`docs/`）と人間判断（D01〜D88）、Claude Code Skills / Harness（`.claude/`）、Lint / Typecheck / Test / Format と CI（Phase 0）
- 決定論的なPoker Engine（`packages/engine`）: NLHE Cash の 2〜8 人（Heads-Up は Button = SB）・不均等Stackで、Fold / Check / Call / Bet / Raise / All-in・Minimum Raise・Short All-in と累積 Short All-in の Reopen（TDA準拠。D79・OI-008 の暫定値）・Multi Side Pot（D78）・Showdown・Hand Ranking・Split Pot（端数はButtonの左から。D75）を扱います（Phase 1 は 6-max・均等Stack・単一Pot）
- Position Engine（D80・OI-008 の暫定値）: 前 Hand の結果から次 Hand の席と Button を決めます。Bust（Stack 0）した Player を外し、Button は時計回りで次の生存席へ（Dead Button なし）。3 人→Heads-Up の移行もここで扱います
- テスト: `docs/02` §5 の必須 Scenario のうち Phase 2 範囲を固定 Scenario（期待値は手計算）で揃え、2〜8 人・不均等Stackのランダム Hand と、Stack を持ち越す複数 Hand の Session で Chip 保存・Pot と Commit の一致を Property Test で確かめます（対応表は [`docs/taskLog/issue-36-phase2-scenarios.md`](./docs/taskLog/issue-36-phase2-scenarios.md)）
- Session（Server の Hand Orchestrator）: Stack を Hand 間で持ち越し、Bust した CPU は退席します。Hero の Bust か、Hero だけが残ったら Session を終えます（D80）。席・Stack・Button は直前の Hand の Event Log から作ります
- ブラウザで遊べる Basic UI（`apps/web`）: 2Dの卓（2〜8 席）・実額表示（BBは補助）・合法Actionだけの宣言ボタン・進行ログ・Hero Fold 後の観戦・Session 終了の表示
- 暫定CPU（D71）: seed付きの決定論ルールBot。そのCPUに見える情報だけで合法Actionから選びます
- Event Log（D37）: Handの進行はすべてEventで表し、終わったHandのEventをSQLiteへ1トランザクションで保存します（Completed Handが保存の境界。D62）

制約・未実装:

- 人数は起動時の `TABLE_SIZE` で決まり、途中参加・Rebuy / Top-up はありません。Session の集計（Stats）・Session 終了の Event はまだありません
- サーバーを再起動すると新しい Session から始まります（再起動後の Session Resume は Phase 5）
- Optional BB 表示・Fast Forward は Phase 4、Chip 操作（Click + Drag）・Dealer Feedback・Ruling（Oversized Chip・String Bet / Raise・Out of Turn）は Phase 4、Ante・Blind Level は Phase 8（Tournament）です
- 保存したHandを画面から開くReplay・Hand Review・LLMのCPU は未実装です
- Hand の途中でサーバーを止めると、そのHandは保存されません（終わったHandだけが残る）
- MVPの完成条件（[親 Issue #2](https://github.com/takumi-sano22/proj-poker/issues/2) のDefinition of Done）はまだ満たしていません

次は **Phase 3 — AI Opponents**（Model Adapter・KnowledgeState・Basic Persona・Structured Action・Retry / Fallback）です。
