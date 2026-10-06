#!/usr/bin/env bash
# Primary Solver（amaster97/poker_solver。D96）を固定した commit で取得・ビルドする（#81）。
# Solver のソースとビルド成果物はリポジトリに入れない。既定の置き場所はリポジトリ外（~/.local/share）で、
# POKER_SOLVER_HOME で変えられる。終わったら同じ POKER_SOLVER_HOME を server の起動時に渡す。
#
# 前提: git・python3（venv）・Rust（rustup の stable。pip が maturin で Rust 拡張をビルドする）。
# 使い方: bash apps/server/solver/setup-amaster97.sh
set -euo pipefail

# 版を固定する（#76 の PoC で計測した commit）。更新するときは Adapter の AMASTER97_PINNED_COMMIT と同時に変え、
# 録画（src/solver/testing/）の取り直しと River / Turn の手動確認をする。
REPO_URL="https://github.com/amaster97/poker_solver.git"
COMMIT="f78f1b2bc338dd8cbb5226ecb8398bbdb3635676"
DEST="${POKER_SOLVER_HOME:-$HOME/.local/share/proj-poker/amaster97-poker-solver}"

# リポジトリの中に置くとソース・成果物を誤ってコミットしかねないので拒否する。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# worktree から実行したときも本体の作業ツリーの中を拒否する（git-common-dir の親が本体）。
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null || true)"
COMMON_DIR="$(cd "$SCRIPT_DIR" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
MAIN_ROOT="${COMMON_DIR%/.git}"
DEST="$(realpath -m "$DEST")"
for root in "$REPO_ROOT" "$MAIN_ROOT"; do
  [ -n "$root" ] || continue
  case "$DEST/" in
  "$root"/*)
    echo "POKER_SOLVER_HOME はリポジトリの外に置く: $DEST" >&2
    exit 1
    ;;
  esac
done

mkdir -p "$DEST"

for cmd in git python3 cargo; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "$cmd が見つからない（前提: git・python3・Rust の stable）" >&2
    exit 1
  }
done

SRC="$DEST/src"
if [ ! -d "$SRC/.git" ]; then
  git clone "$REPO_URL" "$SRC"
fi
# 固定した commit に detached で合わせる（clone 済みなら fetch してから）。
(cd "$SRC" && git fetch --quiet origin && git checkout --quiet --detach "$COMMIT")
ACTUAL="$(cd "$SRC" && git rev-parse HEAD)"
if [ "$ACTUAL" != "$COMMIT" ]; then
  echo "commit が一致しない: $ACTUAL（期待 $COMMIT）" >&2
  exit 1
fi

# venv に Rust 拡張ごとインストールする（数分かかる）。
python3 -m venv "$DEST/.venv"
"$DEST/.venv/bin/pip" install --quiet --upgrade pip
"$DEST/.venv/bin/pip" install --quiet "$SRC"
VERSION="$("$DEST/.venv/bin/python" -c 'import poker_solver; print(poker_solver.__version__)')"

# Adapter が読む導入情報（Version Metadata の正本）。
cat >"$DEST/install.json" <<JSON
{
  "solver": "amaster97/poker_solver",
  "repository": "$REPO_URL",
  "commit": "$ACTUAL",
  "version": "$VERSION",
  "python": "$DEST/.venv/bin/python"
}
JSON

echo "導入した: amaster97/poker_solver $VERSION ($ACTUAL)"
echo "server の起動時に次を渡す: export POKER_SOLVER_HOME=\"$DEST\""
