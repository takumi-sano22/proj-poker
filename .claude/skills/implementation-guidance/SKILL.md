---
name: implementation-guidance
description: コードを書く前に読む判定基準への導線。触るパスから領域（poker-engine / ai-boundary / db / async / ui / llm / docs-harness）を判定し、該当する reference だけを読ませる。レビュー時の学習台帳（code-review）とは別資産で、こちらは「書く前に知っていれば防げる」側。github-workflow の実装 phase の入口と、impl / issue-worker への委譲 briefing で使う。「実装前に読むものある?」「この領域の判定基準を教えて」でトリガーする。レビュー工程では使わない（→ code-review）。
---

# implementation-guidance（書く前に読む判定基準への導線）

**本 skill 自身は規範を持たない。** 持つのは「触る領域からどの reference を読むか」だけで、判定基準は `references/<領域>.md` に、規範の一次情報はさらにその先（`CLAUDE.md`・`docs/03_SYSTEM_ARCHITECTURE.md`（データは `docs/04_DATA_AND_EVENTS.md`）・各 skill）にある。

> **注記**: `references/` は proj-poker（ローカル単一ユーザーの NLHE 練習 + AI コーチング。クラウド・認証・3D は非採用）向けに構成している。実装前のため lint / test 等のコマンドは Phase 0 確定後に追記する。判定基準は `review-distillation` skill で育てる。

**なぜ `code-review` の台帳と分けるか**: 台帳は差分をレビューするときに読む資産で、コードを書くときには読まれない。同じ欠陥が「書かれてからレビューで捕まる」往復になり、レビュー 1 往復ぶんのコストを毎回払う。書く前に判定できるものはこちらへ置く。

## 適用範囲

- **発火条件**: 実装に入る前（`github-workflow` の実装 phase 着手時）。実装を subagent（`impl` / `issue-worker`）へ委譲する場合は、**親が該当 reference の絶対パスを briefing へ書く**（`subagent-briefing` skill）。
- **非適用条件**: 差分のレビュー（→ `code-review`）／読み取りのみの調査／文書だけの軽微な修正。
- **入力**: これから触るパス（分かっている範囲でよい）。
- **編集可能範囲**: **なし**。`references/**` を書き換えてよいのは `review-distillation` skill だけ。実装中に気づいた観点を直接足さない（「複数 PR で再発するか」の判定を飛ばして資産が太る。候補は `review-learning` で PR コメントへ残す）。
- **出力**: 読んだ reference の一覧（または「該当 reference なし」）。判定できなければ全 reference を読む（fail-closed）。

## 手順

### 1. 触るパスから領域を判定する

| 領域（差分クラス） | reference |
|---|---|
| `poker-engine` / `persistence-event-log` | [references/poker-engine.md](references/poker-engine.md)（`persistence-event-log` は加えて `db.md`） |
| `knowledge-state` / `ai-opponent` / `review-pipeline` | [references/ai-boundary.md](references/ai-boundary.md)（`ai-opponent` / `review-pipeline` は加えて `llm.md`） |
| `db` | [references/db.md](references/db.md) |
| `async` | [references/async.md](references/async.md) |
| `ui-table` | [references/ui.md](references/ui.md) |
| `llm` | [references/llm.md](references/llm.md) |
| `docs` / `harness` | [references/docs-harness.md](references/docs-harness.md) |

**パス → 領域の対応表は `code-review/SKILL.md`「差分クラス」だけが持つ**（ここへ写さない。分類器を 2 つ持つと片方だけ更新されて静かに食い違う）。

### 2. 該当する reference だけを読む

全 reference を毎回読まない。読む量を領域相応にすることが、台帳から分けた理由そのもの。reference が要求する確認動作を実装に反映し、一次情報へのリンクは必要なときだけ辿る。

### 3. 委譲する場合は reference のパスを渡す

`impl` / `issue-worker` へ委譲するなら、briefing の「対象」へ reference の**絶対パス**を書く（子は本 skill を自動では読まない）。渡すのはパスだけで、内容を prompt へ貼らない。

## reference の規約（`review-distillation` が守る）

- **1 skill + 領域別 reference**。領域ごとに skill を増やさない。
- reference が持ってよいのは ①**一次情報の所在**（リンク）②**実装時に自分で行う判定・確認動作** の 2 つだけ。規範そのものを書き写さない（同じ規則が 2 箇所に生まれて片方が古くなる）。
- 各 reference の冒頭で「本書が一次情報である範囲」「一次情報が別にある範囲」を宣言する。
- `code-review` の台帳と同じ項目を両方へ置かない。どちらへ置くか・台帳から外してよい条件は `review-distillation` skill が一次情報。
- 予算の目安は 1 reference あたり `wc -m` で 4,000 字。超えたら圧縮か分割。

## 他 skill との連携

| skill | 接続 |
|---|---|
| `github-workflow` | 実装 phase の入口。委譲する場合は briefing へ reference のパスを渡す |
| `subagent-briefing` | 子へ渡す入力の作り方（パスだけを渡し、内容は貼らない） |
| `review-distillation` | **唯一の書き手**。IMPLEMENTATION_GUIDANCE と判定した候補をここへ落とす |
| `code-review` | 対になる資産（レビュー時に読む台帳）。同じ項目を両方へ置かない |
| `poker-engine-testing` / `poker-invariant-review` | ドメイン不変条件のテスト・レビュー手順の一次情報。reference はそこへの導線と確認動作だけを持つ |
| `decision-log` | `docs/decision_log.yaml` の D 番号の記録・追記手順 |
