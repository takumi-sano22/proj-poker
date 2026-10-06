# Issue #81: Solver Adapter（amaster97・HU River / Turn）を作る

## 概要

Phase 5 の子 Issue。Primary Solver（amaster97/poker_solver。D96）を包む Solver Adapter を `apps/server/src/solver/` に作った。Capability は #76 の PoC で動いた HU の Turn / River だけを宣言し、Flop・Multiway・Rake・Tournament・Solver 未導入は Unsupported（正常系）として理由と Fallback 先を返す。Solver のソース・成果物はリポジトリに入れず、固定 commit を clone してビルドするスクリプトと、場所を指す環境変数（`POKER_SOLVER_HOME`）を用意した。Event・スキーマ・DB・依存（package）は変えていない。

## 初期調査

- 前提（main 608a621）: #79 の Range Model（`villainRange` が `{ assumption, combos }` を返す）・`parseRange`、#80 の KB がある。Review（#82）はまだ無い。
- 根拠: docs/03 §8（interface・Unsupported は正常系・HU を Multiway の Exact GTO にしない）、docs/09 §7（テスト項目）、docs/05 §10、docs/research/05 §2（Capability Envelope）/ §4（Multiway の扱い）/ §5（Normalized Request / Result）、#76 の PoC コメント 2 件、D96、OI-009。
- PoC の要点: amaster97 は Python ライブラリ（Rust 拡張）。Node から子プロセスで呼べ、AbortSignal + SIGKILL で止められた。Board の重複・Board と衝突する手を Solver は弾かない。Action EV はこの呼び出し経路では取れない。exploitability の計算は Turn で約 520 s。
- amaster97 の `solve_range_vs_range_nash` を読んだ: Range は Hand Class の列か `Range` オブジェクトを受ける。`Range` に具体的な Combo を入れると、Class に展開した Combo のうち入れていない Combo の重みが 0 になり（`Range.weight` は無い Combo で 0.0）、Root の集計（`range_aggregate`）も入れた Combo の重みで取る。公開 API のままで具体的な Combo を渡せる。
- Bet ラベルは `bet_<round(割合×100)>`、Raise は `raise_<倍率>x`、固定の `check` / `call` / `fold` / `all_in`。Bet Size と Raise 倍率は各 5 種まで（`HUNLConfig` の検証）。

## 設計方針

- **置き場所**: 子プロセスを使うので Engine（純粋 TS）ではなく `apps/server/src/solver/`。Python の runner と導入スクリプトは `apps/server/solver/`（KB の `apps/server/kb/` と同じく TS の外の資産）。
- **導入**: `apps/server/solver/setup-amaster97.sh` が固定 commit（`f78f1b2b…`。#76 で計測した版）を `POKER_SOLVER_HOME`（既定はリポジトリ外の `~/.local/share/proj-poker/amaster97-poker-solver`）へ clone し、venv に `pip install` して、`install.json`（solver・repository・commit・version・python）を書く。導入先がリポジトリ（worktree と本体）の中なら拒否する。Adapter は起動時に `install.json` と Python の有無を確かめ、無ければ `solver_not_installed`。
- **supports の順序**: Player 数 → Street → Mode → Rake → Bet Tree → 導入の有無。Multiway の Spot で「未導入」より「HU だけ」を先に出す（理由として情報が多い）。Bet Tree は Solver が表せる範囲（Bet Size 1〜5 種で % が重ならない・Raise 倍率 1〜5 種・攻撃 4 回まで〔計測した値〕）。
- **Invalid Input は Unsupported と分ける**（implementation-guidance async・docs/09 §7）: `supports` は Capability だけを見て、値の正しさは `analyze` が `validateSpot` で確かめて `SolverError("invalid_input")` にする。Solver は一度も起動しない。
- **失敗は `SolverError` の code**（`unsupported` / `invalid_input` / `timeout` / `cancelled` / `process_failed` / `parse_failure`）。Timeout・Cancel は途中結果が無いので「結果なし」で、呼び出し側は Unsupported と同じく Fallback する。
- **子プロセス**（`process.ts`）: Timeout と AbortSignal で SIGKILL し、`close`（プロセスの回収）を待ってから返す。stdout / stderr は 4 MiB を上限にし、超えたら止める。SIGTERM での穏当な停止は #76 で未検証なので使わない。
- **同時実行数**: Adapter 内の Limiter（既定 1）。待っている間も Cancel が効き、待ち行列から外す。Timeout は枠を取ってからの Solve の時間に掛ける（待ち時間で Timeout しない）。
- **額の倍率**: amaster97 は額を整数で扱うため、Chip（BB = 2）のままだと 50% pot の額が粗くなる。Chip × 100 で渡す（Root の戦略は Pot に対する比で決まる）。
- **Range**: Solver には具体的な Combo の文字列（`AsKd`）で渡し、Hand Class に丸めない。#79 の Range Model の結果は `rangeFromModel`、表記からは `rangeFromNotation`（Board と衝突する Combo を除く）で作り、どちらも Assumption を持つ。Evidence の `rangeAssumptions` にそのまま残す。
- **出力の検証**: JSON として読めても、protocol・root_actor・行動のラベル（Root にあり得る `check` / Bet Tree にある `bet_N` / `all_in` だけ）・頻度（0〜1・合計 1 ± 1e-3）・Hand Class ごとの行動が想定と違えば `parse_failure`（「読めた = 正しい」にしない）。
- **Evidence**: Root（Street の最初の判断・OOP）の Range 全体と Hand Class ごとの行動頻度、Version Metadata（runner が返す版・`install.json` の commit・固定 commit との一致。違えば warnings）、Bet Tree、Iteration、Range Assumption、前提（HU の結果で Multiway の Exact GTO ではない・Bet Tree の抽象化・Rake なし・Root だけ・Range は推定・呼び出し側の前提）。Action EV は `ev: { available: false, reason }`、exploitability は `null`（計算しない）。
- **Config**（`config.ts`）: `POKER_SOLVER_HOME`（`resolveSolverHome`）、`SOLVER_TIMEOUT_MS`（既定 20000。暫定値）、`SOLVER_MAX_CONCURRENCY`（既定 1）、`SOLVER_ITERATIONS`（既定 200。暫定値）。Timeout は #76 の Turn（5.7〜8.0 s）の最大の約 2.5 倍（今回の実測 8.5 s に対しても約 2.3 倍）。
- Server の起動・Route には繋いでいない（使うのは #82 の Review）。入口は `createSolverAdapterFromEnv`。

