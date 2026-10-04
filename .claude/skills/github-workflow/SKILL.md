---
name: github-workflow
description: コード/ドキュメント変更を伴うすべての作業で、着手時に必ず本skillを確認・起動する。GitHub Issue、ブランチ、コミット、Pull Request、作業ログを使った開発フローを進めるためのSkill。標準開発フローであり、ユーザーから明示的に否定されない限り、コード/ドキュメント変更を伴うすべてのセッションで利用する。proj-poker では main への直接 push は行わない（CLAUDE.md 不変条件 6。ユーザーが明示依頼した場合も permissions.ask の人間プロンプトを経る）。「～を実装して」「～を進めて」「～してください」というワードに反応して起動する。プロジェクト固有版があればそちらを優先する。
---

# GitHub開発フロー

本文は作業の時系列（Step 0 → Issue → ブランチ → 実装 → PR → レビュー → マージ）で並ぶ。各ルールの詳細は一次記述のセクションに一元化し、他所からは参照する。末尾の「常時適用ルール」（完了報告前検証・進捗可視化）はフロー全体を通して常に適用する。

> **proj-poker の実値**: リポジトリ `takumi-sano22/proj-poker`・本体作業ツリー `/home/ai/project/proj-poker`・タイトル規約は `CLAUDE.md`（`[PhaseN]` / `[横断]`）・進捗管理は GitHub Project ではなく**親 Issue #2 への sub-issue 紐付け**・実装の一次情報は `docs/03_SYSTEM_ARCHITECTURE.md` / `docs/04_DATA_AND_EVENTS.md`・Codex 連携スクリプトは `~/bin`。

## 標準フロー

> ブランチ作成の前に、必ず次節「Step 0」を通す。**着手したらまず `TaskCreate` で作業チェックリストを作る**（Step 0 の先頭の必須手順・作らずに進めない）。

1. GitHub Issue を作成または選択する。**新規作成は subagent に委譲して `create-issue` skill を実行させる**（詳細・直列/並列の使い分けは「Issue 作成も委譲対象」）。複数 Issue の同時実装を依頼された場合は、先に `issue-patrol` skill で依存・領域重複・並行可否を整理して実装計画を立ててから着手する（実装着手自体は本 skill にディスパッチ）。
2. main 基点の worktree でブランチを作成する（「作業ツリーの分離」参照）。ブランチ名:
   - `feature/<issue-number>-short-name`
   - `fix/<issue-number>-short-name`
   - `infra/<issue-number>-short-name`
   - `docs/<issue-number>-short-name`
3. **実装に入る前に `implementation-guidance` skill で触る領域の reference を読む**（書く前に判定できる基準）。**実装は subagent（`Agent`/`Task`）に委譲して行う**。親は最小限・安全な変更方針と該当 reference の絶対パスを渡し、戻り値をレビューする（「実装作業は subagent に委譲する」参照。委譲コストが上回る軽微な作業のみ親で直接行う）。
4. 必要な確認を実行する。
5. 作業ログを作成または更新する（`task-log` skill。様式はプロジェクトに従う。例: `docs/taskLog/`）。
6. **`docs/03_SYSTEM_ARCHITECTURE.md` / `docs/04_DATA_AND_EVENTS.md`（実装の一次情報）を PR を出す際に必ず確認し、実装（Component 境界・Event / 永続化設計・ディレクトリ構造）が変わっていれば同じ PR 内で更新する**。`docs/decision_log.yaml` の採用済み判断と矛盾する変更は更新で吸収せず停止する（`decision-log` skill）。
7. コミットする（「コミットメッセージ」参照）。
8. Issue に紐づく Pull Request を作成する（「PR説明文の構成」参照）。
9. **ClaudeCode 自己レビュー**を実施し、結果を PR コメントに残す（「PR作成後のレビューフロー」参照）。
10. **第 2 段レビュー**（Codex 導入環境なら Codex レビュー／未導入環境なら `reviewer` agent）を実行し、**結果（`clean` でも）を必ず PR コメントに投稿する**（同上）。
11. レビュー結果に応じて修正・再レビューを繰り返す。**各ラウンドの finding 処理後と、ループの出口（どの結果で終わっても）で `review-learning` skill を呼び、候補を PR コメントへ記録する**（位置と規律の一次情報は `references/codex-review.md`「学習 Capture の位置」。非 Codex 経路でも同じ）。
12. 第 2 段レビューが `clean` かつ「必ず人間確認で停止する条件」に該当しなければマージする（非 Codex 経路ではマージは人間確認が既定。「Codex 導入判定」参照）。

> **1PR単位でレビュー・マージし、実装は原則順次（前PRマージ後に次へ）。** 並行実装が許される条件は「並行実装が許されるのは『独立した作業』のみ」を参照。

---

## Step 0: 実装計画の思考とユーザー確認（ブランチ作成の前に必ず通す）

目的は、手を動かす前に方針を固め、認識のズレ・判断の迷いを着手前に潰すこと。

### 0. 作業チェックリストを作る（`TaskCreate`・着手したら最初に）

