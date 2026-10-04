#!/usr/bin/env bash
# Codex レビューモードの状態管理ライブラリ。
# source して関数を使うか、直接実行してサブコマンドで呼ぶ（両対応）。
#
# モード値          : stop | prereview | review-merge | autonomous
# トークン制限時挙動: sonnet | stop
#
# 保存場所:
#   グローバル既定モード : ~/.ai-workspace/codex-mode
#   トークン制限時挙動   : ~/.ai-workspace/codex-on-tokenlimit
#   repo 上書きモード    : <repo>/.claude/codex-mode
#
# 有効モードの解決順: repo 上書き > グローバル既定 > 安全側デフォルト(stop)
#
# 注意: ライブラリとして source される前提のため、ここでは set -e 等を設定しない
#       （呼び出し側の挙動を壊さないため）。

# ── 定数 ───────────────────────────────────────────────
# このスクリプト自身の版（正は sano-rag の .claude/tools/。配置は install.sh）。
CODEX_MODE_VERSION="1.0.0"

CODEX_MODE_DEFAULT="stop"
CODEX_TOKENLIMIT_DEFAULT="sonnet"

CODEX_AIWS_DIR="${HOME}/.ai-workspace"
CODEX_GLOBAL_MODE_FILE="${CODEX_AIWS_DIR}/codex-mode"
CODEX_TOKENLIMIT_FILE="${CODEX_AIWS_DIR}/codex-on-tokenlimit"
# セッション単位の一時無効化マーカー。
# `ai n` で作成し、有効モードを強制的に stop にする（グローバル/repo 既定は変えない）。
# 次に通常の `ai` / `ai select` を実行するとクリアされる。
CODEX_SESSION_OFF_FILE="${CODEX_AIWS_DIR}/codex-session-off"

# ── バリデーション ─────────────────────────────────────
codex_mode_is_valid() {
  case "${1:-}" in
    stop|prereview|review-merge|autonomous) return 0 ;;
    *) return 1 ;;
  esac
}

codex_tokenlimit_is_valid() {
  case "${1:-}" in
    sonnet|stop) return 0 ;;
    *) return 1 ;;
  esac
}

# ── モードの日本語ラベル（対話 UX 用） ─────────────────
codex_mode_label() {
  case "${1:-}" in
    stop)         echo "停止（レビューしない）" ;;
    prereview)    echo "プレレビューのみ（コメントのみ）" ;;
    review-merge) echo "レビュー&一部マージ" ;;
    autonomous)   echo "自走（修正→再レビューを反復）" ;;
    *)            echo "不明" ;;
  esac
}

# ── repo ルート解決（引数 > git トップレベル > カレント） ──
codex_repo_root() {
  if [ -n "${1:-}" ]; then
    echo "$1"
    return 0
  fi
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || root=""
  if [ -n "${root}" ]; then
    echo "${root}"
  else
    echo "${PWD}"
  fi
}

# ── ファイルから 1 行読み取り（前後空白除去・空なら失敗） ──
_codex_read_file() {
  local f="$1" v
  [ -f "${f}" ] || return 1
  v="$(head -n1 "${f}" 2>/dev/null | tr -d '[:space:]')"
  [ -n "${v}" ] || return 1
  echo "${v}"
}

# ── グローバル既定モード get（不正値はデフォルトに丸める） ──
codex_mode_get_global() {
  local v
  v="$(_codex_read_file "${CODEX_GLOBAL_MODE_FILE}")" || { echo "${CODEX_MODE_DEFAULT}"; return 0; }
  if codex_mode_is_valid "${v}"; then echo "${v}"; else echo "${CODEX_MODE_DEFAULT}"; fi
}

# ── repo 上書きモード get（無効・無しなら非0で返す） ──
codex_mode_get_repo() {
  local root file v
  root="$(codex_repo_root "${1:-}")"
  file="${root}/.claude/codex-mode"
  v="$(_codex_read_file "${file}")" || return 1
  codex_mode_is_valid "${v}" || return 1
  echo "${v}"
}

# ── セッション一時無効化 set/clear/active ──────────────
codex_session_off_set()    { mkdir -p "${CODEX_AIWS_DIR}"; : > "${CODEX_SESSION_OFF_FILE}"; }
codex_session_off_clear()  { rm -f "${CODEX_SESSION_OFF_FILE}"; }
codex_session_off_active() { [ -f "${CODEX_SESSION_OFF_FILE}" ]; }

