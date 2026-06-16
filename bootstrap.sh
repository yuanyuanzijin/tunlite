#!/bin/sh
# tunlite bootstrap — fetch the runtime and run `tunlite install`.
# `install` prompts on the terminal (via /dev/tty) even though stdin is the piped
# script, so you get the same y/N questions as a direct run. Pre-answer with flags
# to go non-interactive:
#   curl -fsSL <raw bootstrap.sh> | sh                                        # interactive
#   curl -fsSL <raw bootstrap.sh> | sh -s -- --service --no-skill --no-completion
# Override: TUNLITE_REF=<tag>, TUNLITE_ARCHIVE_URL=<url>.
set -eu
main() {
  REPO_URL="https://github.com/yuanyuanzijin/tunlite"
  REF="${TUNLITE_REF:-master}"
  URL="${TUNLITE_ARCHIVE_URL:-$REPO_URL/archive/$REF.tar.gz}"
  command -v node >/dev/null 2>&1 || { echo "tunlite: Node.js >= 18 is required" >&2; exit 1; }
  node -e 'process.exit(+process.versions.node.split(".")[0]>=18?0:1)' 2>/dev/null || {
    echo "tunlite: Node.js >= 18 is required (found $(node -v 2>/dev/null))" >&2
    echo "  upgrade Node, or with nvm:  nvm install 18 && nvm use 18" >&2
    exit 1
  }
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" | tar xz --strip-components=1 -C "$TMP"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$URL" | tar xz --strip-components=1 -C "$TMP"
  else echo "tunlite: need curl or wget" >&2; exit 1; fi
  node "$TMP/bin/tunlite.js" install "$@"
}
main "$@"
