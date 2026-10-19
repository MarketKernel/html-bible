#!/usr/bin/env bash
# Builds the site for Cloudflare Pages in one folder, build/cloudflare/:
#
#   index.html, sw.js, …   the PWA (config/build.json: it reads data/ beside itself)
#   html-bible.html        the single file, to download; from disk it reads the site's data/
#   data/catalog.json      the index of what can be downloaded (tools/translations/build-catalog.mjs)
#   data/translations/, data/commentaries/
#   _headers               config/cloudflare/_headers: CORS and no-transform on data/
#   404.html               config/cloudflare/404.html: unknown paths get 404, not index.html
#
# The texts are not in git: they must be in data/ (tools/translations,
# tools/commentaries) and pass their tests, or nothing is built.
#
#   build_scripts/cloudflare.sh            build and check
#   build_scripts/cloudflare.sh --deploy   … and upload with wrangler (it asks to log in the first time)
#   CF_PROJECT=name build_scripts/cloudflare.sh --deploy    another Pages project (default html-bible)
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --deploy) DEPLOY=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

build_scripts/build.sh --prod
BIBLE_REQUIRE_DATA=1 node tests/translations.mjs
BIBLE_REQUIRE_DATA=1 node tests/commentary.mjs

OUT=build/cloudflare
rm -rf "$OUT"
mkdir -p "$OUT/data"
cp -R build/pages/. "$OUT/"
rm -f "$OUT/.nojekyll"
cp build/html-bible.html "$OUT/"
cp data/catalog.json "$OUT/data/"
cp -R data/translations data/commentaries "$OUT/data/"
cp config/cloudflare/_headers "$OUT/_headers"
cp config/cloudflare/404.html "$OUT/404.html"

echo
echo "  $OUT: $(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1)"

if [ "$DEPLOY" = 1 ]; then
  npx --yes wrangler@4 pages deploy "$OUT" --project-name "${CF_PROJECT:-html-bible}" --branch main
fi
