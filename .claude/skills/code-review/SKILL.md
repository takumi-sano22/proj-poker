---
name: code-review
description: proj-poker のコード変更を正確性、読みやすさ、保守性、セキュリティ、テスト観点でレビューするSkill。コミット前やPR前に使う。学習台帳 learned-checks.md の必読・差分クラス別チェックリスト・設計書↔コードの数値整合・ポーカー不変条件（情報境界・Event Log・Chip 保存）を含む。
when_to_use: コミット/PR作成の直前や差分を書き終えて自己レビューする時に自動で使う。特に設計書↔コードの数値整合（定数・しきい値）を含む変更、Poker Engine・KnowledgeState（情報境界）・Review Pipeline・AI Opponent・Event Log 永続化に触れる変更、DB/SQL・非同期処理を含む変更では必ず起動する。reviewer agent へ委譲するときも本 skill の「準備」を親が行う。
---

# コードレビュー

汎用観点（正確性・読みやすさ・保守性・エラーハンドリング・セキュリティ・テスト・余計な変更）に加えて、**そのリポジトリで実際に指摘された欠陥クラスを台帳とチェックリストとして前倒しで当てる**。狙いは第 2 段レビュー（Codex または `reviewer` agent）に出す前に既知のクラスを潰し、9〜20 巡に及んでいたレビュー往復を畳むこと。

> 下記「差分クラス」のパスは D67・D68 の構成（`packages/engine`・`apps/server`・`apps/web`。`docs/03_SYSTEM_ARCHITECTURE.md`「ディレクトリ構成」）に合わせている。各パッケージの下のディレクトリ分けはまだ無いので、パスだけで決まらないクラスは import と呼び出し先で判定する（表の下の段落）。台帳 `references/learned-checks.md` は他PJ由来の汎用項目を初期値とし、`review-distillation` skill で proj-poker 固有項目を育てる。

## 資産の位置づけ（2 資産・同じ項目は片方だけ）

| 資産 | いつ読む | 中身 | 書き込む人 |
|---|---|---|---|
| **学習台帳** [`references/learned-checks.md`](references/learned-checks.md) | **レビュー時**（本 skill 手順 1） | 差分を見て初めて判定できる観点。「条件 → 確認動作 / 外すと起きること / 再発」 | `review-distillation` skill だけ |
| **実装前ガイダンス** `.claude/skills/implementation-guidance/` | **書く前**（`github-workflow` 実装 phase の入口） | 書く前に知っていれば防げる判定基準。領域別 reference | 同上 |

- 同じ項目を両方へ置かない。迷ったらガイダンス（書く前に防ぐほうが安い）。
- レビュー中に「これは次も出る」と思った指摘は**ここへ直接足さず**、`review-learning` skill で PR コメントへ候補として残す。

## 実施手順

### 準備（親の工程 — reviewer agent は Bash を持たない）

1. 差分を確定させる（レビュー中に実装を並行しない）。
2. **差分クラスを判定する**（下表）。変更ファイルの一覧は `git diff --name-only $(git merge-base HEAD origin/main)..HEAD`（未コミット分も見るなら `git add -N . && git diff --name-only origin/main`）。
3. **読むファイルを確定する**: 本 SKILL.md ＋ 台帳（常に）＋ 該当クラスのチェックリスト（ドメイン差分は `poker-invariant-review` skill）。
4. `reviewer` agent へ委譲する場合は、`.claude/agents/reviewer.md`「入力」が定める**必須入力**（パッチ・対象ルート・差分クラス・台帳/チェックリストの絶対パス）をすべて渡す（列挙の一次情報はそちら。1 つでも欠けると reviewer は停止する）。

### 差分クラス（パス → クラス。判定できないパスがあれば全クラスを読む）

**1 つの差分は複数クラスに属しうる**（該当するクラスの台帳セクション・チェックリストをすべて読む）。特に Local Runtime の API / IPC 境界の差分は、配下の機能領域（`poker-engine` 等）のクラスにも当てる。

