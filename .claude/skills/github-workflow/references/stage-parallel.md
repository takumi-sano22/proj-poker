# 大規模Issue の Stage 分割並列実装（詳細）

`github-workflow` skill「実装作業は subagent に委譲する」を、複数 Stage の**並列**実行にスケールさせた運用の一次情報。「軽微な UI 修正」のような複合 Issue を一気に進める場合、**親 Issue を Stage に分割 → サブ Issue を起票 → 独立 Stage は subagent を並列起動 → 完了通知で次 Stage を起動** のパターンが効果的。

> **前提**: subagent への渡し方の基本（入力・前提・出力形式・モデル・agentType）は SKILL.md「実装作業は subagent に委譲する」に従う。本書はそれに**上乗せ**する Stage 並列固有の運用を持つ。

## 分割の判断基準

1. **触るファイル/領域の独立性マトリクス**を最初に作る（縦軸 Stage × 横軸主要ファイル）
2. ファイル衝突する Stage は **順次**、衝突しない Stage は **並行**
3. 「後の Stage が前の Stage の挙動を踏まえる必要がある」場合（最適化など）は **最後に固める**
4. 1 Stage = 1 PR を守る。Stage 内のサブ項目（A1/A2/A3）は同 PR で OK

## Stage Issue の本文に必ず含める要素

- **スコープ**: 親 Issue のどの項目を担当するか
- **採用方針（壁打ち確定値）**: 数値・色・配置などをすべて明記（subagent は会話履歴を持たない）
- **影響ファイル**: 想定されるファイルパス
- **受け入れ基準**: チェックボックス形式
- **並行可否・依存**: どの Stage と並行可・どの Stage の後でないと着手不可
- **関連**: 親 Issue 番号・直前 Stage の PR 番号

## subagent prompt の必須項目（脱落しがち）

SKILL.md「実装作業は subagent に委譲する」の渡し方に加え、**Stage 並列運用ではさらに以下を必ず明記**（脱落しがち）:

1. **第 2 段レビューの経路**: Codex 導入環境なら `codex-review.sh` のフルパス（`~/bin/codex-review.sh`。**`~/bin` は PATH に無い**ため、名前だけでは `which`/`find` でも拾えず実行できない）を明示。明記しないと subagent が「見つからない」と判定して Codex をスキップする事故が起きる。未導入環境なら `reviewer` agent 経路（`references/non-codex-review.md`）であることを明示
2. **直前 Stage の改修点**: 「どのファイルの実装方針・定数値をどう変えたか」など、後続 Stage が踏まえるべき差分前提を必ず明示
3. **採用方針（壁打ち確定値）**: 数値・色・配置を全て prompt 内に書く
4. **ドメイン不変条件の継承**: 情報境界（KnowledgeState）・決定論（乱数 seed 注入・Chip 整数）・Hindsight Leak 防止を各 Stage の Worker briefing に明記する（`AGENTS.md` 1〜2 節・`code-review` H 節）
5. **完了報告フォーマット**: PR 番号・マージ状態・第 2 段レビュー結果（`REVIEW2=`）・残課題

## 並列起動の実例パターン

```
[worktree A] Stage A → 完全独立 → background subagent (Sonnet/Opus 適宜)
[worktree B] Stage B → 完全独立 → background subagent  } 並列
[worktree E] Stage E → 完全独立 → background subagent  /
       ↓ 3 つの完了通知を待つ（順不同）
[worktree C] Stage C → D と Pond/* 衝突 → 順次（C 完了後）
       ↓
[worktree D] Stage D → C のマージを踏まえる
       ↓
[worktree F] Stage F → C/D/E の挙動を踏まえる → 最後
```

## subagent モデル選択（ユーザー指示「Opus メイン・難しくない作業は Sonnet/Haiku」）

基準は SKILL.md（Step 0 のモデル選択・委譲先エージェント表）と同じ。Stage 並列での目安:

- **Opus**: 判断要素が多い（ToolRouter 設計・shader 全面改修・パフォーマンス監査・複数ライブラリ統合）
- **Sonnet**: CSS / 数値変更 / 既存パターン流用・小〜中規模リファクタ
- **Haiku**: 軽微・1〜3 行修正
- 迷ったら Opus にして安全側（トークン量は監査結果に追記）

## Issue 起票の prefix 規約再掲

- 親 Issue: `[PhaseN] ...`（タイトル規約は `CLAUDE.md`）
- サブ Issue: 親と同じ prefix を継承

## 1 セッション中に複数 PR を回す際のマージ衝突対策

- 各 Stage 完了通知の度に `git fetch origin main && git pull origin main --ff-only` を実行
- subagent が `git worktree add ... origin/main` で最新基点を取る
- 残った worktree は `git worktree remove --force` でクリーンアップ（subagent が忘れることがある）
