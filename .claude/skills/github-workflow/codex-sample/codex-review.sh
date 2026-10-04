#!/usr/bin/env bash
# Codex による PR レビュー実行スクリプト。
#
# 処理:
#   1. codex exec --sandbox read-only review --base <base> でレビュー（ヘッドレス・読み取り専用）
#   2. レビュー本文を gh pr comment で PR に投稿
#   3. 出力中の [P0]/[P1] タグの有無でマージ可否を判定
#   4. トークン/レート制限を best-effort 検出し、codex-on-tokenlimit に従って
#      sonnet フォールバック（既定）または停止
#
# 標準出力の末尾に機械可読の状態を出す（呼び出し側 = github-workflow skill 用）:
#   REVIEWER=codex|sonnet
#   STATUS=clean|findings|halt-tokenlimit|error
#   POST=ok|failed|skipped|none      PR コメント投稿の結果
#   POST_BODY_FILE=<path>            POST=failed のときだけ出る（本文の保存先）
#   SCRIPT_VERSION=<x.y.z>           このスクリプトの版（配置済みの版が古くないかの照合用）
#
# このスクリプトの正は sano-rag リポジトリの .claude/tools/ にある（#103）。
# ~/bin へは .claude/tools/install.sh で配置する。直接 ~/bin のものを編集しない
# （編集してもリポジトリに残らず、次の install.sh で上書きされる）。
#
# STATUS と POST は独立している。レビュー自体は成功しても投稿だけ失敗しうるため、
# STATUS=clean/findings でも POST=failed なら「指摘の本文が PR に残っていない」状態で、
# 呼び出し側は POST_BODY_FILE を読んで自分で投稿し直す必要がある。
#
# 終了コード:
#   0  = clean（P0/P1 なし → マージ可）
#   10 = findings（P0/P1 あり → 要修正）
#   20 = halt-tokenlimit（制限到達 & ポリシー=stop → 人間確認）
#   1  = error
#
# 使い方:
#   codex-review.sh [--base <branch>] [--pr <number>] [--dry-run]
#
# 注意: -e は使わない（codex の非 0 終了を自前でハンドルするため）。
set -uo pipefail

# このスクリプト自身の版。.claude/tools/ の実体と ~/bin の配置物がズレていないかを
# 呼び出し側（github-workflow skill）が照合するために出力する。
CODEX_REVIEW_VERSION="1.0.2"

log() { echo "[codex-review] $*" >&2; }
usage() { echo "usage: codex-review.sh [--base <branch>] [--pr <number>] [--dry-run]"; }

# ─────────────────────────────────────────────────────────
# 純粋関数（source して単体テスト可能）
# ─────────────────────────────────────────────────────────

# レビュー本文に P0/P1 指摘が含まれるか（codex は行頭に [P0]/[P1] を付ける）
codex_review_has_findings() {
  local f="${1:-}"
  [ -f "${f}" ] || return 1
  grep -Eq '\[P[01]\]' "${f}"
}

# トークン/レート制限の痕跡を best-effort 検出。
# codex は制限到達を示す安定した終了コード/フィールドを公式提供していないため、
# 出力テキストのパターンマッチで判定する（汎用的な表現を採用）。
# codex のバージョン更新で文言が変わった場合に備え、CODEX_TOKENLIMIT_PATTERN
# 環境変数で検出パターンを上書きできる（コード修正なしで追従可能）。
CODEX_TOKENLIMIT_PATTERN_DEFAULT='usage limit|rate limit|quota|too many requests|429|reached[^.]*limit|context length exceeded|out of tokens'
codex_review_is_tokenlimit() {
  local f="${1:-}"
  [ -f "${f}" ] || return 1
  grep -Eiq "${CODEX_TOKENLIMIT_PATTERN:-${CODEX_TOKENLIMIT_PATTERN_DEFAULT}}" "${f}"
}

# ─────────────────────────────────────────────────────────
# source 時は関数提供のみで終了
# ─────────────────────────────────────────────────────────
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0
fi

