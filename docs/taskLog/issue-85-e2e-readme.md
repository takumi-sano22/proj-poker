# Issue #85: 6-max Session の E2E を作り README を MVP の到達点に更新する

## 概要

Phase 5（MVP）の最終 PR。docs/09 §8 の Critical E2E（6-max Session 開始 → Hand を Play〔Chip 操作・宣言〕→ Hand 終了 → Review〔Pass A の段階評価 → Pass B → Follow-up〕→ Replay〔Important Spot へのジャンプ〕→ 次の Hand → server を再起動して Resume）を Playwright で 1 本のテストにし、CI の別ジョブで回すようにした（D98）。決定論にするため、server に E2E 用の起動オプション（`REVIEW_PROVIDER=fake`・`POKER_SEED`）を足した（本番の既定は変えない）。実際の Claude（OAuth）での通しを手動で 1 回行い、README を MVP の到達点に更新した。Event の形・永続化スキーマは変えていない。

## 初期調査

- 前提（main 9905fec）
  - server の山札の seed は `buildApp` の `nextSeed`（既定は乱数）で差し替えられるが、起動（`index.ts`）からは変えられなかった。Review AI は `ReviewAppOptions.query`（SDK の `query()` と同じ形）で差し替えられる。→ 起動時の環境変数で両方を差し替える口を足せば、E2E を決定論にできる。
  - Review の生成（Pass A / Pass B / Follow-up）は `runStructuredQuery` が SDK の result の `structured_output` を読み、呼び出し側が Schema と根拠の参照（`evidenceIds` が Evidence に実在するか）を検証する。→ 固定応答でも `evidenceIds` をその Evidence の id にしないと検証で落ちる。Schema の `evidenceIds` の enum にその Evidence の id が入っているので、そこから選べばよい。
  - Resume（#77）は、起動時に `latestSessionProjection` から Session を戻し、次の「Hand を始める」で Stack を持ち越した Hand を始める。Session ID は応答に出ないので、E2E では Replay の API の Stack（2 Hand 目の終わりと 3 Hand 目の開始）で確かめる。
  - web の dev の `/api` の proxy 先は 3001 固定だった。→ E2E を手元の `pnpm dev` と同時に動かせるよう、server と同じ `PORT` を読むようにした。
  - Playwright はリポジトリに入っていなかった（UI の実測はリポジトリ外のスクリプトで行っていた）。手元のキャッシュに Playwright 1.63.0 の Chromium（1243）がある。
- 根拠: docs/09 §8、D98（E2E は Playwright・CPU は RuleBot・Review AI は録画済みの応答・実 Claude の通しは手動 1 回）、D62・D95（Resume）、D87（Claude の OAuth）。ガイダンス ui / async / docs-harness。

## 設計方針

- **server（E2E 用の口。既定は変えない）**
  - `REVIEW_PROVIDER`（`claude` 既定 / `fake`）: `fake` で Review AI を `apps/server/src/testing/e2e/fake-review-query.ts` の固定応答に差し替える。呼び出しの種類（Pass A / Pass B / Follow-up）は構造化出力の Schema の項目で見分け、`evidenceIds` は Schema の enum の先頭 2 つを使う。文の先頭に「（E2E 用の固定応答）」を付け、実際の Review と取り違えないようにした。Pass A の段階評価は `reasonable`、theory は Solver の有無に関わらず選べる `general_theory`。生成中の表示を一度通るよう 300ms 待つ（abort されたら待たない）。知らない値は起動時に止める（`OPPONENT_PROVIDER` と同じ作法）。
  - `POKER_SEED`: 設定すると Hand ごとの seed を `値, +1, …`（2^32 で折り返す）にする。不正な値は起動時に止める（黙って乱数に戻すと E2E が不安定になったことに気付けない）。
  - D98 の「録画済みの応答」は、Hand によって Evidence（id）が変わる E2E では引数の指紋で照合する録画（Review Eval の形）が使えないため、検証を通る固定の応答にした。Review Eval の録画の再生は従来どおり `pnpm test` で回る。
