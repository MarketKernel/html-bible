#!/usr/bin/env bash
# Builds the page for trying it on this computer.
#
#   build_scripts/build.sh           against the local server (http://localhost:8787):
#                                    data, discussions and sign-in all from start.sh
#   build_scripts/build.sh --prod    with the production addresses of config/build.json
#   build_scripts/build.sh --aws     data from the local server, but the API (discussions,
#                                    sign-in) of config/build.json: the one in AWS
#   PORT=9000 build_scripts/build.sh the local server on another port
#
# Result: build/html-bible.html (the single file) and build/pages/ (the PWA).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is needed (22 or newer): https://nodejs.org" >&2
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Node.js 22 or newer is needed, this is $(node -v)" >&2
  exit 1
fi

# Dependencies on the first run, and again when package.json changes.
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  npm install --no-audit --no-fund
  touch node_modules
fi

PORT="${PORT:-8787}"
BASE="http://localhost:${PORT}/"
case "${1:-}" in
  --prod) node build.mjs ;;
  --aws)
    API="$(node -p 'require("./config/build.json").apiUrl')"
    node build.mjs --config config/build.dev.json --data-url "${BASE}data/" --api-url "$API" --site-url "${BASE}" ;;
  "")
    node build.mjs --config config/build.dev.json --data-url "${BASE}data/" --api-url "${BASE}v1/" --site-url "${BASE}" ;;
  *) echo "Unknown option: $1" >&2; exit 1 ;;
esac