## 変更内容

- `apps/server/solver/setup-amaster97.sh`（新規）: 固定 commit の取得・ビルド・`install.json`。
- `apps/server/solver/amaster97_runner.py`（新規）: stdin の JSON で 1 Spot を解き、Root の戦略を stdout に 1 行の JSON で出す。失敗は exit 1 と stderr。exploitability は計算しない。
- `apps/server/src/solver/types.ts`（新規）: `SolverCapability`・`AnalysisSpot`・`SupportResult`・`SolveOptions`・`SolverEvidence`・`SolverError`・`SolverAdapter`。
- `apps/server/src/solver/spot.ts`（新規）: `validateSpot`・`rangeFromModel`・`rangeFromNotation`。
- `apps/server/src/solver/process.ts`（新規）: `runProcess`（Timeout / Cancel → SIGKILL・出力の上限）。
- `apps/server/src/solver/amaster97-adapter.ts`（新規）: `createAmaster97Adapter`・`detectAmaster97Install`・Capability・既定の Bet Tree・出力の検証と正規化・Limiter。
- `apps/server/src/solver/index.ts`（新規）: 入口と `createSolverAdapterFromEnv`。
- `apps/server/src/solver/testing/`（新規）: `fixed-spots.ts`（#76 の River / Turn / Flop の固定 Spot）、`fake-solver.ts`（偽の Solver）、`amaster97-river.recorded.json`（実 Solver の River の出力の録画）。
- `apps/server/src/solver/amaster97-adapter.test.ts`（新規）: docs/09 §7 の各項目。
- `apps/server/src/testing/solver-smoke.ts`（新規）と `package.json` の `smoke:solver`: 実 Solver の手動確認。
- `apps/server/src/config.ts` / `config.test.ts`: Solver の設定と、その読み取りのテスト。
- `apps/server/tsconfig.build.json`: `src/**/testing/**` を build から外す（`src/solver/testing/` を dist に出さない）。
- `README.md`: 環境変数 4 つと「Solver の導入（任意）」。
- `docs/03` §8（Solver Adapter の実装）・`docs/09` §7（テストの実装）。

## 判断理由

- Root の集計の重みが PoC の値（Check 0.8717）と違う（今回 0.8806）。Hand Class ごとの戦略は PoC と完全に一致した（Class 入力と Combo 入力で最大差 0.0）。違いは集計の重みだけで、PoC は Class の正規の Combo 数（Board との衝突を数えない）、今回は Board と衝突しない実際の Combo 数で重み付けしている。TexasSolver / noambrown の集計（PoC）も実際の Combo の等重みなので、今回の重みの方が同じ条件の比較になる。
- per_class（Hand Class ごと）も Evidence に入れたのは、Review が Hero の手の Class の頻度を引けるようにするため（169 件以下で小さい）。Combo ごとの戦略は入れていない（出力が大きい・今は使い手が無い）。
- Root 以外の Node（IP の判断・Bet に直面した判断）は出さない。#76 の PoC の写像案も Root が中心で、必要になったら Review（#82）で足す。
- Flop は動くが 13 分・16.9 GB（#76）なので D96 どおり宣言しない。

