# proj-poker

![緑のポーカーテーブルとカードを描いたproj-pokerのヒーロー画像](./docs/assets/README-hero-proj-poker.png)

*完成イメージ（実装済みの画面ではありません）。*

**ライブ実戦を意識した No-Limit Texas Hold'em（NLHE）の練習・AIコーチング環境**です。

> 現在の状態: Phase 5（MVP Review）の到達点 / ブラウザで **2〜8 人（既定 6-max）の NLHE Cash を CPU 相手に Session として続けて遊び、終わった Hand を Review できます**。Bet は **実際の Chip の額面を Click / Drag で出す操作と宣言**で行い、Dealer が TDA 準拠で裁定します。終わった Hand は **Replay** で一手ずつ見返し、**Hand Review** で判断時点の情報だけを使った評価（Pass A）・Hand 後の全員の札での答え合わせ（Pass B）・追加質問（Follow-up）を受けられます。CPU は既定の RuleBot のほか、設定で **Claude（Claude Code のログイン経由）** に切り替えられ、Review は Claude が書きます。サーバーを再起動しても、Hand の合間で止まった Session はそのまま続きます

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
  - `e2e`: 6-max Session の E2E（Playwright。D98）
- **品質ツール**（D69）: ESLint（typescript-eslint）・Prettier（版を厳密固定）・Vitest・fast-check・`tsc --noEmit`。CIはGitHub Actions。pre-commit hookは使いません
- Node 24 LTS（`.nvmrc`）。pnpmの版は`package.json`の`packageManager`で固定（corepack）
- SQLite（Node 24内蔵の`node:sqlite`。ORMなし・生SQL・自前マイグレーション。D72）: 終わったHandのEvent Logを保存
- Claude: Claude Agent SDK で、Claude Code の OAuth（サブスクリプション枠）を使います（API キーは使いません。D87）。モデルは Role で選び、暫定値は対戦 CPU `opponent_fast` = `claude-haiku-4-5`・Review `review_standard` = `claude-sonnet-5-5`・「詳しく」`review_deep` = `claude-opus-5-5` です（D85・D97・OI-001。永久仕様ではありません）
- Solver: ローカルの amaster97/poker_solver（MIT）を Solver Adapter 経由で使います（Heads-Up の Turn / River だけ。D96・OI-002）
- Local KB: `apps/server/kb/` の Curated KB（Metadata 付き Markdown・Version 付き。D98）

モデル名・Solver は Domain Logic に書かず、Config（role-based config・Adapter）で差し替えます。構成の詳細は [`docs/03_SYSTEM_ARCHITECTURE.md`](./docs/03_SYSTEM_ARCHITECTURE.md) を参照してください。

## セットアップ

前提: Node 24（`.nvmrc`）。

```bash
corepack enable          # package.json の packageManager に書いた版の pnpm を使う
pnpm install
pnpm dev                 # apps/server（127.0.0.1:3001）と apps/web（Vite）を同時に起動
```

ブラウザで Vite が表示するURL（既定は `http://127.0.0.1:5173`）を開き、「Hand を始める」を押すと、Hero として遊べます（既定は 6-max で CPU 5 人。人数は `TABLE_SIZE`）。Hand が終わったら「次の Hand へ」で Stack を持ち越して続けます。Hero が Bust するか、CPU が全員 Bust すると Session が終わり、「新しい Session を始める」で均等 Stack から始め直せます。