着手したら**まず** Task ツール（`TaskCreate`）で、標準フローの手順・要件を作業チェックリスト化する。以降は `TaskUpdate` で進捗を更新しながら進める。**どんな作業でも必ず作る**（手順スキップ・作業漏れを防ぐ）。**`TaskCreate` が提供されない環境でのみ**、代わりに応答内へ同じチェックリストを置く（省略はしない）。

### 1. モデル選択

**`model-selection` skill（プロジェクト固有版があればそちら）を読み込み**、その基準で作業種別に応じたモデルを選ぶ。以降は**作業の性質が変わるたびに都度この基準を当て直し、トークン使用を最適化する**（一度選んで終わりにしない）。

- 既定の指針（skill が見つからない場合もこれを適用）: 本体ループは **Opus** 固定。サブエージェントへ委譲するときのティアは、機械的・低リスク作業（ログ/diff確認・定型grep・フォーマット）＝**Haiku** / 設計が確定した実装＝**Sonnet** / 設計判断・権限/課金/セキュリティ・失敗時の影響が大きい作業＝**Opus**（本体で扱う）。
- 探索・大量ファイル走査・横断調査は `Explore` 等のサブエージェントに委譲し、親のコンテキスト（トークン）を節約する。
- 下位モデルで方針判断・繰り返しの失敗・影響範囲の拡大が起きたら、一段上へエスカレーションする。

### 2. 実装計画を考える

**まず、他の skill の description を確認し、この作業で使う必要のある skill を特定する**（該当する skill があれば起動し、その手順・チェックリストに従う）。そのうえで、最小実装の方針・影響範囲・触るファイル・想定リスクを整理する。

- **自明で簡単な作業**（typo修正・1〜3行の定型変更・ログ確認など）では、計画の思考に時間をかけない。すぐ次に進んでよい。
- 設計判断を含む・影響範囲が広い・複数の実装方針がありうる場合は、`Plan` agent の活用も検討する。

### 3. 不明点・判断に迷う箇所があれば、ユーザーに質問する

実装計画を考えた結果、**不明点や判断に迷う箇所があれば必ずユーザーに質問する**。質問は答えやすいよう、**選択肢を選ぶ形式**にする。

- **`AskUserQuestion` ツールを使う**。選択肢には推奨案を先頭に置き、各選択肢にトレードオフを添える。
- 複数の方針を比較してほしい場合は、plan モード（`EnterPlanMode` → `ExitPlanMode`）で計画を提示し承認を得る形も使える。
- **不明点・判断に迷う箇所が無ければ、質問せずそのまま着手してよい**（毎回確認を取る運用ではない。「迷いがあるときだけ止まる」）。
- **proj-poker では質問をセッション冒頭の 1 回に集約する**: 着手前に調査を済ませ、迷う点・追加提案をまとめて 1 回の `AskUserQuestion`（最大 4 問）で確定させる。作業途中に追加質問を出さない（次節 4 の完全自走が既定）。

### 4. 完全自走指示セッションの扱い（例外）

**proj-poker では完全自走が既定**（`CLAUDE.md`「自走ルール」）。Step 3 の冒頭質問で人間判断を確定させた後は、**致命的な判断を除き自己判断で進めてよい**。致命的な判断＝後述「必ず人間確認で停止する条件」に該当するもの（`git push --force`・履歴破壊・データ削除等の破壊的/不可逆な操作、`decision_log.yaml` の採用済み判断の変更を含む）。該当したときだけは止まり、要点を PR / Issue コメントに残してユーザーに返す。

> ユーザーがそのセッションで明示的に「都度確認して」と指示した場合は、通常の Step 3（迷いがあれば都度質問）に戻す。

---

## 実装作業は subagent に委譲する

**実装・探索・他 skill の実行といった重い作業は subagent（`Agent`/`Task`）に委譲して行う。** 親（main）はオーケストレーションに徹してコンテキストを太らせない。親は「何を・どこを・どうゴールするか」を決めて subagent へ渡し、戻り値（結論＋最小抜粋）だけを受け取ってレビュー・次の判断に集中する。

**なぜ委譲するか**: 実装の試行錯誤・ファイル全文・skill 本文を親のコンテキストに積むと、セッションが肥大化してトークン効率とレビュー精度が落ちる。作業単位を subagent に切り出せば親は判断とレビューに集中でき、Stage 分割による並列化にもそのまま乗る。

**渡し方（`subagent-briefing` skill 準拠）**: subagent は本セッションの会話履歴・メモリ・skill を**直接は参照しない**。会話やファイルを丸ごと渡さず、**明確なプロンプト**に絞る:

