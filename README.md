# proj-poker

![緑のポーカーテーブルとカードを描いたproj-pokerのヒーロー画像](./docs/assets/README-hero-proj-poker.png)

*完成イメージ（実装済みの画面ではありません）。*

**ライブ実戦を意識した No-Limit Texas Hold'em（NLHE）の練習・AIコーチング環境**です。

> 現在の状態: Phase 6（Session Learning）の到達点 / ブラウザで **2〜8 人（既定 6-max）の NLHE Cash を CPU 相手に Session として続けて遊び、終わった Hand を Review し、Session の終わりに学習の振り返りと練習ができます**。Bet は **実際の Chip の額面を Click / Drag で出す操作と宣言**で行い、Dealer が TDA 準拠で裁定します。終わった Hand は **Replay** で一手ずつ見返し、**Hand Review** で判断時点の情報だけを使った評価（Pass A）・Hand 後の全員の札での答え合わせ（Pass B）・追加質問（Follow-up）を受けられます。Session の終わりには **Session Review**（判断の質・Ability ごとの Score・Hero の Stats・Leak）と **Player Profile**（直近 / 全期間・弱点の仮説）を見て、Leak の判断から一要素だけ変えた **Targeted Drill** を遊べます。CPU は既定の RuleBot のほか、設定で **Claude（Claude Code のログイン経由）** に切り替えられ、Review は Claude が書きます。サーバーを再起動しても、Hand の合間で止まった Session と学習の記録はそのまま続きます

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
| `CPU_PERSONAS` | `tag_regular,lag,nit,calling_station,weak_tight_recreational,maniac` | CPU の Persona を席順（CPU 1 から）に割り当てる順番。Preset ID（`tag_regular` / `lag` / `calling_station` / `nit` / `maniac` / `weak_tight_recreational`）のカンマ区切りで、CPU が多ければ先頭から繰り返す。知らない ID は起動時にエラーで止める。Persona は画面に出さない。Phase 7 の Fixed CPU（`phase7_pool_v1`）は常に自分の Persona で打つので、上書きは Fixed Pool で満たせる範囲で効く暫定の挙動（同じ Persona を Pool の人数より多い席に当てると、残りの席は Pool の Persona の CPU が座り、server のログに warn が出る） |
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
| `pnpm e2e` | Critical E2E（Playwright。6-max Session・Phase 6 の学習の流れ・Phase 7 の CPU の Memory。下の「E2E の実行」）。CI では別のジョブ `e2e` で動きます |

### E2E の実行

`e2e/tests/session.spec.ts` が、6-max の Session を開始 → Chip 操作と宣言で Hand を Play → Hand 終了 → Review（判断時点の段階評価 → Hand 後の答え合わせ → Follow-up）→ Replay（Important Spot へのジャンプ）→ 次の Hand → server を再起動して Resume（同じ Session・Stack を持ち越す）までを 1 本で通します（`docs/09` §8・D98）。

`e2e/tests/learning.spec.ts` が、Phase 6 の学習の流れを 1 本で通します（`docs/09` §8・#119）: 2 人卓で Session の終わりまで Play → Review（Pass A・Pass B）→ Session Review → Player Profile → Targeted Drill → 練習した判断の Review → Learning Reset（Hand の記録・Review・Drill の記録は残る）→ server を再起動しても学習の記録と Drill の provenance が同じ。

`e2e/tests/opponent-memory.spec.ts` が、Phase 7 の CPU の Memory の流れを 1 本で通します（`docs/09` §8・#144）: Fixed CPU と Guest の 6 人卓で Hero が Bust するまで Play → 新しい Session → 前の Session の観察を同じ `cpuProfileId` の CPU が Memory として使う・Guest は持ち越さない・CPU 同士の Private Memory が第三者の CPU に漏れない・Tilt は Session の終わりで 0 に戻る → Opponent Memory Reset の後は Reset より前の Hand を Memory に使わず、Note / Tag は残る → Hero の画面と API に Memory・Tilt・Persona・Pool の Identity が出ない。Memory・Tilt は Hero に見せない値なので、確認用の API は足さず、テストから一時 DB を読み取り専用で開き、server と同じ Projection の関数で作り直して確かめます。