- **Bet の操作**: 画面下の Hero 欄で Stack の Chip（額面 1 / 5 / 25 / 100 / 500）を Click で手に取り（Click の回数が枚数）、Click か Drag で Betting Area に出して「確定して Dealer に渡す」で送ります。宣言 Button だけでも、宣言と Chip の組み合わせでも操作できます。裁定はサーバーの Ruling Engine が行います。
- **見出しの切り替え**: 「BB 補助表示」で BB 換算の表示を ON / OFF できます（実額は常に出ます。設定はこのブラウザに保存）。「Replay を見る」で保存済みの Hand の一覧を開き、選んだ Hand を「前へ / 再生 / 一時停止 / 次へ」で一手ずつ見返せます。「卓に戻る」で卓の画面に戻ります（Replay を見ている間も卓の Hand はそのまま続きます）。
- **Fast Forward**: Hero が Fold した後の観戦中だけ、Hero 欄の Fast Forward で CPU の思考の待ち（演出）を縮められます。Claude の応答時間そのものは縮みません。
- **Hand Review**: Hand が終わると Hero 欄に「この Hand の Review」が出ます（Replay の画面からも開けます）。Important Spot（判断時点の情報だけで選んだ見直す価値の高い判断）が先に並び、判断を選んで「Review を作る」を押すと、判断時点の Review（段階評価・実戦的な Baseline・理論・前提・結論が変わる条件と根拠の Evidence）が出ます。「Hand 後の答え合わせ」のタブでは全員の札を見せて、読みと実際の比較・実際の Equity・Bluff / Value を答え合わせします（評価は付け直しません）。どちらにも質問（Follow-up）を続けられます。作り直すと新しい Version として残り、「詳しく作る」は上位のモデルを使います。Review は Claude を使うので、下の「Claudeの認証」が前提です（1 回に十数秒〜数十秒かかります）。「Replay でこの場面を見る」と Replay の「Important Spot へ」で、判断の場面へ移れます。

| 環境変数 | 既定 | 内容 |
|---|---|---|
| `POKER_DB_PATH` | `apps/server/data/poker.sqlite`（gitignore 済み） | Event Log を保存する SQLite ファイル。`:memory:` なら保存しない |
| `TABLE_SIZE` | `6` | 卓の人数（Hero + CPU）。2〜8 の整数。範囲外・不正値は 6 に戻す |
| `BOT_THINK_DELAY_MS` | `600` | CPU の思考に見せる待ち時間（演出のみ） |
| `OPPONENT_TIMEOUT_MS` | `30000`（暫定値） | CPU の 1 回の判断を待つ上限。超えたら障害として Hand を止める。1 以上の整数。不正値は既定に戻す |
| `OPPONENT_PROVIDER` | `rulebot` | CPU の判断に使う実装。`claude` で Claude（下の「Claudeの認証」が前提）。それ以外の値は起動時にエラーで止める |
| `CPU_PERSONAS` | `tag_regular,lag,nit,calling_station,weak_tight_recreational,maniac` | CPU の Persona を席順（CPU 1 から）に割り当てる順番。Preset ID（`tag_regular` / `lag` / `calling_station` / `nit` / `maniac` / `weak_tight_recreational`）のカンマ区切りで、CPU が多ければ先頭から繰り返す。知らない ID は起動時にエラーで止める。Persona は画面に出さない |
| `PORT` | `3001` | `apps/server` の待ち受けポート（`127.0.0.1` 固定） |
| `POKER_SOLVER_HOME` | 未設定 | Solver（amaster97/poker_solver）の導入先。下の「Solver の導入」で作る。未設定・未導入なら Solver を使わず、Math・Range・KB へ Fallback する |
| `SOLVER_TIMEOUT_MS` | `60000`（暫定値） | Solver の 1 回の Solve を待つ上限。超えたら止めて Fallback する。1 以上の整数。不正値は既定に戻す |
| `SOLVER_MAX_CONCURRENCY` | `1` | Solver を同時に動かす数。超えた分は待つ。1 以上の整数 |
| `SOLVER_ITERATIONS` | `200`（暫定値） | Solver の Iteration 数。1 以上の整数 |
| `REVIEW_TIMEOUT_MS` | `120000`（暫定値） | Review AI（Claude）の 1 回の呼び出しを待つ上限。超えたらその Review の生成を失敗にする（Hand は止めない）。1 以上の整数。不正値は既定に戻す |
| `REVIEW_PROVIDER` | `claude` | Review AI の実装。`fake` は **E2E 用**の固定応答（Claude を呼ばない）で、普段は設定しない。それ以外の値は起動時にエラーで止める |
| `POKER_SEED` | 未設定 | **E2E 用**。設定すると Hand ごとの山札の seed を固定の並び（値, +1, …）にする。未設定なら毎回乱数。0〜4294967295 の整数以外は起動時にエラーで止める |