- **E2E（`e2e/`・workspace の `@proj-poker/e2e`）**
  - server は再起動を確かめるため Playwright の webServer ではなくテストから子プロセスで起動・停止する（`node --conditions=@proj-poker/source --import tsx src/index.ts`。空の一時 DB・`POKER_SEED`・RuleBot・`REVIEW_PROVIDER=fake`・`BOT_THINK_DELAY_MS=0`。手元の `POKER_SOLVER_HOME`・API キーは持ち込まない）。web は Playwright の webServer で Vite の dev を起動する（3101 / 5174。`pnpm dev` の 3001 / 5173 と重ならない）。
  - Hero の操作: 最初に Call する手番で、Call の額を Chip の額面に分けて手に取り、Betting Area に出して「確定して Dealer に渡す」（宣言なしの Chip 操作）。それ以外の手番は宣言 Button（Call できれば Call、できなければ Check）。操作の後は進行ログの行が増えるまで待ってから次の手番を読む（古い画面で二重に操作しない）。
  - Resume の確認: 2 Hand 目の後に server を止めて同じ DB で起動し直し、画面を読み込み直して「Hand を始める」。3 Hand 目の開始時の各席の Stack が 2 Hand 目の終わりと同じ・200 の均等 Stack に戻っていない・総量 1200 を Replay の API で確かめ、3 Hand 目も最後まで遊ぶ。
  - ブラウザは Chromium の headless shell だけ。テストごとに一時 DB を作り、終わったら server を止めて消す。
- **CI**: `check` とは別の `e2e` ジョブ（並行に動くので `check` は遅くならない）。`~/.cache/ms-playwright` を Playwright の版（`e2e/package.json` で厳密に固定）ごとにキャッシュし、`playwright install --with-deps --only-shell chromium` で OS の依存を入れる。失敗したときだけ Trace・スクリーンショット・server のログを artifact に上げる。

## 変更内容

- server
  - `apps/server/src/config.ts`: `parseReviewProvider`（`REVIEW_PROVIDER`）・`parseFixedSeed`（`POKER_SEED`）・`fixedSeedSequence` を足した。
  - `apps/server/src/index.ts`: 上の 2 つを起動時に読み、`fake` なら Review AI の `query` を固定応答に、`POKER_SEED` があれば `nextSeed` を固定の並びにする。どちらも使っているときは起動ログに warn を出す。
  - `apps/server/src/testing/e2e/fake-review-query.ts`（新規）: E2E 用の Review AI。
  - テスト: `config.test.ts`（3 件）・`testing/e2e/fake-review-query.test.ts`（3 件。Pass A / Pass B / Follow-up が本番の生成・検証の関数を通る・知らない Schema は誤り）。
- web: `apps/web/vite.config.ts` の `/api` の proxy 先を `PORT`（既定 3001）にした。
- E2E（新規）: `e2e/package.json`（`@playwright/test` 1.63.0・`@types/node`）・`e2e/tsconfig.json`・`e2e/playwright.config.ts`・`e2e/support/server.ts`・`e2e/tests/session.spec.ts`。`pnpm-workspace.yaml` に `e2e` を足し、ルートに `pnpm e2e` を足した（`pnpm test` には入らない。`pnpm typecheck` と `pnpm lint` には入る）。
- CI: `.github/workflows/ci.yml` に `e2e` ジョブ。
- 無視の設定: `.gitignore`・`.prettierignore`・`eslint.config.mjs` に Playwright の結果（`e2e/test-results`・`e2e/playwright-report`）。
- docs: `docs/03`（ディレクトリ構成に `e2e/`・proxy のポート・E2E 用の起動オプション）、`docs/09` §8（実装）。
- README: MVP（Phase 5）の到達点に更新した（現在の状態・技術構成〔モデルの Role と暫定値・Solver・KB〕・Hand Review の使い方・環境変数〔`REVIEW_PROVIDER`・`POKER_SEED`〕・Claude の認証の前提を Review に合わせた・E2E の実行・Phase 5 でできたこと・制約〔OI の暫定値・Solver は HU の Turn / River だけ・Web Fallback なし〕・次は Phase 6）。

## 実行した確認

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（engine 328・web 117・server 406 件）/ `pnpm format:check`: すべて通過。
  - 途中の 1 回だけ、`packages/engine` の `hand-summary.property.test.ts`（fast-check・seed は実行ごとに変わる）が 1 件失敗した。失敗の出力を残していなかったため反例は不明。直後に単体で 46 回（約 6,900 ケース）、全体（`pnpm test`）でも 2 回流して再現しなかった。この Issue では Engine を触っていない。→ 残課題。
