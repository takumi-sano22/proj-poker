# セットアップと開発ガイド

proj-poker をローカルで動かす・開発するための手順の詳細です。最短の起動手順は [ルート README](../../README.md#最短の起動手順) にあります。画面の使い方と現在の制約は [`USAGE_AND_LIMITATIONS.md`](./USAGE_AND_LIMITATIONS.md) を参照してください。

> このガイドは手順書です。仕様の正本は [ドキュメント索引](../00_DOCUMENTATION_INDEX.md) の Domain docs と [`decision_log.yaml`](../decision_log.yaml) です。コマンドと既定値は、ルートと各パッケージの `package.json`・`.nvmrc`・`apps/server/src/config.ts` を一次情報とし、変えたらこのガイドも同じ PR で直します。

## 1. 前提

- Node 24（`.nvmrc`。`package.json` の `engines.node` は `>=24 <25`）
- pnpm はルートの `package.json` の `packageManager` で版を固定し、corepack が解決します
- SQLite は Node 24 内蔵の `node:sqlite` を使うので、別のインストールは要りません
- Claude（Hand Review・Claude の CPU）と Solver は任意です。無くても遊べます（[§4](#4-claude-の認証)・[§5](#5-solver-の導入任意)）

## 2. インストールと起動

```bash
corepack enable          # package.json の packageManager に書いた版の pnpm を使う
pnpm install
pnpm dev                 # apps/server（127.0.0.1:3001）と apps/web（Vite）を同時に起動
```

- ブラウザで Vite が表示する URL（既定は `http://127.0.0.1:5173`）を開きます
- `apps/web` の `/api` は `apps/server` へ proxy します。proxy 先のポートは server と同じ環境変数 `PORT`（既定 3001）で決まるので、ポートを変えるときは `PORT=3101 pnpm dev` のようにルートで指定すると両方がそろいます
- server は `127.0.0.1` だけで待ち受けます。ブラウザへ Claude の資格情報は渡しません
- 遊び方は [`USAGE_AND_LIMITATIONS.md`](./USAGE_AND_LIMITATIONS.md) §1 にあります

## 3. 環境変数

server を起動するシェルで設定します（例: `TABLE_SIZE=3 pnpm dev`）。既定値の一次情報は `apps/server/src/config.ts` と `apps/server/src/index.ts` です。

| 環境変数 | 既定 | 内容 |
|---|---|---|
| `POKER_DB_PATH` | `apps/server/data/poker.sqlite`（gitignore 済み） | Event Log を保存する SQLite ファイル。`:memory:` なら保存しない。worktree ごとに別の DB になる |
| `TABLE_SIZE` | `6` | 卓の人数（Hero + CPU）。2〜8 の整数。範囲外・不正値は 6 に戻す |
| `BOT_THINK_DELAY_MS` | `600` | CPU の思考に見せる待ち時間（演出のみ） |
| `OPPONENT_TIMEOUT_MS` | `30000`（暫定値） | CPU の 1 回の判断を待つ上限。超えたら障害として Hand を止める。1 以上の整数。不正値は既定に戻す |
| `OPPONENT_PROVIDER` | `rulebot` | CPU の判断に使う実装。`claude` で Claude（[§4](#4-claude-の認証) が前提）。それ以外の値は起動時にエラーで止める |
| `CPU_PERSONAS` | `tag_regular,lag,nit,calling_station,weak_tight_recreational,maniac` | CPU の Persona を席順（CPU 1 から）に割り当てる順番。Preset ID（`tag_regular` / `lag` / `calling_station` / `nit` / `maniac` / `weak_tight_recreational`）のカンマ区切りで、CPU が多ければ先頭から繰り返す。知らない ID は起動時にエラーで止める。Persona は画面に出さない。Phase 7 の Fixed CPU（`phase7_pool_v1`）は常に自分の Persona で打つので、上書きは Fixed Pool で満たせる範囲で効く暫定の挙動（同じ Persona を Pool の人数より多い席に当てると、残りの席は Pool の Persona の CPU が座り、server のログに warn が出る） |
| `PORT` | `3001` | `apps/server` の待ち受けポート（`127.0.0.1` 固定）。`apps/web` の proxy 先も同じ値を読む |
| `POKER_SOLVER_HOME` | 未設定 | Solver（amaster97/poker_solver）の導入先（[§5](#5-solver-の導入任意)）。未設定・未導入なら Solver を使わず、Math・Range・KB へ Fallback する |
| `SOLVER_TIMEOUT_MS` | `60000`（暫定値） | Solver の 1 回の Solve を待つ上限。超えたら止めて Fallback する。1 以上の整数。不正値は既定に戻す |
| `SOLVER_MAX_CONCURRENCY` | `1` | Solver を同時に動かす数。超えた分は待つ。1 以上の整数 |
| `SOLVER_ITERATIONS` | `200`（暫定値） | Solver の Iteration 数。1 以上の整数 |
| `REVIEW_TIMEOUT_MS` | `120000`（暫定値） | Review AI（Claude）の 1 回の呼び出しを待つ上限。超えたらその Review の生成を失敗にする（Hand は止めない）。1 以上の整数。不正値は既定に戻す |
| `REVIEW_PROVIDER` | `claude` | Review AI の実装。`fake` は **E2E 用**の固定応答（Claude を呼ばない）で、普段は設定しない。それ以外の値は起動時にエラーで止める |
| `FAKE_REVIEW_ASSESSMENT` | `reasonable` | **E2E 用**。`REVIEW_PROVIDER=fake` のときの Pass A の段階評価。段階評価の値（`apps/server/src/review/types.ts` の `ASSESSMENTS`）以外は起動時にエラーで止める |
| `POKER_SEED` | 未設定 | **E2E 用**。設定すると Hand ごとの山札の seed を固定の並び（値, +1, …）にする。未設定なら毎回乱数。0〜4294967295 の整数以外は起動時にエラーで止める |

暫定値（OI-001 など）は永久仕様ではありません（[`11_OPEN_ITEMS.md`](../11_OPEN_ITEMS.md)）。

## 4. Claude の認証

Hand Review を作るときと、CPU を Claude に切り替えるときに必要です。既定の CPU は RuleBot なので、遊ぶだけならこの手順は不要です。Claude の呼び出しは、API キーではなく **Claude Code の OAuth 認証（サブスクリプション枠）** を Claude Agent SDK 経由で使います（D87。D84 を変更。設計は [`03_SYSTEM_ARCHITECTURE.md`](../03_SYSTEM_ARCHITECTURE.md) §3）。

1. **ログイン**: ターミナルで `claude` を起動し、`/login` でサブスクリプションのアカウントにログインします。
2. **動作確認**: `claude -p "OK とだけ返して"` が応答すれば、ログインできています。
3. **`ANTHROPIC_API_KEY` が無いことの確認**: server を起動するシェルで `[ -z "${ANTHROPIC_API_KEY:-}" ] && echo "未設定（OK）" || echo "設定あり（unset してください）"` を実行します。環境に `ANTHROPIC_API_KEY` があると、Agent SDK はそちらを優先し、サブスク枠ではなく **API 課金** になります（server は Claude を呼ぶ子プロセスの環境から外しますが、シェル側にも置かないでください）。
4. **CPU を Claude に切り替える**: server を起動するシェルで `OPPONENT_PROVIDER=claude` を設定して起動します（例: `OPPONENT_PROVIDER=claude pnpm dev`）。モデルは `opponent_fast` Role（暫定値 `claude-haiku-4-5`）です。起動ログに `"provider":"claude"` が出れば切り替わっています。CPU ごとの Persona は `CPU_PERSONAS` で選べます（例: `OPPONENT_PROVIDER=claude CPU_PERSONAS=maniac,calling_station TABLE_SIZE=3 pnpm dev`）。
5. **Hand Review**: 終わった Hand の Review（Pass A・Pass B・Follow-up）は、`OPPONENT_PROVIDER` に関わらず Claude（`review_standard` Role。暫定値 `claude-sonnet-5-5`、「詳しく」は `review_deep`・`claude-opus-5-5`）で作ります。同じログインと利用枠を使います。

モデル名は Domain Logic に書かず、`apps/server/src/config.ts` の role-based config で解決します（OI-001 の暫定値）。

守ること:

- 資格情報は Claude Code が `~/.claude/` に持つものを使います。リポジトリ・`.env`・`apps/web`（ブラウザ）へ置かない・コピーしない・渡しません。Claude を呼ぶのはローカルの `apps/server` だけです（`claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` は使いません）。
- 本人のログインを本人がローカルで使う前提です。第三者が自分の製品で claude.ai ログインを提供することは公式に認められていないので、配布・共有はしないでください。
- サブスクの利用枠は、開発で使う Claude Code と**共有**です。CPU の判断を Claude にすると、そのぶん開発側の枠も減ります。
- ログイン切れ・利用枠の上限に達すると、Review の生成は失敗の理由を出し、もう一度作れます（Hand は止まりません）。CPU を Claude にしているときは CPU の判断が失敗し、障害として Hand が止まり、卓の中央に続け方を選ぶダイアログが出ます（Retry / Emergency Bot で続行 / Session を終了）。ログイン切れなら `claude` で `/login` し直してから Retry、上限なら枠が戻るまで待って Retry、すぐ続けたいときは Emergency Bot（その CPU を Session の終わりまで RuleBot で動かす）を選びます。
- **CPU の 1 手に数秒〜十数秒かかります**（子プロセスの起動を含む。実測は [`issue-53-opponent-eval.md`](../taskLog/issue-53-opponent-eval.md)）。待ちが長いと卓に「AI応答が遅延しています」が出ます。判断待ちの上限は `OPPONENT_TIMEOUT_MS` です。
- CI・`pnpm test`・`pnpm e2e` は Claude を呼びません（Fake と録画済み・固定の応答だけ）。

## 5. Solver の導入（任意）

Hand Review の Solver Evidence には、ローカルの Solver **amaster97/poker_solver**（MIT）を使います（D96。設計は [`03_SYSTEM_ARCHITECTURE.md`](../03_SYSTEM_ARCHITECTURE.md) §8）。解けるのは **Heads-Up の Turn と River** だけで、それ以外の Spot は Math・Range・KB に切り替えます（Unsupported は正常な動きです）。導入しなくてもアプリは動きます。

前提: `git`・`python3`（venv が使えること）・Rust の stable（[rustup](https://rustup.rs/)）。WSL2（Ubuntu 24.04）で確認しています。Windows ネイティブは未確認です。

1. **取得とビルド**: `bash apps/server/solver/setup-amaster97.sh` を実行します。固定した commit（`f78f1b2`）を clone し、venv に Rust 拡張ごとインストールして、導入先に `install.json`（commit・版）を書きます。既定の導入先はリポジトリの外の `~/.local/share/proj-poker/amaster97-poker-solver` で、`POKER_SOLVER_HOME` を付けて実行すると場所を変えられます（リポジトリの中は拒否します。Solver のソース・成果物はコミットしません）。
2. **server に場所を渡す**: server を起動するシェルで `POKER_SOLVER_HOME=<導入先>` を設定します（例: `POKER_SOLVER_HOME=~/.local/share/proj-poker/amaster97-poker-solver pnpm dev`）。
3. **動作確認**: `POKER_SOLVER_HOME=<導入先> pnpm --filter @proj-poker/server smoke:solver` で、固定 Spot の River と Turn を実際に解き、Root の行動頻度・所要時間・版を表示します（River 約 1 秒・Turn 約 8 秒。Flop と Multiway は Unsupported と表示されます）。最後に Timeout と Cancel で止めてプロセスが残らないことも確かめます。

- Solver は CPU とメモリを使います（Turn で約 430 MiB）。同時に動かすのは既定で 1 つで、`SOLVER_TIMEOUT_MS` を超えたら止めて Fallback します。
- Solver の結果は Root（Street の最初の判断・OOP）の行動頻度です。Action EV は今の呼び出し方では取れないので出しません（「取れない」と明示します）。
- CI と `pnpm test` は実 Solver を呼びません（偽の Solver と録画だけ）。

## 6. 開発コマンド

リポジトリのルートで実行します。CI（`.github/workflows/ci.yml`）の `check` ジョブは `pnpm install --frozen-lockfile` の後に次の表の最初の 4 つ（lint・typecheck・test・format:check）を実行し、E2E は別のジョブ `e2e` で動きます。pre-commit hook は無い（D69）ので、push 前にこの 4 つを手で通します。

| コマンド | 内容 |
|---|---|
| `pnpm lint` | ESLint |
| `pnpm typecheck` | 全パッケージの `tsc --noEmit` |
| `pnpm test` | Vitest（`packages/engine`・`apps/server`・`apps/web`） |
| `pnpm format:check` | Prettier の整形チェック（適用は `pnpm format`。対象外は `.prettierignore`） |
| `pnpm e2e` | Critical E2E（Playwright。[§7](#7-e2e-の実行)） |
| `pnpm build` | 全パッケージの build |

開発の流れ（Issue → worktree → PR → レビュー）は [`CLAUDE.md`](../../CLAUDE.md) と `.claude/skills/github-workflow/SKILL.md`、テストの方針は [`09_TEST_STRATEGY.md`](../09_TEST_STRATEGY.md) にあります。

## 7. E2E の実行

```bash
# 初回だけ: Playwright の Chromium（headless shell）を取得する。OS の依存パッケージも入れるなら --with-deps（sudo が要る）
pnpm --filter @proj-poker/e2e exec playwright install --only-shell chromium
pnpm e2e
```

`e2e/tests/` の spec（各 spec が確かめる内容と Definition of Done との対応は [`09_TEST_STRATEGY.md`](../09_TEST_STRATEGY.md) §8・§11・§12 が一次情報）:

| spec | 内容 |
|---|---|
| `session.spec.ts` | 6-max の Session: 開始 → Chip 操作と宣言で Play → Review（Pass A → Pass B → Follow-up）→ Replay（Important Spot へ）→ 次の Hand → server を再起動して Resume |
| `learning.spec.ts` | Phase 6 の学習の流れ: Session の終わりまで Play → Review → Session Review → Player Profile → Targeted Drill → Learning Reset → 再起動後も学習の記録と provenance が同じ |
| `opponent-memory.spec.ts` | Phase 7 の CPU の Memory: Fixed CPU と Guest の卓で複数 Session → Memory の持ち越し・Guest の破棄・Private Memory の分離・Tilt の Reset・Opponent Memory Reset。Hidden の値は一時 DB を読み取り専用で開いて確かめる |
| `review-tendency.spec.ts` | Review の根拠の欄の卓の傾向（#169）: 無いときの表示・十分なときの値が API の Evidence と同じ・Hidden の層が出ない・狭い画面で崩れない |
| `tournament.spec.ts` | Phase 8 の 6-max STT: 開始 → Blind / Ante → 再起動して Resume → Elimination → Heads-Up → 終了 → Payout / Result → ICM の Review → Replay → 新しい Tournament（20 秒ほど） |
| `session-end-layout.spec.ts` | Session の終わりの Button が 1280×720 でも Hero の席に覆われない（#158） |
| `table-layout.spec.ts` | 720×600・1024×768・1280×720・375×667・320×568 で、Hand の途中・終わり・Session の終わり・裁定（RULING）表示時に操作できなくなる重なりが無い（#163・#179） |

- server（`127.0.0.1:3101`）と web（`127.0.0.1:5174`）を E2E が自分で起動・停止します（`e2e/support/server.ts`・`e2e/playwright.config.ts`）。`pnpm dev`（3001 / 5173）と同時に動かせます。
- 決定論にするため、server は `POKER_SEED`・CPU は RuleBot・`REVIEW_PROVIDER=fake`・空の一時 DB で動きます。Claude と Solver は呼びません。spec ごとの seed・`TABLE_SIZE`・`FAKE_REVIEW_ASSESSMENT`・画面の大きさの指定は各 spec の冒頭のコメントと `09_TEST_STRATEGY.md` §8 にあります。
- `pnpm e2e` は `NODE_OPTIONS=--conditions=@proj-poker/source` で Playwright を動かし、`apps/server` の Projection の関数と Engine を build せずに `src` から読みます。
- 失敗したら `e2e/test-results/` に Trace・スクリーンショット・server のログが残ります（`pnpm --filter @proj-poker/e2e exec playwright show-trace <trace.zip>` で開けます）。
- Tournament の E2E の経路は seed・RuleBot・再起動の位置で決まります。RuleBot・Engine の変更で Hero が Heads-Up の前に Bust するようになったら、前提の assert で落ちるので、再起動の位置か seed を選び直します（`09_TEST_STRATEGY.md` §8）。
- 実際の Claude（OAuth）での通しは手動で行います（結果の例は [`issue-85-e2e-readme.md`](../taskLog/issue-85-e2e-readme.md)）。

## 8. 手動の Smoke / Eval / 計測

実際の Claude（OAuth・サブスク枠）か実 Solver を呼ぶもの、または時間のかかる計測で、CI と `pnpm test` では動かしません。すべて `pnpm --filter @proj-poker/server <script>` で実行します（script の一次情報は `apps/server/package.json`）。Claude を呼ぶものは利用枠を使い、1 回あたり数分以上かかることがあります。指標・合格ライン・録画の扱い・上限は [`09_TEST_STRATEGY.md`](../09_TEST_STRATEGY.md) の該当節が一次情報です。

| script | 内容 | 呼ぶもの | 詳細 |
|---|---|---|---|
| `smoke:claude` | Claude の CPU で Hand を進め、判断ごとの Latency と Valid を集計 | Claude | `src/testing/claude-smoke.ts` の冒頭 |
| `smoke:solver` | 固定 Spot を実 Solver で解く（[§5](#5-solver-の導入任意)） | Solver | `09` §7 |
| `smoke:reveal` | Pass A → Pass B → Follow-up を固定 Hand で作る | Claude | `src/testing/reveal-smoke.ts` の冒頭 |
| `eval:opponent` | 代表 Spot × 6 Persona の CPU の判断の Eval | Claude | `09` §5 |
| `eval:opponent-memory` | Opponent Memory の Eval の分布と計算時間の表示（RuleBot の決定論） | — | `09` §5 |
| `eval:opponent-memory-prompt` | Memory 付き Prompt の Claude CPU の Eval（録画） | Claude | `09` §5 |
| `eval:opponent-memory-river` | 同じ Eval の River の追加測定 | Claude | `09` §5 |
| `eval:opponent-tournament` | Tournament の Claude CPU の Eval（録画。#202） | Claude | `09` §5 |
| `eval:review` | Review Eval | Claude（`--solver` で Solver も） | `09` §6 |
| `eval:review-tournament` | Tournament の Review Eval（録画。#202） | Claude | `09` §6 |
| `bench:memory` | CPU Memory の都度計算と DB の大きさの計測（実 SQLite の一時 DB） | — | `src/testing/memory-bench.ts` の冒頭・`04` §12 |

`smoke:*`・`eval:*`・`bench:*` の各ファイルは `apps/server/src/testing/` にあります。Claude を呼ぶ Eval は、シェルに API 課金の変数（`ANTHROPIC_API_KEY` 等）が無いことを前提にします（[§4](#4-claude-の認証)）。