### Claudeの認証（Hand Review を作るとき・CPU を Claude にするとき）

CPU の Claude 呼び出しは、API キーではなく **Claude Code の OAuth 認証（サブスクリプション枠）** を Claude Agent SDK 経由で使います（D87。D84 を変更）。既定の CPU は RuleBot なので、遊ぶだけならこの手順は不要です。Hand Review を作るとき（と CPU を Claude に切り替えるとき）に必要です。

1. **ログイン**: ターミナルで `claude` を起動し、`/login` でサブスクリプションのアカウントにログインします。
2. **動作確認**: `claude -p "OK とだけ返して"` が応答すれば、ログインできています。
3. **`ANTHROPIC_API_KEY` が無いことの確認**: server を起動するシェルで `[ -z "${ANTHROPIC_API_KEY:-}" ] && echo "未設定（OK）" || echo "設定あり（unset してください）"` を実行します。環境に `ANTHROPIC_API_KEY` があると、Agent SDK はそちらを優先し、サブスク枠ではなく **API 課金** になります（server は Claude を呼ぶ子プロセスの環境から外しますが〔#50〕、シェル側にも置かないでください）。
4. **CPU を Claude に切り替える**: server を起動するシェルで `OPPONENT_PROVIDER=claude` を設定して起動します（例: `OPPONENT_PROVIDER=claude pnpm dev`）。モデルは `opponent_fast` Role（暫定値 `claude-haiku-4-5`）です。起動ログに `"provider":"claude"` が出れば切り替わっています。CPU ごとの Persona は `CPU_PERSONAS` で選べます（例: `OPPONENT_PROVIDER=claude CPU_PERSONAS=maniac,calling_station TABLE_SIZE=3 pnpm dev`）。
5. **Hand Review**: 終わった Hand の判断の Review（Pass A・Pass B・Follow-up）は、`OPPONENT_PROVIDER` に関わらず Claude（`review_standard` Role。暫定値 `claude-sonnet-5-5`、「詳しく」は `review_deep`・`claude-opus-5-5`）で作ります。同じログインを使い、利用枠を使います。
6. **Eval（任意）**: `pnpm --filter @proj-poker/server eval:opponent` で、代表 Spot（Preflop の Open・3-bet に直面・Flop の C-bet・River の大きな Bet に直面）× 6 Persona の判断を実際に集め、出力の正しさ・Retry 率・Latency・Persona の差・情報漏れを表示します（`docs/09` §5）。1 回あたり数分かかり、利用枠を使います。

守ること:

- 資格情報は Claude Code が `~/.claude/` に持つものを使います。リポジトリ・`.env`・`apps/web`（ブラウザ）へ置かない・コピーしない・渡しません。Claude を呼ぶのはローカルの `apps/server` だけです（`claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` は使いません）。
- 本人のログインを本人がローカルで使う前提です。第三者が自分の製品で claude.ai ログインを提供することは公式に認められていないので、配布・共有はしないでください。
- サブスクの利用枠は、開発で使う Claude Code と**共有**です。CPU の判断を Claude にすると、そのぶん開発側の枠も減ります。
- ログイン切れ・利用枠の上限に達すると、Review の生成は失敗の理由を出し、もう一度作れます（Hand は止まりません）。CPU を Claude にしているときは CPU の判断が失敗し、障害として Hand が止まり、卓の中央に続け方を選ぶダイアログが出ます（Retry / Emergency Bot で続行 / Session を終了）。対処は、ログイン切れなら `claude` で `/login` し直してから Retry／上限なら枠が戻るまで待って Retry／すぐ続けたいときは Emergency Bot（その CPU を Session の終わりまで RuleBot で動かす）、のいずれかです。
- **CPU の 1 手に数秒〜十数秒かかります**（子プロセスの起動を含む。実測は [`docs/taskLog/issue-53-opponent-eval.md`](./docs/taskLog/issue-53-opponent-eval.md)）。待ちが長いと卓に「AI応答が遅延しています」が出ます。判断待ちの上限は `OPPONENT_TIMEOUT_MS` です。
- CI・`pnpm test`・`pnpm e2e` は Claude を呼びません（Fake と録画済み・固定の応答だけ）。開発中の実呼び出しは制限しません。