- `pnpm e2e`（ローカル・WSL2）: 通過。1 回 約 11 秒（テスト本体）、`pnpm e2e` 全体で約 10〜12 秒。`--repeat-each=3` と `--repeat-each=2` も通過（不安定さなし）。
- CI（PR の 1 回目・Playwright のキャッシュなし）: `check` 55 秒・`e2e` 56 秒（並行）。`e2e` の内訳は依存の install 3 秒・Playwright の取得と OS の依存 15 秒・`pnpm e2e` 15 秒。
- 実 Solver: `POKER_SOLVER_HOME=<#81 のビルド> pnpm --filter @proj-poker/server smoke:solver` で River 0.95 秒・Turn 7.8 秒、Flop と Multiway は Unsupported、Timeout と Cancel でプロセスが残らないことを確かめた。

### 実際の Claude での通し（手動 1 回・D98）

- 条件: `claude -p` で OAuth のログインを確かめ（`ANTHROPIC_API_KEY` は未設定）、server を `OPPONENT_PROVIDER=claude`（opponent_fast = `claude-haiku-4-5`）・Review は既定の Claude（review_standard = `claude-sonnet-5-5`）・`POKER_SOLVER_HOME`（#81 のビルド）・`POKER_SEED=20261006`・6-max・空の一時 DB で起動し、E2E と同じ筋書きをリポジトリ外の Playwright のスクリプトで通した（Hero の操作も E2E と同じ）。
- 所要時間:

| 段階 | 所要 |
|---|---|
| Hand 1 の Play（Chip 操作で Call を含む。Hero の手番 4 回） | 60.8 秒 |
| Pass A の生成（段階評価「改善の余地あり」） | 11.1 秒（server のログで 13.1 秒） |
| Pass B の生成 | 12.3 秒（同 11.2 秒） |
| Follow-up の答え（Pass B への質問・answered） | 5.1 秒（同 6.1 秒） |
| Replay（Hand 1 は Important Spot が 0 件で、ジャンプは無し） | 0.1 秒 |
| Hand 2 の Play | 105.4 秒 |
| server の再起動 → 画面の読み込み直し → 3 Hand 目の開始 | 0.6 秒 |
| Hand 3 の Play（Resume 後） | 58.9 秒 |

- Hero の手番の間の CPU の待ち（CPU 数人分の合計）は 0〜39.5 秒。AI 障害のダイアログ・CPU の不正な出力（Fallback）は 0 回だった。
- Resume: 2 Hand 目の終わりの Stack（Hero 109・CPU 1 197・CPU 2 106・CPU 3 198・CPU 4 390・CPU 5 200。計 1200）と 3 Hand 目の開始の Stack が全席で一致した（新しい Session にならず持ち越した）。
- Review した判断は Preflop の Call（BTN の 2h4c で HJ の Limp にオーバーコール）。Preflop は Solver の対象外なので、この通しでは Solver Evidence は出ていない（Unsupported の Fallback。実 Solver は上の smoke で確認）。
- 不具合: 動かない箇所は無かった。品質の気付きとして、Pass B と Follow-up の文に内部の識別子（`cpu1` 等の playerId・`inAssumedRange=false` のような Evidence の項目名）がそのまま出た（画面の他の箇所は「CPU 1（SB）」の表示名）。Review の Prompt / Evidence の語の問題で、E2E の範囲外。→ 残課題。

## 判断理由

- 固定応答（録画ではなく）にした理由は「設計方針」のとおり（E2E の Hand では Evidence が変わり、指紋で照合する録画は合わない）。固定応答でも検証・保存・画面は本番と同じ経路を通る。
- seed の固定は、Hero の操作（Call / Check）と RuleBot（seed 付き）の組み合わせで Hand の流れを毎回同じにするため。Important Spot のある Hand・Bust が出ない流れになることを、この seed で確かめた。
- server を webServer にしなかったのは、Resume のためにテストの途中で止めて同じ DB で起動し直す必要があるため。
- `check` を遅くしないよう E2E は別ジョブ。ブラウザは headless shell だけにして取得を小さくした。

## 残課題

- `packages/engine/src/hand-summary.property.test.ts` が 1 回だけ失敗した（反例は記録できず・再現せず）。fast-check の seed 依存の稀な反例の可能性がある。別 Issue で、失敗時の seed を CI のログから拾えるようにする等の調査を推奨。
- Review の文に内部の識別子（playerId・Evidence の項目名）が出ることがある（実 Claude の通しで観測）。Prompt で表示名を使わせる・Evidence に表示名を入れる等の改善は別 Issue を推奨（`llm-quality-improvement`）。
- E2E の固定応答は文の中身を検証しない（段階評価・説明の質は Review Eval〔`docs/09` §6〕の領分）。