- **入力**: タスク／対象 `path:line`／ゴール／採用方針の確定値（数値・命名・配置など）／使うべき skill 名／**該当する `implementation-guidance/references/<領域>.md` の絶対パス**（`impl` へ）または**台帳・チェックリストの絶対パス一覧**（`reviewer` へ。必須入力の一次情報は `.claude/agents/reviewer.md`「入力」）。
- **前提**: 直前の変更点・差分前提・落とし穴を明記する。
- **出力形式**: 結論ファースト＋最小抜粋。**完了報告フォーマット**（PR 番号・マージ状態・第 2 段レビュー結果・`REVIEW_LEARNING=` の値・残課題）を指定する。
- **モデル**: Step 0 のモデル選択基準で選ぶ（判断多め=Opus / 既存パターン流用=Sonnet / 軽微=Haiku）。
- **委譲先エージェント**: 作業種別が下表に当てはまるなら、`agentType` で **model 固定の名前付きエージェント**（`.claude/agents/` または `~/.claude/agents/`）を選ぶ。`general-purpose` は本体モデル（Opus）を継承しコストが下がらないため、当てはまる作業はこちらを優先する（使い分けの一次情報は `subagent-briefing` skill「委譲先の名前付きエージェント」）。

  | 作業種別 | エージェント | model |
  |----------|--------------|-------|
  | **1 Issue を merge-ready まで所有**（worktree → 実装 → 検証 → commit/push → PR → 自己レビュー → 第 2 段レビュー → Capture。**マージはしない**） | `issue-worker` | sonnet（設計判断・複数領域・高 blast radius の Issue は Agent ツールの `model` 引数 `opus` で上書き。frontmatter より優先） |
  | 設計が確定した定型実装・小〜中リファクタ・テスト追加 | `impl` | sonnet |
  | 機械的・低リスク（ログ/diff確認・定型grep・整形・同型の一括変更） | `chore` | haiku（読み取り探索は `Explore`） |
  | PR/コミット前の差分レビュー（読み取り専用＝Bash 無し・差分は親が渡す・findings 返却） | `reviewer` | opus / effort high |

**親で直接やってよい例外**: typo・1〜3 行の定型修正・ログ/diff 確認など、委譲コストが上回る軽微な作業。過剰委譲はしない。

### Issue Worker 経路

**完全自走・複数 Issue のときは Issue Worker 経路を既定にする**: 標準フローの 2〜11 を `issue-worker` が自分の worktree で実行し、親は 1（Issue 選択・計画・ティア判定）と 12（マージ）、マージ後の後始末とメモリ更新、および `NEEDS_HUMAN` の仲介（`AskUserQuestion`）だけを持つ。単発 Issue は従来どおり親主導（実装単位を `impl` へ委譲）でもよい。

- **渡すもの**は `subagent-briefing`「Issue Worker へ渡すもの」（Issue 番号・リポジトリルート絶対パス・触ってはいけない領域・追加制約・該当ガイダンスの絶対パス）。会話履歴・ファイル本文は渡さない。
- **返ってくるもの**は compact status（`ISSUE / PR / HEAD / STATE / TEST / REVIEW2 / LEARNING / HUMAN_DECISION`）か `NEEDS_HUMAN` だけ。生 patch・生ログ・レビュー全文が含まれていたら受け取らず出力規律の逸脱として扱う。
- **親は status を停止条件・人間確認条件と突き合わせてからマージする**。`STATE=merge-ready` は機械ゲート（第 2 段レビュー clean / P2 accept 記録 / CI 緑）の充足までを意味し、「必ず人間確認で停止する条件」の判定は親の持ち分。マージ前に第 2 段レビューの PR コメント（Codex 経路は `## 🤖 Codex レビュー結果`、非 Codex 経路は `## 🤖 第 2 段レビュー結果（reviewer agent）`）を親が直読する。
- **subagent からの `gh pr merge` は PreToolUse hook（`hooks/pre-tool-use-subagent-guard.py`）が deny する**（hook を導入している場合）。親セッションのマージには影響しない。深さ上限は `settings.json` の `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2`（Worker の子は葉）。
- 複数 Worker を並行させる条件は「並行実装が許されるのは『独立した作業』のみ」と同じ（触るファイルが重ならず、依存が無い）。共有台帳（ローカル Issue 記録・WBS 等）の更新は Worker にさせず親が直列で行う。
- **Worker が `NEEDS_HUMAN` で返した Issue を、親が実装で引き取らない**（停止条件は実装で解けない）。判断を人間へ返すか、判断確定後に同じ Worker へ handoff（PR 番号・branch・worktree 絶対パス・HEAD を渡す）で再開させる。

### Issue 作成も委譲対象

`create-issue` skill の実行（skill 本文・`gh label list` / `gh issue create` / sub-issue 紐付けの出力・重複チェック結果）は親コンテキストを太らせるため、実装と同様に subagent に委譲する。

- **入力（`subagent-briefing` 準拠で最小化）**: タイトル案・WHY/WHAT の要点・対象 repo・親 Issue 番号（MVP は #2）・タイトル規約（`CLAUDE.md`）・**希望ラベル**・**アサイン方針**（担当確定ならその GitHub ユーザー名／未定なら `@me`。アサイン無しで作らせない）・**relationship**（親 Stage/トラッキング Issue 番号があれば sub-issue 紐付け対象／依存・ブロック Issue 番号があれば本文 `Depends on`・`Blocked by`・`Refs` 用）・使う skill 名（`create-issue`）。
- **出力**: 作成した Issue URL/番号・付与したラベル・アサイン結果・**張った relationship**・親 Issue への sub-issue 紐付け結果。（proj-poker はローカル Issue 記録台帳を採用しない）
- **直列が既定**: 依存関係（`Depends on` / `Blocked by`）を本文に書くため、後続 Issue が先行 Issue の番号を参照できるよう直列に起票する。独立した多数の Issue だけは並列起票してよい（Phase 分解は `phase-planning` skill）。
- **例外**: ごく軽微な単発 Issue で委譲コストが上回るなら親で直接起票してよい（過剰委譲はしない）。

