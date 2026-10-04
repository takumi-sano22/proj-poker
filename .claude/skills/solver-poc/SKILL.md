---
name: solver-poc
description: proj-poker の Primary Solver 選定 PoC（docs/11_OPEN_ITEMS.md OI-002）の手順 skill。Solver 候補の比較表、固定 Spot での Latency / Memory 実測、SolverAdapter（capabilities / supports / analyze）への写像、Unsupported Spot の扱いを定める。「Solver を選定」「Solver PoC」「TexasSolver を試す」「Solver 比較」「OI-002」「SolverAdapter を実装」「Multiway は対応する？」で起動する。
---

# solver-poc — Primary Solver 選定 PoC（OI-002）

MVP では実 Solver 統合が必須（`docs/11` OI-002、`docs/03` §8）。本 skill は**永久選定の前に行う PoC の手順**を定める。判定基準の正本は `docs/research/05_solver_and_analysis.md` §8（PoC Acceptance Criteria 12 項目）で、ここには写さず、実施方法と記録様式だけを持つ。

## 大原則

- **Multiway の対応可否を推測で決めない**（OI-002）。supported の根拠は PoC の実測だけ。
- **結論は「推奨」として PR / Issue に記録する。確定ではない。** Primary Solver の永久選定は人間判断。**人間が判断した後に** `decision-log` skill の手順で D 番号に記録する（人間の判断前に AI が `decision_log.yaml` へ追記したり、OI-002 を閉じたりしない）。
- **PoC コードは使い捨て**。本体（`src/` 等）に混ぜない。置き場は未確定（docs に規定なし）。決めるまでは本体と分離した別ブランチ / 別ディレクトリに置く。**固定 Spot の入力・計測条件・生ログは、人間が判断する根拠なので消えない場所（PoC の PR / Issue のコメント、またはリポジトリ内の記録）に残す**（セッションの一時領域には置かない）。本体へ取り込むのは選定確定後で、Adapter として別 PR で書き直す。
- 実装開始ゲート（`CLAUDE.md`「自走ルール」）が未解除の間は PoC のコード実装に入らない。Phase 5 の Solver Adapter 実装は本 PoC の人間確定後。
- Adapter の外から見えるのは常に `docs/03` §8 の interface だけにする（Solver 固有の入出力を Review AI へ直接渡さない・`research/05` §5）。

## 候補

`docs/research/05_solver_and_analysis.md` §3 の記載に従う（ライセンス・位置づけの正本はそちら。初期 PoC 第一候補・比較候補・Validation 用途の区分もそこにある）。

| 候補 | docs 上の位置づけ（節番号で参照） |
|---|---|
| amaster97/poker_solver | research/05 §3。MIT License の HUNL Solver。初期 PoC 第一候補 |
| TexasSolver | research/05 §3。比較 PoC 候補。AGPL のため Integration / Redistribution 条件の確認が必要 |
| noambrown/poker_solver | research/05 §3。Primary ではなく Validation / Reference 用途の候補 |

- **docs にない候補名を発明しない。** 追加で調べた候補は、表に**出典 URL と調査日**を併記してから載せる（調査日は実際に確認した日付）。出典のない候補は載せない。
- ライセンスの法的解釈（AGPL を Local 利用でどう扱うか等）は AI が結論を出さない。事実（ライセンス名・条文リンク）を記録し、判断は人間へ。

## 比較表テンプレート

PoC の PR / Issue コメントに、候補ごとに下表を埋める。**未実測の欄は「未実測」と書く**（推測で埋めない）。