| クラス | 主なパス（D67・D68 の構成） |
|---|---|
| `poker-engine` | Poker Rule・GameState・Hand 進行・Betting・Showdown・Pot/Side Pot・Chip 計算など決定論的コード（`packages/engine/**`） |
| `knowledge-state` | CPU ごとの `KnowledgeState`・Observation 生成（`packages/engine/**` の Projection）と、LLM へ渡す入力の組み立て（`apps/server/**`）。情報境界。global GameState を渡していないか |
| `review-pipeline` | Decision Review / Reveal Review・Solver Adapter・Source Grounding・Hindsight 防止（`apps/server/**`。使う決定論計算が `packages/engine/**` にあればそれも） |
| `ai-opponent` | AI Opponent の Persona・Structured Output 検証・Fallback（`apps/server/**`）と、合法候補を返す `packages/engine/**` |
| `ui-table` | Table UI・Action Panel・Review 表示（実額常時表示・BB 補助）・hooks（`apps/web/**`） |
| `persistence-event-log` | Event Log（正本）・Projection（Summary / Stats）・SQLite スキーマ・マイグレーション・Replay（SQLite は `apps/server/**` だけが扱う・D67。Event の型や Projection の純粋関数が `packages/engine/**` にあればそれも） |
| `db` | スキーマ・マイグレーション・DB アクセス層・raw SQL を含む差分（`apps/server/**`。`persistence-event-log` と併せて当てる） |
| `async` | 非同期ジョブ・Solver Subprocess・LLM 呼び出しの並行/タイムアウト/再試行を扱う処理（主に `apps/server/**`。`apps/web/**` の API 呼び出しも） |
| `llm` | LLM 呼び出し・オーケストレーション・プロンプト定義・評価ハーネス（`apps/server/**`。LLM を呼ぶのは Runtime だけ・D67。Eval の置き場は未確定） |
| `docs` | `docs/**`・ルートの `*.md`（下記 `harness` を除く） |
| `harness` | `.claude/**`・`CLAUDE.md`・`AGENTS.md` |

**ドメイン差分**（`poker-engine` / `knowledge-state` / `review-pipeline` / `ai-opponent` / `persistence-event-log` / `ui-table`〔実額表示・Hidden Card の表示経路〕）には、本 SKILL.md の汎用チェックに加えて `poker-invariant-review` skill を当てる。正本の不変条件は `docs/02`・`03`・`04`・`05`・`09` と `docs/decision_log.yaml`（採用済み判断の上書きは禁止）。

パスで判定しきれないとき（例: API Route が LLM を呼ぶか）は、差分の import・呼び出し先（LLM プロバイダ・キュー投入・raw SQL の関数）で当てる。迷ったら広く読む（削る方向に裁量は使わない）。

### レビュー（親・reviewer で同じ）

1. **台帳を読む** —— [`references/learned-checks.md`](references/learned-checks.md) の「共通」と該当クラスのセクション。**差分を読む前に読む**（後から読むと同じ見落とし方を再現する）。
2. 差分を読む。
3. 汎用観点で見る: 正確性（ロジック・境界条件・null・例外経路）／読みやすさ／保守性／エラーハンドリング／セキュリティ／テストの妥当性／依頼範囲外の変更がないか。
4. 下記の固有チェックリスト A・B・F・G・H と、該当クラスのチェックリスト（ドメイン差分は `poker-invariant-review`）を当てる。
5. 指摘は `file:line` を示し、「何が問題か」「なぜ問題か」を修正可能な形で書く。重大度タグ（後述）を必ず付ける。
6. 明示的に依頼されるまでファイル修正はしない（PR の自己レビュー時は修正可。修正したら再レビュー）。

## 固有チェックリスト（差分クラスによらず当てる）

### A. 設計書とコードの数値整合（最頻発の指摘パターン）

設計書に書いた数値（ブラインド構造・スタック量・閾値・確率・タイムアウト等）がコードと**ズレている**指摘が過去に連続発生した。**設計書を編集した時点で、grep で全箇所の同期を必ず取る**。

- [ ] 設計書の定数・閾値・列挙値が**全箇所で同期**しているか（§概要表 / §詳細セクション / `decision_log.yaml` / コメント の 4 箇所以上で記述ズレがよく起きる）
- [ ] 設計書の数値とコード実装の数値が**一致**しているか（例: 最大プレイヤー数・Retry 上限・タイムアウトなどの定数 ↔ 設計書の該当節の値）
- [ ] 設計書で **`Record<Enum, T>` のような型** を要求している場合、列挙値全部が網羅されているか（フォールバック必須の値が `decision_log.yaml` で決まっていればそれも）
- [ ] **配列リテラルや union 型のような** 形式値を、設計書で**実装可能な形**として書いているか
- [ ] 設計書を編集する PR では、修正対象の概念を**全文 grep して 1 commit で全箇所同期**したか（個別修正は修正→push の往復を増やす）

### B. 設計書側の予告と実装の不一致

