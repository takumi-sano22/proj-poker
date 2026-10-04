# CLAUDE.md

このリポジトリで作業するエージェント向けの方針（kernel）。**ここに置くのは不変条件と routing だけ**で、手順・事実・経緯は skill と `docs/**` が持つ（ここへ写さない）。グローバルの `~/.claude/CLAUDE.md`（日本語応答・KISS・最小実装・依頼範囲外のリファクタ禁止・未実行コマンドを成功と言わない・完了報告前に実出力を引用する等）も常に適用される。

## まず読むこと（全セッション必須）

1. **`github-workflow` skill を読み込む**（標準開発フローの一次情報）。同名の global skill があるため、`.claude/skills/github-workflow/SKILL.md` を Read で読む（固有版が優先）。
2. **`model-selection` skill でモデルを選ぶ**。作業の性質が変わるたびに当て直す。
3. **`docs/00_DOCUMENTATION_INDEX.md`**（docs の責務と矛盾時の優先順位）と、触る領域の正本 docs を読む。**実装が `docs/03_SYSTEM_ARCHITECTURE.md` / `docs/04_DATA_AND_EVENTS.md` と食い違う変更をしたら、同じ PR 内で docs を更新する**（採用済み判断と矛盾するなら更新ではなく停止。下記 7）。

## リポジトリ・プロダクト

- **リポジトリ**: `takumi-sano22/proj-poker`。**進捗管理**: GitHub Project は使わず、親 Issue #2（MVP Parent）への **sub-issue 紐付け**と親の DoD チェックボックスで管理する（`create-issue` / `issue-patrol`）。
- **プロダクト**: ライブ実戦を意識した No-Limit Texas Hold'em 練習 + AI コーチング環境。ローカル単一ユーザー（Auth / Tenant / Online Multiplayer / Real Money は作らない）。正本は `docs/`、採用済みの人間判断は `docs/decision_log.yaml`（D01〜）、未確定事項は `docs/11_OPEN_ITEMS.md`。

## 不変条件（mode・自走の有無に依らず常に適用）

1. **ルールは決定論、LLM は戦略選択だけ**: カード・合法 Action・Pot / Side Pot・Hand Ranking・チップ移動は決定論的な Poker Engine が扱う。LLM の出力は Schema / Legal Action / Amount Range で検証し、合法性を LLM に判断させない（D40）。
2. **情報境界**: CPU ごとに独立した `KnowledgeState` だけを Opponent Model へ渡す（D28）。global `GameState`・他 Player の Hidden Cards・Future Cards・Learning-only Reveal・他 CPU の Private Observation・ユーザーの弱点プロフィールを渡さない／CPU Memory へ入れない。
3. **Review に結果論を混ぜない**: Decision Review は判断時点の Hero Information Set だけを使う。Learning-only Full Reveal は別 Pass。
4. **Event Log が正本**（D37）。Summary / Statistics は派生 Projection。Replay は過去 Event の再生で Re-simulation ではない（D38）。実額は常時表示し BB は補助（D49）。Chip 総量は明示操作以外で増減しない。
5. **Solver の誠実さ**: Unsupported Spot は正常 Fallback。HU Solver の結果を Multiway の Exact GTO として扱わない。モデル名・Solver を Domain Logic へハードコードしない（role-based config。OI-001 / OI-002）。
6. **Git・秘密情報**: main へ直接 commit / push しない。force push・履歴改変をしない。全変更は Issue → worktree（`.claude/worktrees/<branch>`）→ PR。API キー・`.env*` はコミットしない。Claude API はローカル Runtime 側からのみ呼び、ブラウザへキーを渡さない。
7. **必ず立ち止まる**（完全自走でも）: 秘密情報のコミット / force push・履歴破壊・データ削除 / 永続化スキーマの破壊的変更 / セキュリティ・権限・課金 / **`decision_log.yaml` の採用済み判断の変更・Open Item の永久確定**・新たな人間判断なしの非目標（Auth・Cloud DB・SaaS・Voice・3D 等。`docs/00` §6・`docs/03` §11）の導入 / 設計の根本変更・要件の曖昧さ。不可逆な git / gh 操作は `settings.json` の `permissions.ask` で人間プロンプトになる（書き方を変えて迂回しない）。

## 自走ルール（このプロジェクトの既定）