### Solver の導入（任意）

Hand Review の Solver Evidence には、ローカルの Solver **amaster97/poker_solver**（MIT）を使います（D96）。解けるのは **Heads-Up の Turn と River** だけで、Flop・Multiway（3 人以上）・Side Pot あり・Rake あり・Tournament の Spot は Solver を使わず、Math・Range・KB に切り替えます（Unsupported は正常な動きです。HU の Solver の結果を Multiway の Exact GTO として扱いません）。導入しなくてもアプリは動きます。

前提: `git`・`python3`（venv が使えること）・Rust の stable（[rustup](https://rustup.rs/)）。WSL2（Ubuntu 24.04）で確認しています。Windows ネイティブは未確認です。

1. **取得とビルド**: `bash apps/server/solver/setup-amaster97.sh` を実行します。固定した commit（`f78f1b2`）を clone し、venv に Rust 拡張ごとインストールして、導入先に `install.json`（commit・版）を書きます。既定の導入先はリポジトリの外の `~/.local/share/proj-poker/amaster97-poker-solver` で、`POKER_SOLVER_HOME` を付けて実行すると場所を変えられます（リポジトリの中は拒否します。Solver のソース・成果物はコミットしません）。
2. **server に場所を渡す**: server を起動するシェルで `POKER_SOLVER_HOME=<導入先>` を設定します（例: `POKER_SOLVER_HOME=~/.local/share/proj-poker/amaster97-poker-solver pnpm dev`）。
3. **動作確認**: `POKER_SOLVER_HOME=<導入先> pnpm --filter @proj-poker/server smoke:solver` で、固定 Spot の River と Turn を実際に解き、Root の行動頻度・所要時間・版を表示します（River 約 1 秒・Turn 約 8 秒。Flop と Multiway は Unsupported と表示されます）。最後に Timeout と Cancel で止めてプロセスが残らないことも確かめます。

- Solver は CPU とメモリを使います（Turn で約 430 MiB）。同時に動かすのは既定で 1 つで、`SOLVER_TIMEOUT_MS` を超えたら止めて Fallback します。
- Solver の結果は Root（Street の最初の判断・OOP）の行動頻度です。Action EV は今の呼び出し方では取れないので出しません（「取れない」と明示します）。
- CI と `pnpm test` は実 Solver を呼びません（偽の Solver と録画だけ）。

## 開発コマンド

リポジトリのルートで実行します。CI（`.github/workflows/ci.yml`）の `check` ジョブも上の4つを実行します。

| コマンド | 内容 |
|---|---|
| `pnpm lint` | ESLint |
| `pnpm typecheck` | 全パッケージの `tsc --noEmit` |
| `pnpm test` | Vitest（`packages/engine`・`apps/server`・`apps/web`） |
| `pnpm format:check` | Prettier の整形チェック（適用は `pnpm format`） |
| `pnpm e2e` | 6-max Session の E2E（Playwright。下の「E2E の実行」）。CI では別のジョブ `e2e` で動きます |

### E2E の実行

`e2e/tests/session.spec.ts` が、6-max の Session を開始 → Chip 操作と宣言で Hand を Play → Hand 終了 → Review（判断時点の段階評価 → Hand 後の答え合わせ → Follow-up）→ Replay（Important Spot へのジャンプ）→ 次の Hand → server を再起動して Resume（同じ Session・Stack を持ち越す）までを 1 本で通します（`docs/09` §8・D98）。

```bash
# 初回だけ: Playwright の Chromium（headless shell）を取得する。OS の依存パッケージも入れるなら --with-deps（sudo が要る）
pnpm --filter @proj-poker/e2e exec playwright install --only-shell chromium
pnpm e2e
```

- server（`127.0.0.1:3101`）と web（`127.0.0.1:5174`）を E2E が自分で起動・停止します。`pnpm dev`（3001 / 5173）と同時に動かせます。
- 決定論にするため、server は `POKER_SEED`（山札の seed の固定）・CPU は RuleBot・`REVIEW_PROVIDER=fake`（Review AI を固定応答に差し替え）・空の一時 DB で動きます。Claude と Solver は呼びません。
- 失敗したら `e2e/test-results/` に Trace・スクリーンショット・server のログが残ります（`pnpm --filter @proj-poker/e2e exec playwright show-trace <trace.zip>` で開けます）。
- 実際の Claude（OAuth）での通しは手動で行います（結果の例は [`docs/taskLog/issue-85-e2e-readme.md`](./docs/taskLog/issue-85-e2e-readme.md)）。

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

D01〜D116の確定した人間判断は、機械可読な [`docs/decision_log.yaml`](./docs/decision_log.yaml) にも保存しています。

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

**Phase 5 — MVP Review** の到達点です（[`docs/08_MVP_AND_ROADMAP.md`](./docs/08_MVP_AND_ROADMAP.md) §3。「ここでMVP完成」の Phase）。MVP の完成条件 1〜8（Session を遊べる・2D UI と Chip 操作・Event Log の保存・Replay・判断時点の情報だけの Review・全 Hole Cards の学習用の確認・数学 / AI / 対応可能な Solver による解析・追加質問）の機能がそろい、6-max Session の E2E で通しています。Definition of Done の確認は [親 Issue #2](https://github.com/takumi-sano22/proj-poker/issues/2) で行います。

できていること:

- 設計ドキュメント（`docs/`）と人間判断（D01〜D116）、Claude Code Skills / Harness（`.claude/`）、Lint / Typecheck / Test / Format と CI（Phase 0）
- 決定論的なPoker Engine（`packages/engine`）: NLHE Cash の 2〜8 人（Heads-Up は Button = SB）・不均等Stackで、Fold / Check / Call / Bet / Raise / All-in・Minimum Raise・Short All-in と累積 Short All-in の Reopen（TDA準拠。D79・OI-008 の暫定値）・Multi Side Pot（D78）・Showdown・Hand Ranking・Split Pot（端数はButtonの左から。D75）を扱います（Phase 2）
- Position Engine（D80・OI-008 の暫定値）と Session: Stack を Hand 間で持ち越し、Bust した CPU は退席。Hero の Bust か、Hero だけが残ったら Session を終えます
- テスト: `docs/02` §5 の必須 Scenario のうち Phase 2 範囲を固定 Scenario（期待値は手計算）で揃え、2〜8 人・不均等Stackのランダム Hand と、Stack を持ち越す複数 Hand の Session で Chip 保存・Pot と Commit の一致を Property Test で確かめます（対応表は [`docs/taskLog/issue-36-phase2-scenarios.md`](./docs/taskLog/issue-36-phase2-scenarios.md)）。Ruling も固定 Scenario と Property Test で確かめます
- ブラウザの卓（`apps/web`）: 2Dの卓（2〜8 席）・実額表示（BBは補助）・Stack と Bet の Chip の構成表示・進行ログ・Hero Fold 後の観戦・Session 終了の表示
- **AI Opponents（Phase 3）**: CPU ごとの KnowledgeState（他者の Hole Cards・未来のカード・他 CPU の Persona を渡さない。D28）・Claude の CPU（Claude Agent SDK・OAuth。D87）・6 種の Persona（D85）・出力の検証と 1 回の Retry → RuleBot の Fallback（D40・D41）・不正な出力と Fallback の Event（D83）・障害時の 3 択（Retry / Emergency Bot で続行 / Session を終了。D86）・AI Opponent Eval（`docs/09` §5）。既定の CPU は seed 付きの決定論ルール Bot（RuleBot。D71）です
- **Live Mechanics（Phase 4）**:
  - Chip の額面と構成（#62・D92）: 1（白）・5（赤）・25（緑）・100（黒）・500（紫）の Preset から、額の Chip の構成を自動で組んで卓に描きます
  - Chip の Click / Drag と宣言（#65）: Hero の Bet は、Chip を Betting Area へ出す操作と宣言 Button で行います（数値入力の Bet Box は使いません）。手番でなくても操作でき、Out of Turn として裁定されます
  - Ruling Engine（#63・D91）: 版付き Rule Profile `phase4_provisional_v1` で、TDA 準拠の 3 種を裁定します。**Oversized Chip**（宣言なしで Call 額を超える Chip を 1 枚出したら Call。相手の Bet が無ければその額の Bet）・**String Bet / Raise**（宣言なしで複数回に分けて出したら最初の 1 回の量で確定し、2 回目以降は返す）・**Out of Turn**（手番を戻して警告し、その間に最高額が変わらなければ拘束、変われば撤回して選び直し）。宣言と Chip は先にした方が Action を決め、宣言の額は合法な最も近い Action に寄せます（規則の一覧は `docs/02` の Preset の表）
  - 宣言・Chip の操作・裁定の Event（#64・D90）: `PLAYER_DECLARED` / `PHYSICAL_CHIP_ACTION` / `DEALER_RULING` を Event Log に残します（`schema_version` 5。版 1〜4 の行もそのまま読めます）
  - Dealer Feedback（#66）: 裁定を **裁定（Ruling）・作法（Etiquette）・学習（Coaching）** の 3 分類で、分けて出します（文言は決定論で作り、LLM は使いません。Coaching は判断時点の情報だけを使います）
  - Poker Vocabulary（#66・D45）: 卓の用語（日本語 + 標準 Term）を Hover / Click / キーボードで開くと、定義・今の Hand の例・関連する概念・補足が出ます
  - BB 補助表示の切り替えと Fast Forward（#67・D49・D93）: BB 換算の ON / OFF（実額は常に表示）と、Hero Fold 後の CPU の思考待ちの短縮（Claude の応答時間は縮まない）
  - **Replay**（#68・D38・D93）: Hand の一覧（開始の新しい順・最大 100 件）から選び、保存済みの Event を Hero の視点で一手ずつ再生します（前へ / 再生 / 一時停止 / 次へ）。AI や Engine で作り直さず（Re-simulation ではない）、他者の札は Showdown で公開された時点から見えます。宣言・Chip の操作・裁定も一手ずつ再生し、Dealer Feedback・Chip の構成・用語の説明は卓と同じものを出します
- Event Log（D37）: Handの進行はすべてEventで表し、終わったHandのEventをSQLiteへ1トランザクションで保存します（Completed Handが保存の境界。D62）
- **MVP Review（Phase 5）**:
  - Session の Event と Resume（#77・D95）: Session の開始・終了・Hand の打ち切り・Emergency Bot への切り替えを Event にし（`schema_version` 6）、Session Projection からサーバーの再起動後も同じ Session を続けます（Stack・Button・Emergency Bot を持ち越す）
  - 判断時点の Hero Information Set と Important Spot（#78）: Event Log から、判断の時点に Hero が知り得た情報だけを再構築し（未来の Card・他者の札・system の記録は入らない）、見直す価値の高い判断を決定論で選びます
  - Math / Equity / Range（#79）: Pot Odds・必要 Equity・仮定した Range に対する Equity（全列挙か Monte Carlo）・Alternative Action の簡易 EV を決定論で計算します（Range は前提付きの仮定）
  - Local KB（#80・D98）: `apps/server/kb/` の Curated KB（Metadata 付き・Version 付き）から、判断に関係する項目を Metadata と全文で引きます
  - Solver Adapter（#81・D96）: amaster97/poker_solver を Heads-Up の Turn / River で使い、Flop・Multiway・Side Pot・Rake・未導入は Unsupported として正常に Fallback します（HU の結果を Multiway の Exact GTO として扱いません）
  - Decision Review（Pass A。#82・D97）: Evidence（Math・Range・Solver・KB）を構造化してから Review AI（`review_standard`）に書かせ、Schema と根拠の参照を検証します（不正なら 1 回だけ再要求、根拠が足りなければ評価しない）。Version 付きで保存します（D39）
  - Reveal Review（Pass B）と Follow-up（#83・D99）: Hand 後に全員の札を学習用にだけ見せて答え合わせをし（評価は付け直さない・CPU には渡さない）、Review の Version ごとに追加質問を続けられます
  - Review の画面と Jump to Important Spot（#84）: Important Spot を先に並べた Review の一覧・Pass A / Pass B のタブ・Evidence・Version の選択・Follow-up と、Replay の Important Spot へのジャンプ
  - 6-max Session の E2E（#85・D98）: Playwright で Play → Review → Replay → 次の Hand → 再起動して Resume までを CI で通します（CPU は RuleBot、Review AI は固定応答）
  - Hand ごとの Metadata（#97・D100）: Hand の開始時に App Version・Rule Profile・Persona の Preset 一式の版と、席ごとの CPU の実装（RuleBot / Claude とモデル / Emergency Bot）を system の Event に残します（`schema_version` 7。Hero の画面・CPU・Replay には出ません）。AI の Request / Response の本文は保存しません

制約・未実装:

- Ruling の規則（Oversized Chip・String Bet・Multiple Chip・宣言・Out of Turn）は OI-008 の暫定値、Chip の額面は OI-004 の暫定値です（永久仕様ではありません）。物理的な誤操作をするのは Hero だけで、CPU は Canonical Action で行動します（D91）
- Replay の Hand 一覧に出る「未完了」の Hand（進行中・内部エラーで止まった Hand）はサーバーのメモリにだけあり、サーバーを再起動すると消えます。AI 障害の後に Session 終了で打ち切った Hand は「打ち切り」として保存され、再起動後も残ります（#77）
- Claude の CPU は 1 手に数秒〜十数秒かかります。利用枠は開発で使う Claude Code と共有です
- Persona の数値（OI-005）・モデル名（`claude-haiku-4-5` / `claude-sonnet-5-5` / `claude-opus-5-5`）と判断待ち・Review・Solver の上限（OI-001）・Primary Solver（OI-002）・Eval の合格ライン（`docs/09` §5・§6）は暫定値です（永久仕様ではありません）。Tilt（一時的な状態）・CPU の観察記憶は Phase 7 です
- **Solver は Heads-Up の Turn / River だけ**です。Preflop・Flop・Multiway（3 人以上）・Side Pot あり・Rake ありの Spot は Unsupported で、Math・Range・KB で Review します（Multiway の Deep Solver は OI-009）。Solver の結果は Street の最初の判断（OOP）の頻度だけで、Action EV は出しません
- **Web Fallback（根拠が足りないときの Web 検索）はありません**（D94・OI-010）。根拠が足りない判断は Review AI を呼ばずに「根拠が足りない」として評価しません
- Review は Claude（サブスク枠）を使い、1 回に十数秒〜数十秒かかります。相手の Observation（CPU ごとの傾向の記録）はまだ無いので、Exploit の観点は出ません
- 人数は起動時の `TABLE_SIZE` で決まり、途中参加・Rebuy / Top-up はありません。Session の集計（Stats）はまだありません。Ante・Blind Level は Phase 8（Tournament）です
- サーバーを再起動しても、Hand の合間で止まった Session はそのまま続きます（Stack・Button・Emergency Bot を持ち越す。#77）。Hand の途中で止めた場合は、その Hand は消え、最後に終わった Hand から続きます
- Hand の途中でサーバーを止めると、そのHandは保存されません（終わったHandだけが残る）

次は **Phase 6 — Session Learning** です（MVP の後の Phase。`docs/08` §3）。
