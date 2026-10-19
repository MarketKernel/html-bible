#!/usr/bin/env bash
# Builds the page and runs it on this computer with the server (server/, Rust):
# the translations and Lopukhin from data/, discussions, sign-in (demo users
# anna, david, elena, mikhail, sarah; the password is <login>-demo). Ctrl+C stops it.
#
#   build_scripts/start.sh            build, start, open the browser
#   build_scripts/start.sh --reset    the same with the discussions reset to the demo question
#   build_scripts/start.sh --no-open  don't open the browser
#   build_scripts/start.sh --aws      discussions and sign-in from the API in AWS
#                                     (config/build.json); the local server serves the page and data/
#   PORT=9000 build_scripts/start.sh  another port
#
# The single file build/html-bible.html also works opened from disk while the
# server runs.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust is needed for the server: https://rustup.rs" >&2
  exit 1
fi

PORT="${PORT:-8787}"
URL="http://localhost:${PORT}/"
OPEN=1
SERVER_ARGS=()
BUILD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --reset) SERVER_ARGS+=(--reset) ;;
    --no-open) OPEN=0 ;;
    --aws) BUILD_ARGS+=(--aws) ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

PORT="$PORT" build_scripts/build.sh ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is busy. Stop what runs there or use PORT=… $0" >&2
  exit 1
fi

# The browser opens once the server answers.
if [ "$OPEN" = 1 ]; then
  (
    for _ in $(seq 1 50); do
      if curl -fs "${URL}v1/health" >/dev/null 2>&1; then
        if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"; fi
        exit 0
      fi
      sleep 0.2
    done
  ) &
fi

echo
echo "  Site:        $URL"
echo "  Single file: file://$(pwd)/build/html-bible.html"
echo "  Ctrl+C to stop"
echo
cargo build --quiet --manifest-path server/Cargo.toml --bin local
exec server/target/debug/local --port "$PORT" --static build/pages ${SERVER_ARGS[@]+"${SERVER_ARGS[@]}"}