# ── 有効モード get（解決順を適用） ─────────────────────
# セッション無効化が有効なら、既定に関わらず stop を返す。
codex_mode_get() {
  if codex_session_off_active; then
    echo "stop"
    return 0
  fi
  local v
  if v="$(codex_mode_get_repo "${1:-}")"; then
    echo "${v}"
    return 0
  fi
  codex_mode_get_global
}

# ── set: グローバル既定 ────────────────────────────────
codex_mode_set_global() {
  local mode="${1:-}"
  if ! codex_mode_is_valid "${mode}"; then
    echo "[ERROR] 不正なモード値: '${mode}'（stop|prereview|review-merge|autonomous）" >&2
    return 1
  fi
  mkdir -p "${CODEX_AIWS_DIR}"
  printf '%s\n' "${mode}" > "${CODEX_GLOBAL_MODE_FILE}"
}

# ── set: repo 上書き ───────────────────────────────────
codex_mode_set_repo() {
  local mode="${1:-}" root
  if ! codex_mode_is_valid "${mode}"; then
    echo "[ERROR] 不正なモード値: '${mode}'（stop|prereview|review-merge|autonomous）" >&2
    return 1
  fi
  root="$(codex_repo_root "${2:-}")"
  mkdir -p "${root}/.claude"
  printf '%s\n' "${mode}" > "${root}/.claude/codex-mode"
}

# ── トークン制限時挙動 get/set ─────────────────────────
codex_tokenlimit_get() {
  local v
  v="$(_codex_read_file "${CODEX_TOKENLIMIT_FILE}")" || { echo "${CODEX_TOKENLIMIT_DEFAULT}"; return 0; }
  if codex_tokenlimit_is_valid "${v}"; then echo "${v}"; else echo "${CODEX_TOKENLIMIT_DEFAULT}"; fi
}

codex_tokenlimit_set() {
  local v="${1:-}"
  if ! codex_tokenlimit_is_valid "${v}"; then
    echo "[ERROR] 不正な値: '${v}'（sonnet|stop）" >&2
    return 1
  fi
  mkdir -p "${CODEX_AIWS_DIR}"
  printf '%s\n' "${v}" > "${CODEX_TOKENLIMIT_FILE}"
}

# ── CLI ディスパッチ（直接実行時のみ。source 時は何もしない） ──
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _cmd="${1:-}"
  shift || true
  case "${_cmd}" in
    get)            codex_mode_get "${1:-}" ;;
    get-global)     codex_mode_get_global ;;
    get-repo)       codex_mode_get_repo "${1:-}" || { echo "[INFO] repo 上書きなし" >&2; exit 0; } ;;
    set-global)     codex_mode_set_global "${1:-}" ;;
    set-repo)       codex_mode_set_repo "${1:-}" "${2:-}" ;;
    tokenlimit-get) codex_tokenlimit_get ;;
    tokenlimit-set) codex_tokenlimit_set "${1:-}" ;;
    label)          codex_mode_label "${1:-}" ;;
    session-off)    codex_session_off_set ;;
    session-on)     codex_session_off_clear ;;
    session-status) codex_session_off_active && echo "off" || echo "on" ;;
    *)
      cat >&2 <<'USAGE'
codex-mode.sh — Codex レビューモード状態管理
使い方:
  codex-mode.sh get [repo]              有効モード（repo上書き>グローバル>stop）
  codex-mode.sh get-global              グローバル既定モード
  codex-mode.sh get-repo [repo]         repo上書きモード
  codex-mode.sh set-global <mode>       グローバル既定を設定
  codex-mode.sh set-repo <mode> [repo]  repo上書きを設定
  codex-mode.sh tokenlimit-get          トークン制限時挙動（sonnet|stop）
  codex-mode.sh tokenlimit-set <v>      同上を設定
  codex-mode.sh label <mode>            モードの日本語ラベル
  codex-mode.sh session-off             このセッションのレビューを無効化（既定は変えない）
  codex-mode.sh session-on              セッション無効化を解除
  codex-mode.sh session-status          セッション無効化の状態（on|off）
  mode値: stop | prereview | review-merge | autonomous
USAGE
      [ -z "${_cmd}" ] && exit 1 || exit 2
      ;;
  esac
fi
