# html-bible

A Bible reader in **one HTML file**: search, readable verse links, translations
downloaded into the browser, offline commentaries (Lopukhin's and your own) and
discussions — questions argued *for* and *against* with verses, rated by users
and by language models.

- `build/html-bible.html` — the single file: publish it on any site or open it from disk.
- `build/pages/` — the same page as an installable PWA (works offline).

Translations are **not** inside the file, and not in this repository either. On the
first run the page asks which translations and commentaries to download (they are
kept in IndexedDB), or opens a local JSON file.

Where it runs:

| Where | Build profile | Texts | Discussions |
| --- | --- | --- | --- |
| GitHub Pages — the demo | `config/build.demo.json` | opened from disk only | — |
| `bible.marketkernel.com` on Cloudflare Pages | `config/build.json` | `data/` beside the page | AWS (`docs/deploy.md`) |
| this computer | `config/build.dev.json` | `data/` from the local server | the local server (`server/`) |

## Features

- **Reading**: book → chapter, verse selection, a parallel translation, keyboard ← →.
- **Readable links**: `https://bible.marketkernel.com/#Synodal_Mat3-3` opens the whole
  chapter with the verse highlighted. Also `#Synodal_Mat5-3,5,7-9`, `#KJV_Jhn3`,
  `#Mat3-3` (canonical numbering, opened in your translation), free form `#Мф 2:3`.
  Options: `?notes=0|1`, `?par=KJV`.
- **Versification**: comments, discussion tags and comparison are bound to canonical
  (KJV-numbered) verse keys, so Synodal Ps 22 and KJV Ps 23 are the same psalm.
- **Noncanonical texts** (Tobit, Maccabees…, insertions like Dan 3:24–90) can be read,
  searched, copied and linked to, but take no part in comments, discussions or comparison.
- **Compare**: one passage in every installed translation (`#/compare/Psa23-1`).
- **Search**: words, `"phrases"`, `-exclude`, `prefix*`, OT/NT filters; references go
  straight to the verse.
- **Comments**: commentary sets (JSON) and your own comments — offline only, exported to
  a JSON file anyone can open as a commentary.
- **Discussions** (second tab, needs an account: a login and a password, made only with an
  invitation code from a member; the first member is `root`): question →
  arguments → points for and against with verses. Two separate ratings: the AI's
  (re-evaluated automatically after every addition) and the users' votes. Everyone reads
  and writes in their own language (ru/en); the server translates. A topic can be saved as a JSON file
  (`html-bible/discussion`: both languages, ratings, interpretations; nobody's own votes).
- **Profiles**: who invited whom is public; one's own profile has the name, the password and
  the invitation codes (10, then more from the next midnight UTC). Times are shown in the
  reader's time zone.
- Interface in English and Russian; light and dark themes; phone layout.

## Network: what and why

Unlike a fully offline single-file app, this page talks to two places, both set at
build time and written into the Content-Security-Policy (`connect-src`):

| Address | Why |
| --- | --- |
| `dataUrl` | `catalog.json` (the index), translations, commentaries. Relative (`data/`): beside the page, and from disk beside `siteUrl`; empty: nothing is downloaded |
| `apiUrl` | the discussions API with its sign-in (`server/`: AWS Lambda in production, the same code locally) |

Images in comments and discussion points are whatever their authors link to
(`img-src https:`), loaded with `no-referrer`. Nothing else is fetched; the one inline
script is pinned by its hash.

A page opened from `file://` downloads translations from the site (the data host must
send CORS headers — `config/cloudflare/_headers`) and signs in like the site does.

## Your own domain

Addresses live in `config/build.json` and are overridden without touching code:

```sh
node build.mjs --data-url data/ --api-url https://api.example.org/v1/ --site-url https://example.org/
# or BIBLE_DATA_URL, BIBLE_API_URL, BIBLE_SITE_URL
# or --config config/build.staging.json
```

Links to verses are made from wherever the page is opened, so moving the site needs a
redirect on the old domain that keeps the `#…` part.

## Build and test

```sh
npm install
npm run build          # build/html-bible.html and build/pages/ (production addresses)
npm run build:dev      # the same against the local server (http://localhost:8787)
node build.mjs --config config/build.demo.json   # the demo: no data, no server
npm run server         # the local server (server/, Rust): API, sign-in, data/
npm test               # unit tests (Node, no framework)
npm run test:server    # the server's tests, with the contract fixtures (cargo test)
npm run test:browser   # headless Chrome: the built page end to end (starts the server itself)
npm run check          # all of the above; "done" means this is green
npm run i18n           # strings missing from or unused in src/locales/ru.json
```

To try it on your computer:

```sh
build_scripts/start.sh            # build against the local server, start it, open http://localhost:8787/
build_scripts/start.sh --reset    # the same, discussions reset to the demo question
build_scripts/start.sh --aws      # the same page, but discussions and sign-in from the API in AWS
build_scripts/build.sh            # only build (local server addresses); --prod for config/build.json
PORT=9000 build_scripts/start.sh  # another port
```

Demo users of the local server: `anna`, `david`, `elena`, `mikhail`, `sarah`; the password is
`<login>-demo`. Node.js 22+ and Rust (rustup) are needed.
While developing, `npm run watch` rebuilds on every change.

Publishing:

```sh
build_scripts/cloudflare.sh            # build/cloudflare/: the PWA, html-bible.html, data/, _headers
build_scripts/cloudflare.sh --deploy   # … and upload it to Cloudflare Pages (wrangler)
build_scripts/aws.sh                   # the API: Lambda, DynamoDB, api.bible.marketkernel.com
```

The demo goes to GitHub Pages from CI (`.github/workflows/test.yml`, job `demo`) after
every green push to `main`.

A version tag (`v0.2.0`, equal to `package.json`'s version) makes a GitHub release
(`.github/workflows/release.yml`) with `html-bible-v0.2.0.html`: the page in one file to
download and open from disk, built with `config/build.json`. The server is not published
from GitHub; it goes to AWS only with `build_scripts/aws.sh`.

## Data

The texts are built locally and published with the site; git keeps only
`data/meta/` (KJV verse counts the server needs).

- `data/translations/` — converted by `tools/translations/build.mjs` from
  `private/sources/` (each converter's header says where to download its source);
  format in `Task.md` §5.1:
  - English: KJV, ASV, BSB, Darby, WEB, YLT (eBible.org USFM);
  - Russian: the Synodal (CrossWire RusSynodal, 77 books);
  - Ukrainian: Ohienko (bolls.life; CrossWire's copy merges verses);
  - Greek, New Testament only: Robinson–Pierpont 2018, the Byzantine Textform
    (the editors' accented CSV on GitHub; eBible.org's copy has no accents),
    the Patriarchal text of 1904 and the Textus Receptus (eBible.org USFM);
  - Hebrew, Old Testament only: the Masoretic text (Westminster Leningrad Codex,
    eBible.org `hbo`), its numbering folded into the KJV's by Paratext's `eng.vrs`;
    shown right to left.
  The Hebrew and the Greek also go to the discussions' AI evaluator, which sees a
  verse only in its original language (`server/src/originals.rs`).
  All but the Synodal are in KJV numbering: where an edition numbers otherwise
  (the Romans doxology of WEB, RP and PT, Ohienko's Psalm titles, the Patriarchal
  text's own verse divisions), the converter folds it in.
- `data/commentaries/` — commentary sets split per book (Lopukhin,
  `tools/commentaries/lopukhin.py`).
- `data/catalog.json` — generated (`tools/translations/build-catalog.mjs`), with sizes
  and sha256 the page checks downloads against.

Without `data/` (a fresh clone, CI) the tests of the texts are skipped
(`BIBLE_REQUIRE_DATA=1` makes that a failure, as `cloudflare.sh` does), and the browser
test runs on `tests/fixtures/data/`: every book, chapter and verse of both
translations, with text only in the chapters it reads (`node tools/test-data.mjs`).

All translations are in the public domain (the KJV is under Crown patent in the UK;
Ohienko as CrossWire distributes it — he died in 1972).

## Layout

| Path | What |
| --- | --- |
| `src/core/` | logic without DOM: books, references, versification, search, Markdown subset, packages, routes, i18n |
| `src/app/` | the page: reader, comments, compare, search, discussions, settings, packs, sign-in |
| `src/pwa/sw.js` | the PWA's service worker |
| `server/` | the discussions API in Rust: one AWS Lambda, or the local server (`src/bin/local.rs`); `docs/api.md` is the contract |
| `tools/` | test loader, Chrome driver, i18n, data converters |
| `tests/` | unit tests and the browser test |
| `Task.md` | the specification |

## License

MIT for the code. Texts: see each translation's and commentary's `license`.