- **人間判断はセッション冒頭にまとめる**: 着手前に調査を済ませ、迷う点・提案をまとめて `AskUserQuestion` を 1 回で出す。以降は**完全自走**（Issue 選択 → worktree → 実装 → 確認 → ログ → コミット → PR → 自己レビュー → Codex レビュー → マージ）。停止するのは上の 7、`github-workflow`「必ず人間確認で停止する条件」、および docs が定める停止ゲート（下記）。
- **実装開始ゲート**: `docs/00` §7・`docs/08` §5 により、Phase 0 / 1 の**プロダクト実装**は親 #2 の Gate「追加された Skills / Harness をこの PJ の開発規約として確認する」に人間がチェックを入れるまで開始しない（harness・docs の整備は可）。AI がこのゲートを自己判断で解除しない。
- Codex モードは repo 上書きで `autonomous`（`~/bin/codex-mode.sh get /home/ai/project/proj-poker` で確認。worktree 内で引数を省くとグローバル既定になる）。**複数 Issue は `issue-worker` 経路**（親は計画・`NEEDS_HUMAN` 仲介・マージ・後始末）。
- **1 PR 単位でレビュー・マージし、原則順次**。マージできなかったら次に入らず停止し、停止理由と次の作業を PR コメントに残す。
- 積み残し・分割が必要なら**新 Issue を作成し親 #2 へ紐付け**てから進める。可逆な暫定値（Open Items）は Config で置き、永久仕様として確定しない（`decision-log` skill）。

## 開発フローの固有ルール（手順の一次情報は `github-workflow`。**タイトル規約はここが一次情報**）

- **Issue・PR タイトルは `[PhaseN]` で始める**（N は `docs/08_MVP_AND_ROADMAP.md` の Phase 0〜8）。Phase に属さない横断作業は `[横断]`。親 Issue は `[Parent]`。
- **Phase 運用**: Phase 着手時に `phase-planning` skill で子 Issue へ分解する。Phase 最終 PR は `release-readme-sync` skill でルート README を更新する。MVP は Phase 5 完了まで（Scope Creep 防止は `docs/08` §4）。
- **PR の `## Summary` / `## Test plan` は必須**。作業ログは `docs/taskLog/`（`task-log` skill）。人間向け文章（Issue / PR / docs / コメント）は日本語。
- **レビュー順序は「自己レビュー（台帳必読）→ Codex レビュー」**。指摘は 4 状態に確定し、same-root sweep → 修正 or P2 accept → 条件付き再レビュー。各ラウンド後とループ出口で `review-learning`。
- **品質チェック**: lint / typecheck / test / format のコマンドは Phase 0 で確定後にここへ追記する。

## routing（いつ → どこを読むか）

- **実装に入る前** → `implementation-guidance` skill（触る領域の reference だけ）
- **Poker Engine・テスト** → `poker-engine-testing` skill / **情報境界・ドメイン不変条件の点検** → `poker-invariant-review` skill
- **自己レビュー** → `code-review` skill（台帳 `references/learned-checks.md` を先に読む）。Codex 用観点は `AGENTS.md`
- **レビュー指摘の学習** → `review-learning`（Capture）/ `review-distillation`（別 PR で台帳へ）
- **subagent へ委譲** → `model-selection`（ティア）→ `subagent-briefing`（渡し方）。agents は `.claude/agents/`（共通契約: マージ禁止・範囲外に書かない・統制面を触らない）
- **Issue の起票・巡回・Phase 分解** → `create-issue` / `issue-patrol` / `phase-planning`
- **人間判断の記録・Open Items** → `decision-log` skill / **Solver 選定 PoC（OI-002）** → `solver-poc` skill
- **AI Opponent / Review の品質評価** → `llm-quality-improvement` skill
- **実装・設計書・Issue の整合 / skill 追加** → `sync-check` / `add-skill`
- **UI** → `ui-design-recipes`（卓 UI 向けの改良は #5 で予定。現状は汎用版）
- **ポーカードメインの根拠** → `docs/research/`（根拠資料であり仕様ではない。採用済み判断を上書きしない）
- **GitHub の状態** → `gh` CLI / GitHub MCP の一次情報。書き込みは gh CLI
- **skill・agents・hooks・permissions の所在と使い分け** → `.claude/README.md`（global と同名の skill は固有版を優先）