### 大規模 Issue の Stage 分割並列運用（reference 参照）

複合 Issue を Stage に分割し、独立 Stage を subagent の**並列**起動で進める場合（親 Issue → サブ Issue 起票 → 並列実装 → 完了通知で次 Stage）は、**[`references/stage-parallel.md`](references/stage-parallel.md) を必ず読んでから着手する**（分割の判断基準・Stage Issue 本文の必須要素・subagent prompt で脱落しがちな必須項目・マージ衝突対策の一次情報）。

---

## 作業ツリーの分離（worktree既定）

実装・コミットを伴う作業は、**未コミットの並行作業の有無にかかわらず、原則として main 基点の `git worktree` に切り出して行う（既定プロセス）**。本体作業ツリー（`/home/ai/project/proj-poker`）上で `git checkout -b` して実装を始めない。

**なぜ既定にするか**: メイン作業ツリーを共有していると、こちらが `git checkout` / `commit` する間に外部（ユーザーのIDE操作など）がブランチを切り替え、**コミットが意図しないブランチに乗る**／**他人の未コミット変更を巻き込む**事故が起きる。並行操作の有無は事前に確実には分からないため、「無さそうだから本体で作業する」という賭けをせず、**常に worktree で隔離する**。worktree 内は HEAD が独立し、外部のメイン操作の影響を受けない。並行操作が無かった場合の追加コストは後始末コマンド2つのみで、調整コストの低減に見合う。

**手順**:

1. **着手前チェック（齟齬確認）**: `git fetch origin` で最新を取得し、着手するIssueの対象ファイル/領域が、進行中PR・他ブランチの未コミット作業と重複しないか確認する。重複や未マージ成果への依存があれば、並行に入らず順次（前PRマージ後）へ切り替える。
2. worktree を作成する。配置先は **`.claude/worktrees/<branch>`** に統一する（`.gitignore` 対象・ローカルテスト時にアクセスしやすい）:
   - `git worktree add -b <branch> .claude/worktrees/<branch> origin/main`
3. worktree 内で実装・コミット・push・PR を行う（本体作業ツリーには一切触れない）。依存は下記「worktree の依存」に従って `pnpm install --frozen-lockfile` する。
4. **第 2 段レビューも worktree から実行する**（Codex の `codex-review.sh` は作業ツリーの差分を見るため、対象ブランチがチェックアウトされた worktree 内で実行）。
5. **マージ後は必ず後始末する（必須）**: dev サーバーを止めてから `git worktree remove` → `git branch -D`。プロジェクトに後始末スクリプト（例: dev サーバー停止と worktree 削除を一括で行うもの）があればそれを使う。`.claude/worktrees/` に残したままにしない（`.gitignore` 対象だが、不要な worktree を放置しない）。

**禁止**: メイン作業ツリーで `git checkout -b` して作業を始めない（外部の checkout で HEAD を奪われ、コミットが他人のブランチに乗る）。万一乗ってしまったら、**main 基点の新 worktree を作り、該当ファイルだけ `git checkout <commit> -- <files>` で載せ直す**（他人のコミット群を巻き込まないよう、base との差分が自分の変更だけであることを確認する）。

### worktree の依存（依存運用の一次情報）

proj-poker は pnpm workspace（D68）で、pre-commit hook は使わない（D69）。worktree には gitignore 対象（`node_modules`・`.env` 等）がコピーされないので、**worktree ごとに `pnpm install --frozen-lockfile` する**。pnpm はグローバル store からリンクするため数秒で終わる。`node_modules` は本体から symlink しない（パッケージごとの `node_modules` を本体と共有すると隔離が壊れる）。

```bash
# worktree の直下で実行する。Node は .nvmrc（24）、pnpm の版は package.json の packageManager で固定され corepack が解決する
pnpm install --frozen-lockfile

# .env が要るときだけ（gitignore 済み）。本体から symlink し、コミットしない
[ -f /home/ai/project/proj-poker/.env ] && ln -s /home/ai/project/proj-poker/.env .env
```

- 依存を変える作業は、その worktree で `pnpm add` 等を実行し、`package.json` と `pnpm-lock.yaml` の変更を同じコミットに入れる。CI は `--frozen-lockfile` なので、両者がずれると落ちる。
- 整形の判定は `pnpm format:check`（固定版 Prettier）で行う。`npx prettier`（版無指定）や別版で判定しない（版ずれの直接原因）。
- husky と `.husky/_` の symlink は**不採用**（pre-commit hook を使わない・D69）。整形漏れは push 前の `pnpm format:check` と CI で捕まえる（「マージ前のローカル品質チェック」）。
- symlink した `.env` をコミットしない。`git add -A` は使わず、変更したファイルを明示して `git add` する。

