#!/usr/bin/env python3
"""PreToolUse hook（matcher: Bash）: subagent からの `gh pr merge` だけを deny する。

なぜ: 並列 subagent がレビューを経ずに PR をマージした事故があった。最終マージは親セッションの持ち分。
設計: 判定は「subagent 由来（入力に agent_id / agent_type がある。公式 docs hooks.md: subagent 呼び出し時のみ付く）かつ
      コマンド文字列に単語 `gh` と単語 `merge` が共に現れる、または REST の `pulls/<n>/merge` を含む」だけ。
      形の列挙ではなく共起で判定する（列挙は必ず抜ける）。この hook は協力的な subagent の誤操作を止める安全弁で、
      意図的な迂回（シェルの引用符分割等）は契約文（agents の「共通契約」）と親だけがマージ権限を持つ運用が受ける。
      `git push origin HEAD:main` 等の他経路は permissions（ask 化）と契約文が受ける。
      それ以外は何も出力せず exit 0（pass）。判定不能・例外は pass（fail-open。止めるのはこの 1 形だけ）。
      親セッションからの merge には影響しない。承認プロンプトは増やさない。
"""
import json
import re
import sys


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    if not (data.get("agent_id") or data.get("agent_type")):
        return 0  # 親セッションからの呼び出し
    command = str((data.get("tool_input") or {}).get("command", ""))
    # 止める形（コマンド文字列のどこにあっても・構造で判定する）:
    #   - 同じコマンド文字列に単語 `gh` と単語 `merge` が共に現れる（`gh pr merge` / `gh pr --repo o/r merge` /
    #     `bash -lc 'gh pr merge'` / `/usr/bin/gh … merge` / `G=gh; $G pr merge` をすべて含む）
    #   - REST の `pulls/<n>/merge`
    # サブコマンドとオプションの並びを列挙しない（列挙は必ず抜ける）。`gh pr comment --body "merge"` のような
    # 文字列中の一致も deny になるが安全側として受け入れる（subagent はマージに触れるコマンドを打たない前提）。
    # `git merge` 単独（gh を含まない）は止めない。
    has_gh = re.search(r"(^|[^\w-])gh(?![\w-])", command) is not None
    has_merge = re.search(r"(^|[^\w-])merge(?![\w-])", command) is not None
    if not ((has_gh and has_merge) or re.search(r"pulls/\d+/merge\b", command)):
        return 0
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        "subagent からの gh pr merge は禁止（最終マージは親セッションの持ち分）。"
                        "merge-ready で止めて PR 番号と HEAD を親へ返してください。"
                    ),
                }
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
