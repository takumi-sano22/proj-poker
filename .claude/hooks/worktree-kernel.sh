#!/usr/bin/env bash
# worktree 内で起動したセッションと、その subagent に、claudeMdExcludes で読まれない CLAUDE.md を補う。
#
# なぜ:
#   .claude/settings.json の claudeMdExcludes は、本体で起動したセッション（と subagent）が worktree 内のファイルを
#   読んだときに、その worktree の CLAUDE.md が二重に常駐するのを防ぐ。ただし同じ除外は worktree の中で起動した
#   セッションにも当たり、プロジェクトの CLAUDE.md が 1 つも読まれなくなる（祖先にある本体の CLAUDE.md も読まれない。
#   settings.local.json も本体と共有されるため、置き場所では避けられない）。
#   さらにカスタム subagent は「親が読み込んだ CLAUDE.md」を起動時に受け取る仕組みなので、SessionStart で親に
#   注入しただけでは subagent に届かない（Codex 指摘・実測で確認）。そこで次の 2 経路で注入する。
#     section        : SessionStart 用。session-start-context.sh が注入本文へ連結する（プレーンテキスト）
#     subagent-start : SubagentStart 用。hookSpecificOutput.additionalContext で subagent へ渡す（JSON）
#
# 設計:
#   - 判定は起動位置（CLAUDE_PROJECT_DIR）で行う。本体で起動したセッションは、途中で worktree へ cd していても
#     本体の CLAUDE.md を読み込み済みで subagent にも渡るため、何も出さない（二重にしない）
#   - 組み込みの Explore / Plan はもともと CLAUDE.md を読まない設計なので、subagent-start では注入しない
#   - 判定できない・読めないときも hook としては失敗させない（exit 0）。CLAUDE.md が見つからなければ警告文を出す
set -uo pipefail

mode="${1:-section}"
base="${CLAUDE_PROJECT_DIR:-$PWD}"
top="$(cd "$base" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)" || top=""

# 起動位置が worktree のときだけ、注入する本文を出力する（それ以外は何も出さない）
section() {
  case "$top" in
    */.claude/worktrees/*) ;;
    *) return 0 ;;
  esac
  if [ -f "$top/CLAUDE.md" ]; then
    printf '\n\n【worktree 内で起動したため、claudeMdExcludes で読まれない CLAUDE.md を hook が注入: %s/CLAUDE.md】\n' "$top"
    cat "$top/CLAUDE.md"
  else
    # 補えないときは黙らず、Claude 自身に読ませる
    printf '\n\n【警告】worktree 内で起動したが %s/CLAUDE.md が見つからない。プロジェクトの CLAUDE.md が読み込まれていないので、作業前に本体の CLAUDE.md を Read すること。\n' "$top"
  fi
}

case "$mode" in
  section)
    section
    ;;
  subagent-start)
    agent_type="$(python3 -c 'import json, sys
try:
    print(json.load(sys.stdin).get("agent_type") or "")
except Exception:
    print("")')"
    case "$agent_type" in Explore|Plan) exit 0 ;; esac
    text="$(section)"
    [ -n "$text" ] || exit 0
    printf '%s' "$text" | python3 -c 'import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SubagentStart", "additionalContext": sys.stdin.read().lstrip("\n")}}, ensure_ascii=False))'
    ;;
esac
exit 0