### dev サーバーの起動と停止（worktree 併用時の注意）

> **proj-poker の状況**: ルートの `pnpm dev` で `apps/server`（Fastify・`127.0.0.1:3001`）と `apps/web`（Vite・既定 5173。`/api` を 3001 へ proxy）を同時に起動する。下記の worktree ごとのポート採番と管理スクリプトはまだ作っていない（Phase 0 には画面が無く不要だった。UI を実測する Issue が並ぶようになった時点で作る）。それまでは dev サーバーを 1 つの worktree でだけ動かし、使い終えたら止めてから `git worktree remove` する。

**`git worktree remove` はディレクトリを消すだけで、そこで動いている dev サーバー（Vite / Next.js の dev 等）までは面倒を見ない。** 削除後もプロセスは cwd が `(deleted)` の孤児として生き続け、誰もアクセスしないまま数百 MB を占有する（実測で稼働 4 本中 3 本が孤児だった例あり。うち 2 本は同一 worktree への二重起動）。そのため worktree の後始末と dev サーバーの停止を分離させず、**1 つのスクリプトに一本化する**ことを推奨する（例: プロジェクトの dev サーバー管理スクリプトに `remove <branch>` を持たせ、dev 停止 → `git worktree remove` → `git branch -D` を一括で行う）。

設計の要点（採用する場合）:

- **ポートは worktree ごとに固定**（ブランチ名から決定論的に採番）。自分でポートを決めない。同じブランチなら常に同じポートになるので、ポート番号から worktree を逆引きできる。
- **同一 worktree の二重起動は拒否する**。既存プロセスを検出したら起動せず、稼働中のポートと PID を表示する。
- 状態はレジストリファイルを持たず `/proc`（`cwd` と `PORT` env）から実測する。ファイルはプロセスが異常終了した瞬間に実体とズレるが、`/proc` は常にプロセスの真実を返す。
- 検出・停止の対象は**本体作業ツリーそのもの・git に登録された worktree・`.claude/worktrees/` 配下**で起動されたプロセスに限る。同じマシンで動く無関係なプロセスは孤児であっても触らない。
- セッション開始時に SessionStart hook で孤児を自動停止する運用も可（孤児はどの worktree にも紐づかず復旧の余地がないため自動で落とす。二重起動はどちらを残すか機械的に決められないので報告のみ）。

### 並行実装が許されるのは「独立した作業」のみ

worktree を既定化しても、複数Issueの**並行実装**を無制限に許すわけではない。並行してよいのは、対象Issueが**相互に独立**（ファイル/領域が重複せず、互いの未マージ成果に依存しない）な場合に限る。依存・領域重複のある作業は従来どおり**順次**（前PRマージ後に次へ）。これは差分ベースの変動でレビューが不安定化し、コード一貫性が崩れるのを防ぐため（分岐並走は複数 PR の作り直しを招きやすい）。独立かどうかの判断は手順1の着手前チェックで行い、**判断がつかない場合は順次を選ぶ**。

---

## PR作成後のレビューフロー（全PR共通）

PR を作成したら、以下の **2段階レビュー** を必ずこの順序で実施する。

### Codex 導入判定（第 2 段の経路を決める・省略禁止）

第 2 段レビューは環境によって **Codex 経路** と **非 Codex 経路** に分かれる。PR 作成後、最初に次の順で判定する:

```bash
# 1. 環境変数で明示されていればそれ
# 2. 既定の置き場（例: ~/bin）
for c in "${CODEX_TOOLS_DIR:-}/codex-mode.sh" "$HOME/bin/codex-mode.sh"; do
  [ -f "$c" ] && { echo "codex: $c"; break; }
done
```

- 見つかった → **Codex 経路**（Step 2-A）。以降 `codex-mode.sh` / `codex-review.sh` は**そのフルパス**で呼ぶ（`~/bin` は PATH に無いのが普通で、名前だけでは `which`/`find` でも拾えない。**「見つからない＝Codex 未導入」と即断しない**）。
- 見つからない → **非 Codex 経路**（Step 2-B）。導入したい場合は `codex-sample/README.md` の手順（`install.sh`）を案内する。

### Step 1: ClaudeCode 自己レビュー（先行）

**目的**: 第 2 段レビュー投入前に自分で差分を読み、明らかな問題をつぶす。

- **使用モデルは Opus**（`model-selection` skill 準拠。品質・判断の精度を優先）。
- **対象**は当該 PR の差分（`git diff <base>...HEAD`）。`code-review` skill の観点（正確性・整合性・読みやすさ・保守性・セキュリティ・破壊的変更/マイグレーションの有無）で見る。ドキュメント PR でも整合性・採番・リンク・矛盾を点検する。
- **マージ権限は与えない**。マージは第 2 段レビューの経路（Codex モード／人間確認）に従う。

