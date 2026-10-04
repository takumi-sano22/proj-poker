#!/usr/bin/env bash
# Stop hook（command 型・軽量）: 応答終了時に未コミット変更・未 push コミットを検知し、
# systemMessage で「非ブロッキングの注意」を返す。
#
# 設計方針:
#   - agent 型は使わない（毎ターンのトークン増を回避する確定事項）。git 参照だけで外部通信も重い処理もしない。
#   - decision:block ではなく systemMessage を使う。応答を止めて追加ターンを強制すると開発中の
#     中間状態（意図的な WIP）でも毎回ループしトークンを食うため、止めずに気づきだけ与える設計にする。
#   - 目的は「完了報告の前に、実体（コミット/push 状態）を確認する」ための軽い注意喚起。
set -uo pipefail

# --- git リポジトリ外なら何もしない（冪等・安全側） ---
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

NOTES=""

# --- 未コミット変更（追跡・未追跡どちらも検知） ---
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  NOTES="${NOTES}- 未コミットの変更があります（git status で確認）。\n"
fi

# --- 未 push コミット: upstream があれば upstream 比較、無ければ origin/main と比較 ---
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -n "$UPSTREAM" ]; then
  AHEAD="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
else
  AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
fi
if [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null; then
  NOTES="${NOTES}- 未 push のコミットが ${AHEAD} 件あります。\n"
fi

# --- 検知が無ければ静かに終了（何も出力しない） ---
if [ -z "$NOTES" ]; then
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
MSG="【未確定の作業があります（Stop hook）】ブランチ ${BRANCH}\n${NOTES}完了報告の前に、コミット/push の要否を確認してください。"

# --- systemMessage（非ブロッキング）で出力。printf %b で \n を実改行に展開し python3 で JSON 化 ---
printf '%b' "$MSG" | python3 -c '
import json, sys
print(json.dumps({"systemMessage": sys.stdin.read()}))
'