```bash
# 初回だけ: Playwright の Chromium（headless shell）を取得する。OS の依存パッケージも入れるなら --with-deps（sudo が要る）
pnpm --filter @proj-poker/e2e exec playwright install --only-shell chromium
pnpm e2e
```

- server（`127.0.0.1:3101`）と web（`127.0.0.1:5174`）を E2E が自分で起動・停止します。`pnpm dev`（3001 / 5173）と同時に動かせます。
- 決定論にするため、server は `POKER_SEED`（山札の seed の固定）・CPU は RuleBot・`REVIEW_PROVIDER=fake`（Review AI を固定応答に差し替え）・空の一時 DB で動きます。Claude と Solver は呼びません。学習の流れの E2E は `TABLE_SIZE=2` と `FAKE_REVIEW_ASSESSMENT=improvement_suggested`（固定応答の Pass A の段階評価。既定は `reasonable`）、Memory の流れの E2E は `POKER_SEED=20261042`（両方の Session に Guest が座り、2 つ目の Session で初めて座る Fixed CPU がいる編成になる seed）と 1280×900 の画面（#158）で動きます。
- `pnpm e2e` は `NODE_OPTIONS=--conditions=@proj-poker/source` で Playwright を動かし、`apps/server` の Projection の関数と Engine を build せずに `src` から読みます。
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

D01〜D123の確定した人間判断は、機械可読な [`docs/decision_log.yaml`](./docs/decision_log.yaml) にも保存しています。

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