1. **まず学習台帳を読む**（`code-review` skill 手順 1。`references/learned-checks.md` の「共通」＋差分クラスの節、ドメイン差分なら `poker-invariant-review` skill）。差分を読む前に読まないと前回と同じ見落とし方を再現する。`reviewer` へ委譲するなら台帳の絶対パスを必須入力で渡す。
2. `git diff <base>...HEAD` で差分を確認する。
3. PRコメント（`## 🤖 Claude Code 自己レビュー`）に **以下の順序** で記述する:
   1. **作業内容**: レビュー結果より前に、このPRで何を変更・修正したかを簡潔に記載する（読み手がレビュー内容を理解する文脈として必要）。
   2. **観点と結果**: 正確性・整合性（設計書・Issue との齟齬）／読みやすさ・保守性／セキュリティ・破壊的変更の有無／ドキュメントPRの場合は採番・リンク・矛盾の有無。
   3. **指摘・残課題**（非ブロッキング含む）
   4. **マージ可否の判断**
4. 問題があれば**第 2 段レビュー前に自分で修正**してプッシュする。指摘の確定（4 状態）と same-root sweep は `references/codex-review.md`「finding の処理」に従う（非 Codex 経路でも同じ規律）。

### Step 2-A: Codex レビュー（Codex 導入環境）

**目的**: 独立した視点で指摘を得る（自己レビューの置き換えではなく多層チェック）。

> **手順の詳細（バックグラウンド実行・監視／`STATUS` 判定表／コメント本体の直読作法／sonnet フォールバックの扱い／長期ループの打ち切り判断）は [`references/codex-review.md`](references/codex-review.md) を一次情報とする。** 本文にはマージ判断に直結する骨子だけ置く。導入手順とスクリプトは [`codex-sample/`](codex-sample/README.md)。

1. **まず必ずモードを確認する（マージ判断の前提・省略禁止）**: `~/bin/codex-mode.sh get /home/ai/project/proj-poker` でモードを解決する（**本体作業ツリーのパスを必ず渡す**。worktree 内で引数を省くと repo 上書きが見えずグローバル既定になる）（解決順: repo上書き > グローバル既定 > `stop`）。**このモード確認を飛ばして、勝手にマージしたり／逆に不要に停止したりしない。** Codex を実行するか・マージするか・自走するか・止まるかは、すべてこのモードで決まる。
2. モードで分岐する:

   | モード | Codex 実行 | マージ | `findings` 時 |
   |---|---|---|---|
   | `stop` | しない | しない | 人間に委ねる（何もしない） |
   | `prereview` | する | **しない** | コメントを残し人間レビューを促す |
   | `review-merge` | する（**記録系 docs だけの差分はスキップ可**） | `clean`（本文の P2 は修正か accept 記録済み）かつ人間確認不要ならマージ | P0 / P1 は修正して再実行。P2 は「finding の処理」の accept か条件付き再レビューで処理 |
   | `autonomous` | する（同上） | 同上 | 修正→プッシュ→再レビューを**最大3回**（各回が別の妥当な指摘なら内容で続行を判断）、未解決なら停止 |

3. 実行〜判定の骨子（詳細は reference）:
   - Codex はバックグラウンド実行し、完了通知＋壁時計タイムアウト（目安 15〜20 分）で監視する。
   - 出力末尾の `STATUS=`（`clean` / `findings` / `halt-tokenlimit` / `error`）で判定し、**`error` / `halt-tokenlimit` はどのモードでもマージ・自走せず**要点を伝えて停止する。
   - **`STATUS` に関わらず、マージ前に必ず PR コメント本体を直読してから判断する**（`STATUS=clean` でも findings が残ることがある）。
   - **Codex レビューを実行したら、結果を必ず自分（Claude 側）で PR コメントに投稿する（`STATUS=clean` でも省略しない）**。コメントには `STATUS`・レビュー観点の結果・対応/残課題・マージ可否を含める（`## 🤖 Codex レビュー結果` 見出し。`gh pr comment <PR番号> --body ...`）。
   - **指摘は即修正せず 4 状態（CONFIRMED / FALSE_POSITIVE / DESIGN_DISAGREEMENT / UNPROVEN）に確定し、CONFIRMED は same-root sweep してから直す。P2 は根拠を記録して見送れる（accept）。修正 push 後の再実行は条件付き**（一次情報は `references/codex-review.md`「finding の処理」）。
   - **記録系 docs（作業ログ・テスト結果・ローカル Issue 記録など、プロジェクトが許可リストで定めたもの）だけの差分は Codex をスキップ**し、自己レビュー＋CI 緑でマージできる（許可リストと記録義務は同 reference「記録系 docs の Codex スキップ」）。
   - 修正をプッシュしたら**必ず自己レビュー（Step 1）をやり直し**、PRコメントを追記する。Codex の再実行は条件付き再レビューの表で決める。
   - 学習 Capture（`review-learning`）の呼び出し位置と規律は reference「学習 Capture の位置」に従う。完了報告に `REVIEW_LEARNING=` を含める。

### Step 2-B: reviewer agent レビュー（Codex 未導入環境）

**目的**: Step 2-A と同じく独立した視点を得る。Codex の代わりに **`reviewer` agent（Opus・読み取り専用・別コンテキスト）** を第 2 段として使う。

