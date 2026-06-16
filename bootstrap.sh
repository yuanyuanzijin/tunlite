#!/bin/sh
# tunlite bootstrap — fetch the runtime and hand off to `tunlite install`.
#   curl -fsSL <raw bootstrap.sh> | sh
#   curl -fsSL <raw bootstrap.sh> | sh -s -- --service --skill user
# Override: TUNLITE_REF=<tag>, TUNLITE_ARCHIVE_URL=<url>.
set -eu
main() {
  REPO_URL="https://github.com/yuanyuanzijin/tunlite"
  REF="${TUNLITE_REF:-master}"
  URL="${TUNLITE_ARCHIVE_URL:-$REPO_URL/archive/$REF.tar.gz}"
  command -v node >/dev/null 2>&1 || { echo "tunlite: node (>=18) is required" >&2; exit 1; }
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" | tar xz --strip-components=1 -C "$TMP"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$URL" | tar xz --strip-components=1 -C "$TMP"
  else echo "tunlite: need curl or wget" >&2; exit 1; fi
  node "$TMP/bin/tunlite.js" install "$@"
}
main "$@"