**Phase 7 — Rich Opponent Simulation** の到達点です（[`docs/08_MVP_AND_ROADMAP.md`](./docs/08_MVP_AND_ROADMAP.md) §3）。MVP（Phase 0〜5。完成条件 1〜8 の機能と 6-max Session の E2E。[親 Issue #2](https://github.com/takumi-sano22/proj-poker/issues/2)）と Phase 6（Session Learning。[#105](https://github.com/takumi-sano22/proj-poker/issues/105)）の上に、Session を跨いで同じ CPU（Fixed CPU）と Session 限りの Guest、CPU ごとの観察（Observation）と Private Memory、Tilt、卓の傾向（Table Tendency）、Opponent Memory Reset がそろい、Phase 7 の流れを Critical E2E で通しています。Phase 7 の Definition of Done の確認は [親 Issue #106](https://github.com/takumi-sano22/proj-poker/issues/106)、Phase 7 → 8 の Gate の確認は [#104](https://github.com/takumi-sano22/proj-poker/issues/104) で人間が行います（`docs/08` §3.2。各項目とテストの対応は `docs/09` §11）。

できていること:

- 設計ドキュメント（`docs/`）と人間判断（D01〜D123）、Claude Code Skills / Harness（`.claude/`）、Lint / Typecheck / Test / Format と CI（Phase 0）
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
  - **Replay**（#68・D38・D93）: Hand の一覧（新しい順＝進行中の Hand、続けて保存の新しい順・最大 100 件）から選び、保存済みの Event を Hero の視点で一手ずつ再生します（前へ / 再生 / 一時停止 / 次へ）。AI や Engine で作り直さず（Re-simulation ではない）、他者の札は Showdown で公開された時点から見えます。宣言・Chip の操作・裁定も一手ずつ再生し、Dealer Feedback・Chip の構成・用語の説明は卓と同じものを出します
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
- **Session Learning（Phase 6）**: Stats・Score・Profile・Hypothesis は Event Log（正本）と Pass A の Review から読むたびに作り直す Projection です（D37・D111・D113）
  - Detailed Stats（#112）: Event Log から全 Player の Stats（VPIP・PFR・3-bet・Fold to 3-bet・Flop の Continuation Bet と Fold to Continuation Bet・Aggression）を、割合だけでなく分子 / 分母 / 機会の数で再計算します。画面に出すのは Hero 自身の行だけで、Play 中の HUD は出しません（D32）
  - Ability Evidence と Score（#113）: Pass A の段階評価から、1 つの判断を複数の Ability（Preflop・Postflop・Bet Sizing・Pot / Equity Math・Range Reading・Opponent Adaptation・Position）に決定論で割り当て、版付きの `ScoringPolicy phase6_provisional_v1` で Score・Confidence・件数・Evidence IDs・Trend を計算します（「根拠が足りない」は点数に入れない。Live Mechanics は別の Score）
  - User Read / Note / Tag（#115・D112）: Hero の手番に読み（User Read）を Hero だけの Event（`schema_version` 8）として残し、判断の前の読みを Review の Evidence に provenance 付きで入れます。CPU ごとの Note / Tag は追記型のテーブル（マイグレーション v5）に残します。どちらも CPU の入力・Hidden Persona と混ざりません
  - Weakness Hypothesis と Player Profile（#114）: Supporting / Counter Evidence から決定論で状態が変わる弱点の仮説（Snapshot はマイグレーション v6）と、直近 100 件（Recent）/ 全期間（Long-term）の Profile。まとめの文は Structured Profile からのテンプレート文で、LLM も過去の文も入力にしません
  - Session Review（#116・D115）: Session の終わりに、判断の質（M 件中 N 件を Review 済み）・Ability ごとの Score・Strength / Leak・Important Hands・Hero の Stats・おすすめの Drill を出します。収支（実額が正本・BB は補助）は判断の質と別に小さく出します
  - Targeted Drill（#117・D116）: Leak の判断から、Effective Stack・Bet の額・相手の傾向のどれか一つだけを決定論で変えた類題を作り（Engine の Validation を通るものだけ）、1 Hand 遊んで練習した判断を Review します。元の Hand・判断・Review の provenance を追記型の `drills`（マイグレーション v7）に残し、結果は通常の Score と別に数えます（D105）
  - Learning Reset（#118・D114）: Score・弱点の仮説・まとめの文をカテゴリごとに、Reset より後に終わった Hand だけで数え直します（前後は壁時計ではなく保存の論理順序で決めます。#132・D117）。区切りの行を追記するだけ（マイグレーション v8・v9）で、Hand の記録・Review・Note / Tag・Stats は消えません（取り消しはできません）
  - Phase 6 の Critical E2E（#119）: Session の終わりまで Play → Review → Session Review → Profile → Drill → 練習した判断の Review → Learning Reset → 再起動しても学習の記録と provenance が同じ、を CI で通します（CPU は RuleBot、Review AI は固定応答）
- **Rich Opponent Simulation（Phase 7）**: CPU の層は Persona（Secret）・Long-term Memory（Session を跨ぐ）・Tilt（Session の中だけ）・Table Tendency を分けて持ち、どれも Event Log（正本）から Hand の開始時に作り直す Projection です（保存しない。D106・D107）。Persona・Memory・Tilt は Hero の画面・API・Review に出しません。Table Tendency は public の Event だけから作る卓の集計で、判断時点より前のものを Hero の Review の Evidence にも入れます（D122・#153）
  - Fixed CPU と Guest（#136・D118）: CPU は席（`cpu1` 等）と別の永続の `cpuProfileId` を持ちます。Fixed Pool（`phase7_pool_v1`）は 8 人で、Session の始まりに席ごとに Fixed CPU か Guest（1 卓に最大 1 席・その Session 限りの id）を seed で決めます。編成は追記型の `session_participants`（マイグレーション v10）に残し、Resume では同じ参加者で続けます。名前は画面に出しません
  - Observation（#137）: CPU が卓で実際に見た public の Event（Showdown で表にされた札を含む）だけを、Observer・Subject・Hand・seq・論理順序・Visibility・context 付きで Event Log から決定論で取り出します。他者の Hidden Cards・Future Cards・Learning-only Reveal・Hero の弱点は入りません
  - Private Hypothesis と Memory の注入（#138・#139・D119・D121）: Observer × Subject × context（cash / tournament）ごとに、recency decay（`phase7_memory_v1`）を掛けた傾向を作り、その CPU の KnowledgeState に、今の卓の相手ごとに上限付きの構造化データ（項目 5 つ・Evidence ID 3 つまで。`phase7_memory_injection_v1`）として渡します。他の CPU の Memory は渡しません
  - Tilt（#140・D107）: Version 付きの決定論の State Machine（`phase7_tilt_v1`。0〜3 段）で、大きい Pot の負け・連敗・Bluff が見つかった・大勝ちで上がり、Hand が進むと下がり、Session の終わりで 0 に戻ります
  - Table Tendency（#141）: 今の Session の、その CPU が座っていた Hand の public の Event だけから卓の傾向（`phase7_table_tendency_v1`）を作ります。CPU 同士の Private Memory は集めません
  - Hero の Review の卓の傾向（#153・D122）: Decision Review（Pass A）の Evidence に、判断の Hand より前に保存した、Hero が座っていた Hand の public の Event だけから作った卓の傾向を、項目ごとの Evidence ID 付きで入れます（十分な項目があるときだけ。数値は決定論のコードが正本で、Review AI は説明だけ）。Learning-only Reveal・CPU の Private Memory・Persona・Tilt は使わず、Pass B には入れません
  - 層の合成と Eval（#142）: RuleBot は Persona → Tilt → Table Tendency → Memory の順に上限付きで判断のしきい値をずらします（`phase7_rulebot_composition_v1`）。Claude の CPU には同じ構造化データを Prompt の節として渡します。Opponent Memory の Eval（Memory が戦略に効く・Fixed CPU の継続・Guest の一時性・Leakage 0）を CI で回し、分布と計算時間は `pnpm --filter @proj-poker/server eval:opponent-memory` で表示します（`docs/09` §5）
  - Opponent Memory Reset（#143・D120）: `POST /api/opponents/memory-resets` に `{ "scope": "all" }`（全 CPU）か `{ "scope": "cpu_profile", "cpuProfileId": "…" }`（1 つの Fixed CPU）を送ると、その時点より後に保存された Hand だけから Memory を作り直します。区切りの行を追記型の表（マイグレーション v11）に足すだけで、Hand の記録・Review・Note / Tag・Learning Reset の区切りは変えません（取り消しはできません。画面の入口はまだありません）
  - Phase 7 の Critical E2E（#144）: Fixed CPU と Guest の卓で複数 Session を Play し、Memory の持ち越し・Guest の破棄・Private Memory の分離・Tilt の Reset・Opponent Memory Reset を CI で通します（CPU は RuleBot）

制約・未実装:

- Ruling の規則（Oversized Chip・String Bet・Multiple Chip・宣言・Out of Turn）は OI-008 の暫定値、Chip の額面は OI-004 の暫定値です（永久仕様ではありません）。物理的な誤操作をするのは Hero だけで、CPU は Canonical Action で行動します（D91）
- Replay の Hand 一覧に出る「未完了」の Hand（進行中・内部エラーで止まった Hand）はサーバーのメモリにだけあり、サーバーを再起動すると消えます。AI 障害の後に Session 終了で打ち切った Hand は「打ち切り」として保存され、再起動後も残ります（#77）
- Claude の CPU は 1 手に数秒〜十数秒かかります。利用枠は開発で使う Claude Code と共有です
- Persona の数値（OI-005）・モデル名（`claude-haiku-4-5` / `claude-sonnet-5-5` / `claude-opus-5-5`）と判断待ち・Review・Solver の上限（OI-001）・Primary Solver（OI-002）・Eval の合格ライン（`docs/09` §5・§6）は暫定値です（永久仕様ではありません）
- **Fixed Pool の人数・名前・Persona の内訳と Guest の出やすさ（`phase7_pool_v1`）は OI-005 の暫定値、Memory の recency decay・十分な Sample の基準・注入の上限・Tilt の Trigger と幅・Table Tendency・層の合成と Memory の Eval の合格ライン（`phase7_*` の各 Policy）は OI-011 の暫定値**です（永久仕様ではありません）
- CPU の Memory・Tilt・Table Tendency は Hand の開始時に毎回 Event Log から計算します（Cache は無い。Cache を足すかは測って決める: #150）。卓の傾向の入った Hero の Review の実モデルの品質は、まだ録画で測っていません（Review Eval の録画は卓の傾向の入らない固定 Hand のまま。#153）。Memory の節が入った Prompt の Claude の CPU の Eval は、D123 により API キーを使わず OAuth 経路で最大 36 Decision を録画する予定で、まだ録画していません（#155）
- Opponent Memory Reset は API だけで、画面の入口はありません（Hero に Fixed CPU の名前・`cpuProfileId` を見せていないため）。1 つの Fixed CPU を対象にする Reset は、`cpuProfileId` を知っている場合だけ使えます
- テスト用の組み立て（`buildApp` に Event Store だけを独自の順序の源で渡す経路）では、既定の Learning Reset Store の区切りの番号が Event Store と別の源になります（本番の起動は同じ SQLite の DB を使うので影響しません: #157）
- **Solver は Heads-Up の Turn / River だけ**です。Preflop・Flop・Multiway（3 人以上）・Side Pot あり・Rake ありの Spot は Unsupported で、Math・Range・KB で Review します（Multiway の Deep Solver は OI-009）。Solver の結果は Street の最初の判断（OOP）の頻度だけで、Action EV は出しません
- **Web Fallback（根拠が足りないときの Web 検索）はありません**（D94・OI-010）。根拠が足りない判断は Review AI を呼ばずに「根拠が足りない」として評価しません
- Review は Claude（サブスク枠）を使い、1 回に十数秒〜数十秒かかります。CPU の Observation・Memory・Tilt は Hero の Review に入れないので（Hidden の層を Hero に見せない。D105・D107）、相手の傾向に基づく Exploit の観点は出ません
- 人数は起動時の `TABLE_SIZE` で決まり、途中参加・Rebuy / Top-up はありません。Ante・Blind Level は Phase 8（Tournament）です
- **Score・Hypothesis・Drill の式と値（`phase6_provisional_v1`・`phase6_hypothesis_v1`・`phase6_drill_v1`・Recent の 100 件）は OI-006 の暫定値**です（永久仕様ではありません）。Score は Review 済みの判断だけで数え、未 Review の判断をまとめて Review する機能はありません（D115。判断を 1 つずつ Review します）
- Session Review の画面は、Session が終わった（Hero の Bust・Hero だけが残った・AI 障害で終えた）後の「この Session を振り返る」から開きます。Player Profile・Drill の結果・Learning Reset はその画面の下にあります
- Targeted Drill は決定論の変形だけで、LLM で Spot を作る経路は Phase 6 の範囲外です。Drill の相手の傾向は Drill の設定の RuleBot で、元の Hand の CPU の性格ではありません
- Learning Reset は取り消せません（Hand の記録・Review は残るので、Replay と Review はそのまま開けます）。Session Review と Stats は Reset の対象ではありません
- サーバーを再起動しても、Hand の合間で止まった Session はそのまま続きます（Stack・Button・Emergency Bot を持ち越す。#77）。Hand の途中で止めた場合は、その Hand は消え、最後に終わった Hand から続きます
- Hand の途中でサーバーを止めると、そのHandは保存されません（終わったHandだけが残る）

次は **Phase 8 — Tournament** です（`docs/08` §3。Phase 7 → 8 の Gate を人間が確認してから着手します）。