> **手順の詳細（差分パッチの用意／必須入力／findings の受け取り方／マージ判断）は [`references/non-codex-review.md`](references/non-codex-review.md) を一次情報とする。**

骨子:

1. 親が `git diff <base>...HEAD > <patch の絶対パス>` で差分を保存し、`reviewer` agent へ**必須入力**（パッチの絶対パス・対象ルート・差分クラス・台帳/チェックリストの絶対パス一覧）を渡す（一次情報は `.claude/agents/reviewer.md`「入力」）。
2. 返ってきた findings を **Codex 経路と同じ規律**で処理する: 4 状態に確定 → CONFIRMED は same-root sweep → 修正 or P2 accept → 条件付き再レビュー（`references/codex-review.md`「finding の処理」を流用）。
3. 結果を `## 🤖 第 2 段レビュー結果（reviewer agent）` 見出しで PR コメントに投稿する（指摘なしでも省略しない）。
4. **マージは人間確認が既定**（`codex-mode` 相当の自動マージ判定を持たない）。P0 / P1 が無く「必ず人間確認で停止する条件」に該当しない場合でも、ユーザーが明示的に自動マージを許可したセッションでのみマージしてよい。
5. 学習 Capture（`review-learning`）の位置は Codex 経路と同じ。

### 必ず人間確認で停止する条件（一次記述・review-merge / autonomous / 完全自走 共通）

以下に該当する場合は、自動マージも自走修正もせず、要点を明示したコメントを残して止める。

- 破壊的 / 不可逆な操作・変更（`git push --force`・履歴破壊・本番相当データ削除を含む。force push・main 直 push・`reset --hard`・`gh repo delete` 等は `settings.json` の `permissions.ask` に登録しておくと人間プロンプトになる。ユーザーの明示依頼があれば承認して通してよいが、自走中に書き方を変えて迂回しない）
- スキーマ変更・マイグレーション
- セキュリティ・認証/認可・権限・課金に関わる変更・判断
- 設計判断・アーキテクチャ上のトレードオフ・設計の根本変更
- 要件の曖昧さ・前提の不確実性（要件の前提が崩れた場合を含む）
- `docs/decision_log.yaml` の採用済み判断の変更・Open Item（`docs/11_OPEN_ITEMS.md`）の永久確定（`decision-log` skill）
- 新たな人間判断なしの非目標の導入（Auth・Tenant・Cloud DB・SaaS・Online Multiplayer・Voice・3D・Real Money。`docs/00` §6・`docs/03` §11）
- 秘密情報（API キー・`.env*`・トークン）のコミット・露出
- docs が定める停止ゲート（親 #2 の実装開始 Gate 等）の解除

### マージできなかった場合の停止ルール

何らかの理由（人間確認待ち・findings が3回で解消しない等）でマージが完了しなかった場合は、**次の Issue の実装に入らず停止する**（依存・領域が重複する実装の並走は差分ベースを変えてレビューを不安定にするため。「並行実装が許されるのは『独立した作業』のみ」参照）。

停止時のPRコメントには以下を必ず含める:

1. **停止理由**: なぜマージできなかったか
2. **次にすべき作業**: マージが完了した後に次に着手するIssue/作業名を明記する

---

## マージ前のローカル品質チェック

CI（`.github/workflows/ci.yml`）は push / PR ごとに `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm format:check` を実行する。**PR を上げる前とマージ前に、同じ 4 つをルートで通す**（一覧は `CLAUDE.md`「品質チェック」）。Poker Engine を触る PR は、決定論テスト（`poker-engine-testing` skill）が通ることを必須とする。

- `format:check`（= `prettier --check .`）はリポジトリ全体を見るので、自分の差分と無関係なファイルの崩れでも赤になる。整形の適用は `pnpm format`。対象外（`*.md`・`.claude`・`docs/research`・`pnpm-lock.yaml`・`dist` など）は `.prettierignore` が一次情報。
- **Prettier は厳密固定版**（`package.json` にキャレット無し）。必ず `pnpm format` / `pnpm format:check` を使う。
- **pre-commit hook は無い**（D69）。コミット時の自動整形は無いので、上の 4 つを手で通すことがローカルでの唯一の担保になる。
- **Node / pnpm の版も CI と揃える**: Node は `.nvmrc`（24）と `engines.node`、pnpm は `packageManager`（`corepack enable` で解決）。

> 背景: branch protection（必須チェック）が使えない場合、CI が赤でもマージを機械的にはブロックできない。そのぶん「マージ前に 4 つを通す」運用と、マージ前の `gh pr checks` の直読で担保する。

---

## コミットメッセージ

以下のprefixを使う。

- `feat:`
- `fix:`
- `docs:`
- `refactor:`
- `test:`
- `chore:`
- `infra:`

## PR説明文の構成

PR説明文には以下のセクションを使う。必須・任意を状況に応じて判断すること。

