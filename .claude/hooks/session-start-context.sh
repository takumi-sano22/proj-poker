#!/usr/bin/env bash
# SessionStart hook（command 型）: この環境固有の注意事項を additionalContext として Claude に注入する。
#
# なぜ:
#   セッションごとの個体差で繰り返していた誤り
#     - Codex ツールが ~/bin にあり非対話シェルの PATH 外にあるため「未導入」と誤結論
#     - worktree と本体作業ツリーの取り違え
#     - 完了報告前の実体（コミット/push 状態）未確認
#   を、毎セッション先頭に同じ環境情報を機械注入して予防する（CLAUDE.md 記載だけに頼らず確実に効かせる）。
set -euo pipefail

# --- 動的情報: 現在地とブランチ（worktree 取り違え防止のため実体を先頭に提示する） ---
CWD="$(pwd)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(git 管理外)')"

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# --- worktree 内で起動したセッションへの CLAUDE.md の補完 ---
# claudeMdExcludes で worktree の CLAUDE.md を除外しているため、worktree の中で起動したセッションには
# プロジェクトの CLAUDE.md が 1 つも読まれない。起動位置が worktree のときだけ本文を補う（判定と理由は
# worktree-kernel.sh。subagent へは SubagentStart から同じスクリプトで渡す）。
# SessionStart は startup / resume / clear / compact のすべてで走るため、/compact 後も再注入される。
KERNEL_SECTION="$(bash "${HOOK_DIR}/worktree-kernel.sh" section 2>/dev/null || true)"

# --- 注入本文（静的な環境規約 + 動的な現在地） ---
read -r -d '' CONTEXT <<EOF || true
【この環境の注意（SessionStart hook が機械注入）】
- 現在の作業ディレクトリ: ${CWD}
- 現在のブランチ: ${BRANCH}
  → コミット/ブランチ操作の前に、ここが意図した worktree かを必ず確認すること。

1. Codex ツールは ~/bin にあり非対話シェルの PATH に無い。
   ~/bin/codex-mode.sh / ~/bin/codex-review.sh は必ずフルパスで呼ぶ（既定モードは autonomous。worktree 内では get /home/ai/project/proj-poker と本体パスを渡す）。
   which で拾えなくても未導入と誤結論しない。未導入なら github-workflow の reviewer agent 経路を使う。
2. 実装は原則 worktree（.claude/worktrees/<branch>・main 基点）で行う。
   本体作業ツリーで git checkout -b しない。着手前に cwd を確認する。
3. proj-poker は「人間判断はセッション冒頭の AskUserQuestion 1 回 → 以降は完全自走」が既定。
   docs/decision_log.yaml の採用済み判断の変更・Open Item の永久確定は自走中でも停止して人間に返す。${KERNEL_SECTION}
EOF

# --- additionalContext として JSON 出力（安全なエスケープのため python3 で JSON 化） ---
printf '%s' "$CONTEXT" | python3 -c '
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": sys.stdin.read(),
    }
}))
'