- [ ] 設計書に「複数案 A/B/C」を残した場合、**実装着手前にプロトタイプ**で動作確認しているか（特に UI のレイアウト・イベント挙動や Solver 連携のように実機でしか分からないもの）
- [ ] 「案 X が機能しなかったら案 Y へエスカレ」と書いた場合、**エスカレ条件と判断者**が明確か
- [ ] 構造的に解決不能（CSS 仕様等）と判明した場合、**ユーザーに判断を仰ぐ**フロー（AskUserQuestion）が想定されているか

### F. SSR hydration（現状は対象外）

`apps/web` は SSR なしの Vite + React SPA（D67）なので、hydration 不一致は起きず本節は当てない。SSR を導入する変更が来たときだけ当てる。ただし 1 つ目の項目の括弧内（乱数は Engine で seed 付きに閉じ込め、UI で生成しない）は SPA でも守る。

- [ ] クライアントコンポーネント内でも SSR されることを前提に `Math.random()` / `Date.now()` を `useState` の lazy initializer で使っていないか（山札のシャッフル等の乱数は Engine 側で seed 付きに閉じ込め、UI で生成しない）
- [ ] 初期値は決定論的にし、useEffect 内で乱数・現在時刻を反映する

### G. 設計書・実装・テストの 3 箇所一致（破壊的変更）

- [ ] **既存の参照箇所を grep で全て洗い出した**か（型変更時の参照漏れ）
- [ ] 削除した import の参照が他ファイルに残っていないか
- [ ] アセット・パス変更でリポジトリ内の他箇所参照を壊していないか

### H. ポーカー不変条件（ドメイン差分。詳細は `poker-invariant-review`）

- [ ] **LLM に global GameState・他者 Hole Cards・Future Cards・Learning-only Reveal・他 CPU の Private Observation を渡していないか**（CPU ごとに独立 `KnowledgeState`・D28）
- [ ] **合法性を LLM に判断させていないか**（合法候補の列挙は決定論的コード、LLM は選択のみ・D40）。LLM 出力は候補集合への所属を検証し、不正なら Fallback する
- [ ] **Decision Review が判断時点の情報だけで生成されるか**（Hindsight Leak 禁止。Reveal Review は別 Pass）
- [ ] **Event Log が正本か**（Summary / Stats は Projection で再構築可能・D37）。Replay が Re-simulation になっていないか（D38）
- [ ] **Chip 総量が保存されるか**（Rake / Rebuy / Top-up 等の明示操作を除き増減しない。配分 Pot 総額 = Rake 等控除後の Distributable Pot。INV-TEST-002 / 005・RakePolicy は docs/02）。実額は常時表示で BB は補助（D49）
- [ ] **Unsupported Solver Spot を正常 Fallback として扱い**、HU Solver の結果を Multiway Exact GTO と表示していないか

## 出力形式（日本語）

```markdown
1. 変更概要
2. [P0] Blocker
3. [P1] High
4. [P2] / [P3]（Medium / Low）
5. 実行すべき確認
6. マージ可否の判断
```

**重大度タグは必須**（Codex 用 `AGENTS.md`「Review guidelines」と同じ 4 段。Codex レビューの `[P0]`/`[P1]` 有無で機械判定するため、意味を揃える）:

- `[P0]` セキュリティ侵害・データ破壊・本番障害につながるもの。マージ不可
- `[P1]` 恒久要件の未対応・重大な設計違反・機能退行。マージ前に要対応
- `[P2]` 改善推奨（設計書ズレ・保守性・テスト不足）。根拠を記録すれば見送り可（`github-workflow` の P2 accept）
- `[P3]` 任意対応（命名・コメント・現状メモ）

例:
```markdown
- [P1] CPU の Observation 生成が global GameState を参照し、他者の Hole Cards が LLM 入力へ混入する（src/.../observation.ts:42）
  → CPU ごとの `KnowledgeState` から組み立て、入力スキーマに他者 Private 情報を持たせない
```

> `[codex]` プレフィックスは Codex 自身のレビュー出力で使われる識別子。自己レビューでは使わない（`## 🤖 Claude Code 自己レビュー` の見出しで識別する）。

## 関連

- `implementation-guidance` skill（対になる資産。実装前に読む）
- `poker-invariant-review` skill
- `decision-log` skill（`docs/decision_log.yaml` の参照・追記）
- `review-learning` / `review-distillation` skill（台帳の育て方）
- グローバル版 `code-review` skill（基本観点）
- `github-workflow` skill（第 2 段レビューループ・マージ判断）
