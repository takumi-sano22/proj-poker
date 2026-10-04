#!/usr/bin/env bash
# .claude/tools/ のスクリプトを ~/bin へ配置する（冪等・何度実行してもよい）。
#
# なぜ必要か:
#   codex-review.sh / codex-mode.sh は PATH の通った場所に置かないと使えないが、
#   実体をリポジトリ外（~/bin）だけに置くと、skill の記述と実装が別々に配布されて
#   「ドキュメントには書いてあるのに動かない」状態になる（#103）。
#   実体はこのディレクトリを正とし、配置はこのスクリプトで再現する。
#
# 使い方:
#   .claude/tools/install.sh              # ~/bin へ配置
#   CODEX_TOOLS_DEST=/path ./install.sh   # 配置先を変える
#
# 配置先に中身の違うファイルがあれば、上書きの前にタイムスタンプ付きで退避する。

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${CODEX_TOOLS_DEST:-${HOME}/bin}"
TARGETS=(codex-review.sh codex-mode.sh)

mkdir -p "${DEST_DIR}"

for f in "${TARGETS[@]}"; do
  src="${SRC_DIR}/${f}"
  dest="${DEST_DIR}/${f}"

  if [ ! -f "${src}" ]; then
    echo "[install] 見つかりません: ${src}" >&2
    exit 1
  fi

  # 既に同じ内容なら何もしない（冪等）。違う内容なら退避してから上書きする。
  if [ -f "${dest}" ]; then
    if cmp -s "${src}" "${dest}"; then
      echo "[install] 変更なし: ${dest}"
      continue
    fi
    backup="${dest}.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "${dest}" "${backup}"
    echo "[install] 既存を退避: ${backup}"
  fi

  cp "${src}" "${dest}"
  chmod +x "${dest}"
  echo "[install] 配置: ${dest}"
done

# 配置した版を表示する（skill が期待する版と突き合わせるため）。
review_ver="$(grep -m1 '^CODEX_REVIEW_VERSION=' "${SRC_DIR}/codex-review.sh" | cut -d'"' -f2)"
mode_ver="$(grep -m1 '^CODEX_MODE_VERSION=' "${SRC_DIR}/codex-mode.sh" | cut -d'"' -f2)"
echo "[install] 完了。codex-review.sh=${review_ver} / codex-mode.sh=${mode_ver}"