## 実行した確認

- 品質チェック（worktree のルート）: `pnpm lint`（エラーなし）・`pnpm typecheck`（3 パッケージ Done）・`pnpm test`（engine 326 / web 109 / server 289 passed）・`pnpm format:check`（All matched files use Prettier code style!）。`pnpm -r build` も通った。
- 導入スクリプト: `POKER_SOLVER_HOME=<scratchpad>/solver-home bash apps/server/solver/setup-amaster97.sh` → `導入した: amaster97/poker_solver 1.11.0 (f78f1b2bc338dd8cbb5226ecb8398bbdb3635676)`。clone 済みの状態での再実行も exit 0。導入先をリポジトリの中（本体・worktree）にすると `POKER_SOLVER_HOME はリポジトリの外に置く` で exit 1、ディレクトリは作られない。
- **実 Solver での手動確認**（WSL2・Ubuntu 24.04・Ryzen 5 7500F、`POKER_SOLVER_HOME=… pnpm --filter @proj-poker/server smoke:solver`、200 Iteration）:

  | Spot | 結果 | wall | Root（OOP）の頻度 | その他 |
  |---|---|---|---|---|
  | River（Ks 7d 2c 4h 9s・Pot 48 / Stack 64 Chip） | supported・成功 | 873〜937 ms | check 0.8806 / bet_50 0.1194 / all_in 0.0000 | decision node 8・Combo 207 / 152（#76 と同じ）・pinnedCommit true・warnings なし |
  | Turn（Ks 7d 2c 4h・Pot 24 / Stack 88 Chip） | supported・成功 | 8524〜8546 ms | check 0.9986 / bet_50 0.0014 / all_in 0.0000 | decision node 1596・Combo 216 / 157（#76 と同じ） |
  | Flop | Unsupported（`street`） | — | — | — |
  | River を 3 人に | Unsupported（`player_count`） | — | — | detail に Exact GTO として扱わない旨 |
  | Turn を Timeout 2 s | `timeout` | 2037 ms | — | 止めた後に runner のプロセスなし（pgrep） |
  | Turn を 1 s 後に Cancel | `cancelled` | 1030 ms | — | 止めた後に runner のプロセスなし（pgrep） |
  | `POKER_SOLVER_HOME` 未設定 | River / Turn とも Unsupported（`solver_not_installed`） | — | — | — |

- **noambrown との照合（River・手動）**: #76 の PoC で作った noambrown の River の出力（同じ固定 Spot・200 Iteration）と比べた。Root の Range 集計は Check 0.8639（noambrown）に対し 0.8806（Adapter）で差 1.7 pt。Hand Class ごとの Check 頻度の差は平均 0.067・最大 0.697（44 Class）。#76 の Combo 単位の NB–AM の差（平均 0.067・最大 0.72）と同じ水準で、混合戦略の均衡が一意でないことと、amaster97 の 200 Iteration での収束の差（PoC で exploitability が他より高い）によると考えられる（未検証）。
- 照合の途中で、pgrep のパターンが自分のシェルのコマンド行に当たって「プロセスが残っている」と誤検出した。パターンを runner の Python の起動行（`^\S*python\S* \S*amaster97_runner\.py$`）に絞って解消した。

## 残課題

- Review（#82）から `supports` → `analyze` を呼び、Unsupported・失敗のときに Math + Range + KB へ Fallback して Assumption を表示する（この Issue は Adapter まで）。途中まで Multiway だった Spot を HU として渡すときの前提（Prior Action・Range 推定・Card Removal・Bunching）は、呼び出し側が `assumptions` に入れる。
- Action EV の取得方法（amaster97 の best-response 等）は未検証のまま（#76 の未検証事項）。
- Root 以外の Node（IP の判断・Bet に直面した判断）が必要なら、runner に Node の指定を足す。
- SIGTERM による穏当な停止・停止時の部分結果は未検証（SIGKILL のみ）。
- Windows ネイティブは未確認（WSL2 のみ）。
- Solver の commit を上げるときは、`AMASTER97_PINNED_COMMIT` とスクリプトの `COMMIT`・録画（`amaster97-river.recorded.json`）・手動確認をまとめて更新する。