| セクション | 要否 | 内容 |
|---|---|---|
| `## Summary` | 必須 | 変更の目的と概要を箇条書きで記載 |
| `## Test plan` | 必須 | 動作確認の手順・チェックリスト |
| `## Risk` | 任意 | 破壊的変更・副作用・影響範囲など、レビュアーが注意すべきリスク。リスクがない・軽微な場合は省略 |
| `## Review Required` | 任意 | レビュアーに特に確認してほしい箇所や観点。設計判断・セキュリティ・パフォーマンス等。特になければ省略 |

`Risk` と `Review Required` はセクションが不要な場合は省略する。無理に埋めない。

## Issue / PR タイトル規約（相互参照）

proj-poker のタイトル接頭辞は `[PhaseN]`（Phase 0〜8）/ `[横断]` / `[Parent]`。命名の一次情報・具体例はプロジェクトの `CLAUDE.md` 側に一元化する（本 skill と CLAUDE.md で二重管理しない）。

---

## 常時適用ルール（フローの全工程で守る）

### 完了報告前検証・ツール出力破損時の停止

> **このルールは hook が機械的に注入する実行前ガードとは別レイヤーで動作する。** hook＝機械的注入（コミット前の自動整形・pre-commit チェックなど）、本ルール＝「完了を断言してよいか」の Claude 自身の判断規律。両方が必要で相互補完の関係にある。

**完了報告前に実出力を必ず引用する**: Issue 作成・PR 作成・コミット・マージの完了を報告するときは、コマンドの実出力から得た URL / 番号 / ハッシュを必ず引用してから「完了」と述べる。

| 操作 | 引用すべき実出力 |
|---|---|
| Issue 作成 | `gh issue create` の出力 URL（例: `https://github.com/takumi-sano22/proj-poker/issues/NNN`） |
| PR 作成 | `gh pr create` の出力 URL |
| コミット | `git commit` の出力ハッシュ（例: `[docs/123 ff127b9]`） |
| マージ | `gh pr view <N> --json state,mergedAt,mergeCommit` の結果（`state: MERGED` と `mergeCommit.oid` を確認） |

**引用できない場合は「完了」と言わない。** 実行した証拠がなければ「まだ確認中」と述べ、再検証コマンドを実行してから報告する。

**ツール出力が破損・空・矛盾した場合は停止して再検証する**: コマンドの出力が文字化け・空・または期待と矛盾している場合は、**成功を仮定せず停止する**。以下の再検証コマンドで実体を確認してから続行する。

| 確認したい対象 | 再検証コマンド |
|---|---|
| ローカル git 状態 | `git status` |
| 直近コミット | `git log --oneline -5` |
| PR のマージ実体 | `gh pr view <N> --json state,mergedAt,mergeCommit` |
| PR 一覧 | `gh pr list` |
| Issue の状態 | `gh issue view <N>` |

再検証で状態が確認できるまで「完了」と言わない。再検証コマンドも失敗した場合は、その旨をユーザーに伝えて停止する。

> **マージ実体確認の第一手は `gh pr view <N> --json state,mergedAt,mergeCommit`（API 直読）**。GitHub readonly MCP（`mcp__github__pull_request_read` 等）を導入していれば同じ一次情報を読める（gh の GraphQL レート制限時の代替にもなる）。`gh pr merge` 直後はローカル追跡参照（`origin/main`）が古く残ることがある。`git pull` 後の追跡参照だけで「マージ済み」を断定しない。

### 長時間処理の進捗可視化（沈黙しない）

> **背景**: 利用分析で実ユーザープロンプトの 10% が「止まっていないか」等の中断・停止確認だった。長時間処理の進捗が見えないとユーザーの監視コストになる。Stop hook（未コミット通知）と相互補完で、進捗を可視化して中断確認の負担を下げる。

**チェックポイント分割と進捗報告**:

- **大きな作業は段階に分ける**。各段の着手時に `TaskUpdate` で `in_progress` にし、完了時に `completed` にする（`TaskCreate`/`TaskUpdate` は進捗可視化の主手段）。
- **数分かかる処理の前に「これから何をするか」を1行宣言**し、待ち時間中も「何を待っているか」を明示する（例: 「Codex レビューをバックグラウンド実行中。完了通知待ち」）。無言で長時間ブロックしない。
- 各チェックポイントで**結論を先に短く報告**してから次へ進む（途中経過を溜め込んで最後に一括報告しない）。

**バックグラウンド実行＋完了通知の活用**:

- **時間のかかるコマンド（Codex レビュー・ビルド・長いテスト・大量 fetch 等）は `run_in_background` で実行**し、完了通知で再開する。前景で長時間ブロックしない（ターミナル出力の不安定さ＝最大の摩擦源への防衛）。
- バックグラウンド実行は**壁時計タイムアウト（目安 15〜20 分）でも監視**し、無反応なら状態を確認して報告する（Codex 監視手順は `references/codex-review.md`）。
- サブエージェントを `run_in_background` で回す場合も、完了通知を待つ間に親が別の独立作業を進めてよいが、**着手中の作業と進捗は都度可視化**する。

**進捗の永続化**: まとまった作業は作業ログ（`task-log` skill）に記録し、セッションをまたいでも進捗・残課題を追えるようにする。中断・再開時の「どこまで進んだか」の再確認コストを下げる。