| 観点 | 記録内容 |
|---|---|
| License | 名称・出典 URL・確認日・Integration 上の制約（事実のみ） |
| Supported Spot | HU / Multiway、Street（Flop / Turn / River）、Bet size 抽象の粒度、実測で動いた範囲 |
| Latency | Spot ごとの実測値（計測条件とセット） |
| Memory | Spot ごとのピーク（計測条件とセット） |
| Invocation | CLI / ライブラリ / Subprocess。TypeScript Backend から呼べたか（`research/05` §8-2） |
| Output 形式 | Parse 可能か、Strategy Frequency・Action EV が取れるか（§8-3） |
| Version Metadata | バージョン・commit hash の取得方法（`docs/09` §7 の Version Metadata テスト対象） |
| Timeout / Cancel / Invalid Input | 実際に試した結果（§8-9, 10） |
| 実行環境 | WSL / Windows のどちらで動いたか（§8-1） |
| Regression Tolerance | 同じ入力で再実行したときの出力のばらつきと、回帰テストで許容する幅（§8-12） |

> 比較表は `research/05` §8 の Acceptance Criteria 12 項目をすべて覆うこと。上表に無い項目があれば行を足す（判定基準の正本はそちら）。

## 実測手順

1. **固定 Spot セットを先に決めて固定する**: `research/05` §8 の Representative River / Turn / Small Flop の 3 種を最低限とし、各 Spot の入力（Range・Stack・Pot・Bet Tree）をファイルとして保存する。**全候補に同じ入力を与える**（候補ごとに Spot を変えない）。
2. **計測条件を記録する**: マシン（CPU・メモリ・OS・WSL か否か）、候補のバージョン / commit、Iteration 数・Exploitability 等の収束条件、Bet size 抽象、実行回数と集計方法（例: 中央値）。条件が違う数値を同じ表で比較しない。
3. 各 Spot で Latency と Memory のピークを実測し、生ログ（コマンドと出力）を残す。
4. 異常系を試す: Timeout、Cancellation、不正入力（§8-9, 10）。
5. 結果を比較表にまとめ、**推奨とその根拠・未検証事項・リスク**を書く。推奨は Primary / Validation 用途 / 不採用の区分で書き、確定とは書かない。

## SolverAdapter への写像

`docs/03` §8 の interface（`capabilities()` / `supports()` / `analyze()`）に、実測結果を次のように対応させる。型の正本は `docs/03` §8 と `research/05` §2。

| Adapter | PoC の何から決めるか |
|---|---|
| `capabilities()` | 実測で動いた範囲のみ（playerCounts・streets・modes・rakeSupport・icmSupport・sidePotSupport）。動作未確認の項目は宣言しない |
| `supports(spot)` | `analyze` の前に必ず呼ぶ。Capability と Spot（人数・Street・Bet size・Range 前提）の照合で決め、Unsupported は理由つきで返す |
| `analyze(spot, options)` | Subprocess / ライブラリ呼び出しを包み、Solver 固有出力を正規化した `SolverEvidence`（Version Metadata・Range Assumption を保持）にする |

テストは `docs/09` §7 の項目（Capability Detection・Supported / Unsupported・Timeout・Cancellation・Invalid Input・Parse Failure・Version Metadata・Range Assumption 保持）に対応させる。

## Unsupported の扱い

- Unsupported Spot は**エラーではなく正常系**。`supports()` の `SupportResult` が非対応なら Math + Range Analysis + KB + Review AI へ Fallback し、Review に Assumption を表示する（`research/05` §4、`docs/03` §8）。
- **HU Solver の結果を Multiway の Exact GTO として表示しない。** 途中まで Multiway だった Spot を HU として解く場合は、Prior Action・Range 推定・Card Removal 等の Assumption を表示する。
- Multiway Deep Solver（OI-009）は MVP Blocker ではない。PoC の成否で Multiway 対応を MVP に引き込まない（`phase-planning` の Scope Creep 防止）。

## 完了条件

- 全候補の比較表が埋まり、未実測欄が「未実測」と明示されている。計測条件・固定 Spot 入力・生ログが残っている。
- 結論が「推奨」として PR / Issue に記録され、人間判断（`decision-log`・D 番号）待ちである旨が明記されている。
- PoC コードが本体ディレクトリに混入していない。