# ─────────────────────────────────────────────────────────
# 引数
# ─────────────────────────────────────────────────────────
BASE=""
PR=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      # 値の検証をせずに shift 2 すると、値なしで末尾に置かれたとき引数が減らず無限ループする。
      [ $# -ge 2 ] || { log "--base には値が必要です。"; usage >&2; exit 1; }
      BASE="$2"; shift 2 ;;
    --pr)
      [ $# -ge 2 ] || { log "--pr には値が必要です。"; usage >&2; exit 1; }
      PR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         log "unknown arg: $1"; shift ;;
  esac
done

# PR コメント投稿の結果（none=未投稿 / ok / failed / skipped=--dry-run）。
# 一時ディレクトリは trap で消えるため、投稿に失敗した本文はここへ退避する。
POST_STATE="none"
SAVED_BODY=""

# 投稿に失敗した本文を、終了時に消えない場所へ保存してパスを返す。
save_body_on_failure() {
  local body_file="$1"
  local dest_dir="${CODEX_REVIEW_SAVE_DIR:-${HOME}/.cache/codex-review}"
  mkdir -p "${dest_dir}" 2>/dev/null || return 1
  local dest="${dest_dir}/pr-${PR:-unknown}-$(date +%Y%m%d-%H%M%S).md"
  cp "${body_file}" "${dest}" 2>/dev/null || return 1
  echo "${dest}"
}

emit_status() {
  echo "REVIEWER=${REVIEWER}"
  echo "STATUS=${1}"
  echo "POST=${POST_STATE}"
  echo "SCRIPT_VERSION=${CODEX_REVIEW_VERSION}"
  if [ "${POST_STATE}" = "failed" ] && [ -n "${SAVED_BODY}" ]; then
    echo "POST_BODY_FILE=${SAVED_BODY}"
  fi
}

# ─────────────────────────────────────────────────────────
# codex-mode.sh を読み込み（トークン制限時ポリシー取得）
# ─────────────────────────────────────────────────────────
TOKENLIMIT_POLICY="sonnet"
_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for _cand in "${_self_dir}/codex-mode.sh" "${HOME}/bin/codex-mode.sh"; do
  if [ -f "${_cand}" ]; then
    # shellcheck disable=SC1090
    source "${_cand}"
    TOKENLIMIT_POLICY="$(codex_tokenlimit_get 2>/dev/null || echo sonnet)"
    break
  fi
done

# ─────────────────────────────────────────────────────────
# base / pr の解決
# ─────────────────────────────────────────────────────────
if [ -z "${BASE}" ]; then
  BASE="$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || true)"
  [ -z "${BASE}" ] && BASE="main"
fi
if [ -z "${PR}" ]; then
  PR="$(gh pr view --json number -q .number 2>/dev/null || true)"
fi

REVIEWER="codex"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
REVIEW_OUT="${WORK}/review.out"   # codex の stdout（最終レビュー本文）
RUN_LOG="${WORK}/run.log"         # codex の stderr（進捗・エラー）
COMBINED="${WORK}/combined.log"   # 制限検出用に stdout+stderr 結合
FINAL_MD="${WORK}/final.md"       # PR 投稿用（ヘッダ付き）

# PR へコメント投稿（--dry-run 時は標準エラーに表示するだけ）。
# 失敗しても呼び出し側が気づけるよう POST_STATE / SAVED_BODY に結果を残す。
post_comment() {
  local body_file="$1"
  if [ "${DRY_RUN}" -eq 1 ]; then
    log "[dry-run] PR コメント投稿をスキップ。本文 ↓"
    cat "${body_file}" >&2
    POST_STATE="skipped"
    return 0
  fi
  if [ -z "${PR}" ]; then
    log "PR 番号を特定できないため投稿できません。"
    POST_STATE="failed"
    SAVED_BODY="$(save_body_on_failure "${body_file}")"
    [ -n "${SAVED_BODY}" ] && log "レビュー本文を保存しました: ${SAVED_BODY}"
    return 1
  fi

  # 1st: gh pr comment（GraphQL を使う）
  if gh pr comment "${PR}" --body-file "${body_file}"; then
    POST_STATE="ok"
    return 0
  fi
  log "gh pr comment に失敗しました。REST で再試行します（GraphQL だけが制限されている場合に通る）。"

  # 2nd: REST API へフォールバック
  local repo
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [ -n "${repo}" ] && gh api "repos/${repo}/issues/${PR}/comments" -F "body=@${body_file}" >/dev/null; then
    log "REST でのコメント投稿に成功しました。"
    POST_STATE="ok"
    return 0
  fi

  # 3rd: どちらも失敗。本文を消さずに残し、標準エラーで知らせる。
  POST_STATE="failed"
  SAVED_BODY="$(save_body_on_failure "${body_file}")"
  if [ -n "${SAVED_BODY}" ]; then
    log "コメント投稿に失敗しました。レビュー本文を保存しました: ${SAVED_BODY}"
  else
    log "コメント投稿に失敗し、本文の保存にも失敗しました。本文は失われます。"
  fi
  return 1
}

# ─────────────────────────────────────────────────────────
# codex 実行
# ─────────────────────────────────────────────────────────
if ! command -v codex &>/dev/null; then
  log "codex が見つかりません。"
  emit_status error; exit 1
fi

# review サブコマンドの基底ブランチ指定方法は codex のバージョンで変わる
# （過去に位置引数 base-branch → フラグ --base へ仕様変更された実績がある）。
# 想定する --base が使えない場合、原因不明な引数エラーで失敗する前に
# バージョン不整合として明確なメッセージを出して止める。
if ! codex exec review --help 2>&1 | grep -q -- '--base'; then
  log "現在の codex（$(codex --version 2>/dev/null || echo '版数不明')）は 'codex exec review --base' に未対応です。"
  log "codex CLI の仕様変更が疑われます。codex-review.sh の基底ブランチ指定を現行 CLI のフラグに合わせて更新してください。"
  emit_status error; exit 1
fi

# sandbox を read-only に固定する（利用者のトップレベル config が workspace-write 等でも、レビュー中に
# 作業ツリーが変わらないことを構造的に保証する。プロファイル（[profiles.review]）の有無に依存させない）。
log "codex exec --sandbox read-only review --base ${BASE} を実行..."
codex exec --sandbox read-only review --base "${BASE}" >"${REVIEW_OUT}" 2>"${RUN_LOG}"
CODEX_RC=$?
cat "${REVIEW_OUT}" "${RUN_LOG}" > "${COMBINED}" 2>/dev/null || true

# ─────────────────────────────────────────────────────────
# トークン制限の検出とフォールバック
# ─────────────────────────────────────────────────────────
if [ "${CODEX_RC}" -ne 0 ] && codex_review_is_tokenlimit "${COMBINED}"; then
  log "トークン/レート制限を検出しました（ポリシー=${TOKENLIMIT_POLICY}）。"

  # ポリシー=stop: 自走を止め、人間確認を促すコメントを残す
  if [ "${TOKENLIMIT_POLICY}" = "stop" ]; then
    {
      echo "## Codex レビュー: トークン制限のため停止"
      echo
      echo "Codex がトークン/レート制限に達しました。設定 \`codex-on-tokenlimit=stop\` のため、自動処理を停止します。人間によるレビューをお願いします。"
    } > "${FINAL_MD}"
    # 失敗は post_comment 内で POST_STATE に記録し、emit_status で呼び出し側へ伝える。
    post_comment "${FINAL_MD}"
    emit_status halt-tokenlimit; exit 20
  fi

  # ポリシー=sonnet: Claude(sonnet) で代替レビューを生成
  REVIEWER="sonnet"
  if ! command -v claude &>/dev/null; then
    log "claude が見つからず sonnet フォールバック不可。"
    emit_status error; exit 1
  fi
  log "sonnet フォールバックで代替レビューを生成..."
  DIFF="${WORK}/diff.patch"
  git diff "${BASE}...HEAD" >"${DIFF}" 2>/dev/null \
    || git diff "origin/${BASE}...HEAD" >"${DIFF}" 2>/dev/null \
    || git diff HEAD~1 >"${DIFF}" 2>/dev/null \
    || : > "${DIFF}"

  SONNET_OUT="${WORK}/sonnet.out"
  {
    echo "あなたはコードレビュアーです。以下の diff をレビューし、重大度の高い指摘のみを日本語で挙げてください。"
    echo "各指摘は行頭に [P0]（リリース/運用を止める致命的）または [P1]（次サイクルで対応すべき重要）のタグを付けてください。"
    echo "問題がなければ「指摘なし」とだけ書いてください。"
    echo
    echo '```diff'
    cat "${DIFF}"
    echo '```'
  } | claude -p --model sonnet >"${SONNET_OUT}" 2>>"${RUN_LOG}"
  if [ $? -ne 0 ]; then
    log "sonnet レビュー生成に失敗しました。"
    emit_status error; exit 1
  fi

  {
    echo "## Codex レビュー（sonnet フォールバック）"
    echo
    echo "> Codex がトークン制限に達したため、Claude(sonnet) が代替レビューを行いました。"
    echo
    cat "${SONNET_OUT}"
  } > "${FINAL_MD}"
  # 失敗は post_comment 内で POST_STATE に記録し、emit_status で呼び出し側へ伝える。
  post_comment "${FINAL_MD}"

  if codex_review_has_findings "${SONNET_OUT}"; then
    emit_status findings; exit 10
  else
    emit_status clean; exit 0
  fi
fi

# ─────────────────────────────────────────────────────────
# 制限以外の実行エラー
# ─────────────────────────────────────────────────────────
if [ "${CODEX_RC}" -ne 0 ]; then
  log "codex exec review が失敗しました (rc=${CODEX_RC})。"
  cat "${RUN_LOG}" >&2
  emit_status error; exit 1
fi

# ─────────────────────────────────────────────────────────
# 正常: レビュー投稿 + P0/P1 判定
# ─────────────────────────────────────────────────────────
[ -s "${REVIEW_OUT}" ] || echo "（レビュー本文が空でした）" > "${REVIEW_OUT}"
{
  echo "## Codex レビュー"
  echo
  cat "${REVIEW_OUT}"
} > "${FINAL_MD}"
# 失敗は post_comment 内で POST_STATE に記録し、emit_status で呼び出し側へ伝える。
post_comment "${FINAL_MD}"

if codex_review_has_findings "${REVIEW_OUT}"; then
  emit_status findings; exit 10
else
  emit_status clean; exit 0
fi
