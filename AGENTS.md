# AGENTS.md（proj-poker 固有のレビュー観点）

このファイルは、Codex がレビューするときにグローバル指針（`~/.codex/AGENTS.md`）に**加えて**参照する。Codex が使えないときは、`reviewer` agent に「特に見てほしい観点」として渡す。

**重大度タグの定義**（グローバル指針と共通。グローバルファイルが無い環境でも参照できるよう、ここにも載せる）:

- `[P0]`: 情報漏えい（Hidden Information Leak を含む）、データ破壊、秘密情報の露出につながるもの。マージ不可。
- `[P1]`: 恒久要件が満たされていない、または重大な設計違反。マージ前に対応が必要。
- `[P2]`: 改善を推奨するもの。優先度は中。
- `[P3]`: 軽微な提案やスタイルの指摘。対応は任意。

ここには proj-poker 固有の事情だけを書く。共通の指針はグローバル側にある。

proj-poker は、ライブ実戦を意識した No-Limit Texas Hold'em の練習と AI コーチングを行う**ローカル単一ユーザー**のアプリケーション。詳細は `CLAUDE.md` と `docs/`（索引は `docs/00_DOCUMENTATION_INDEX.md`）を参照する。人間向けの文章（docs・Issue・PR・コメント）は日本語で書く。

## レビュー前に必ず確認する

- `docs/decision_log.yaml`: 採用済みの人間判断（D01〜）。**docs 間で矛盾した場合の最上位**。
- `docs/08_MVP_AND_ROADMAP.md`: Phase 0〜8 とそれぞれのスコープ。MVP は Phase 5 まで。
- `docs/11_OPEN_ITEMS.md`: 意図的に未確定にしている事項。
- 対象 PR のタイトルの `[PhaseN]` と、その Phase のスコープ。

## Phase 認識（未対応を即マージ不可にしない）

- **ロードマップで後の Phase に予定されている未対応**（Tournament・Rich CPU Memory・Multiway Solver・Session Learning など）は問題としない。記録を残したい場合だけ `[P3]` を付ける。
- **Open Item に可逆な暫定値を置くこと**（OI 番号のコメント付き）は正しい振る舞い。逆に、**暫定値を永久仕様として docs に確定させる変更**は `[P1]` とする。
- ただし、次のものは Phase に関係なく緩和しない: 下の 1〜3 の不変条件、すでに満たしている要件を崩す変更、情報境界を広げる変更。

## Review guidelines

各観点の確認動作（何を grep・assert すれば漏れを確認できるか）は `.claude/skills/poker-invariant-review/SKILL.md`（情報境界・決定論・Review・Event Log・Chip・Solver）と `.claude/skills/poker-engine-testing/SKILL.md`（Engine のテスト規約）にある。重大度は本ファイルが正。

### 1. 情報境界・Hidden Information（全 Phase 共通・最重要）

- Opponent Model（LLM）への入力に、global `GameState`、他 Player の Hole Cards、Future Cards（デッキの残り順を含む）、Learning-only Reveal、他 CPU の Private Observation、ユーザーの弱点プロフィールが入りうる経路は **[P0]**（D28）。入力は CPU ごとの `KnowledgeState` を whitelist で組み立てるのが原則で、blacklist 方式で除外しているだけなら `[P1]`。
- Learning-only Reveal が CPU Memory、統計、Opponent の入力へ流れるのは **[P0]**。
- **Decision Review（Pass A）に判断時点より後の情報（後から見えたカード・結果）が入る**のは **[P0]**（Hindsight Leak）。Reveal Review は別の Pass として扱う。
- Hidden な CPU 設定（Persona の内部パラメータなど）を Review の根拠に使うのは `[P1]`。

### 2. 決定論的な Poker Engine と LLM の分担（全 Phase 共通）

- 合法 Action、Pot / Side Pot、Hand Ranking、Button / Blind、チップ移動の判定を LLM 出力に委ねる変更は **[P0]**（D40）。
- LLM 出力を Schema → Legal Action → Amount Range の順に検証していない経路、Retry が 1 回を超える経路、Deterministic Fallback が欠けた経路は `[P1]`（docs/03 §5）。Invalid Output をログに残さない場合は `[P2]`。
- AI 障害時に Emergency Bot へ**自動で**切り替える変更は `[P1]`（docs/03 §6。ユーザーに選ばせる仕様）。
- Engine の再現性を崩す箇所（Shuffle 等の乱数が注入された RNG / seed を経由しない、State 遷移が実時刻に依存する）は `[P1]`。チップ総量の保存（INV-TEST-002/005。Rake 等の明示操作を除く）が崩れる変更は **[P0]**。Chip の数値表現は docs で未確定のため、表現の選択自体は指摘せず、保存が崩れうるか（丸め誤差等）で判断する。

### 3. 秘密情報・ローカル境界（全 Phase 共通）

- `.env*`、API キー、トークン、Claude Code の OAuth 資格情報（`~/.claude/` の中身）のコミット、またはブラウザ（クライアント）側のコードから Claude の資格情報を参照できる経路は **[P0]**。Claude を呼ぶ子プロセスの環境に `ANTHROPIC_API_KEY` が残り API 課金へ切り替わりうる実装は `[P1]`（D87）。
- モデル名・Solver 名の Domain Logic へのハードコードは `[P2]`（role-based config。OI-001 / OI-002）。

### 4. Event Log・永続化

- Event Log を正本とする設計（D37）を崩す変更（Projection を正本として扱う、Event を後から書き換える）は `[P1]`。
- Replay を Re-simulation として実装する（LLM を再実行する）変更は `[P1]`（D38）。
- SQLite スキーマの破壊的変更（列の削除、型の変更、既存 Event の互換性が崩れる変更）は `[P1]`。互換性の考慮が無いものは `[P0]` になりうる。

### 5. Solver・Review の誠実さ

- Unsupported Spot で例外を投げて Review 全体が失敗する経路は `[P1]`（正常に Fallback させる）。
- HU Solver の結果を Multiway の Exact GTO として表示・説明する変更は `[P1]`。
- Web Evidence に Source / Date / Scope / Confidence が無いものは `[P2]`。

### 6. UI・表示

- 実額が常時表示されない（BB だけの表示になる）変更は `[P1]`（D49）。

### 7. スコープと非目標

- 新たな人間判断なしに Auth、Tenant、Cloud DB、Online Multiplayer、Voice、3D、Real Money、Distributed 構成を持ち込む変更は `[P1]`（docs/00 §6・docs/03 §11）。
- `docs/decision_log.yaml` の採用済み判断と矛盾する実装や docs 変更は `[P1]`。

### 8. テスト

- Poker Engine の変更に、対応する決定論テスト（Unit / Invariant / Scenario Regression）が無い場合は `[P1]`（docs/09。Engine の正しさは最優先）。
- Fuzz テストだけで明示的な Rule Scenario を置き換えている場合は `[P2]`。
