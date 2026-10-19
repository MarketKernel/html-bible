# Deploying: Cloudflare for the site, AWS for the server (notes, not all done yet)

The server in `server/` (Rust) runs as one Lambda; locally the same code runs
as `server/src/bin/local.rs`. The contract (`docs/api.md`) is the same for both.

## Overview

```text
GitHub Pages (demo)           build/pages with config/build.demo.json: no data, no server —
                              the user opens translation files from disk
bible.marketkernel.com        Cloudflare Pages: the PWA, html-bible.html and data/ in one folder
                              (build_scripts/cloudflare.sh)
api.bible.marketkernel.com    API Gateway HTTP API ($default route) ── one Lambda (Rust) ── DynamoDB
                              sign-in is the API's own (login and password, docs/api.md)
                              SES: mail from no-reply@bible.marketkernel.com (sign-in by e-mail, later)
                              SSM Parameter Store: OpenAI key    SQS: delayed AI evaluations (later)
```

The texts are not in git. They are built locally (`tools/translations`,
`tools/commentaries`) into `data/` and published with the site. The page and
the texts are on one Cloudflare site on purpose: when Cloudflare shows a
challenge (a captcha), the user sees it on the page itself instead of
downloads failing for no visible reason.

**Already in AWS** (account 224410707956, eu-central-1, made by hand, outside
any stack, tagged `project=html-bible`):

- ACM certificate for `api.bible.marketkernel.com` (validated by a CNAME in
  Cloudflare, which renews it — keep that record);
- API Gateway custom domain `api.bible.marketkernel.com` (regional, TLS 1.2),
  target `d-tqvs0yknqh.execute-api.eu-central-1.amazonaws.com` — the `api.bible`
  CNAME in Cloudflare (DNS only);
- SES identity `bible.marketkernel.com`: DKIM (3 CNAMEs), MAIL FROM
  `mail.bible.marketkernel.com` (MX + SPF), DMARC `p=none`. The account is
  still in the SES sandbox; ask for production access once the site is up.

**The stack** `html-bible-api` (`server/aws/stack.yaml`, deployed by
`build_scripts/aws.sh`): the tables `html-bible-*`, the Lambda
`html-bible-api` (arm64, 128 MB; a cold start is about 20 ms, a request
5–70 ms, 18 MB used), its log group (14 days), the HTTP API with its
`$default` route and the mapping onto `api.bible.marketkernel.com`. The code
zips go to the bucket `html-bible-deploy-224410707956` (deleted after 30
days; Lambda keeps its own copy). The account allows 10 concurrent Lambda
runs in all, so none can be reserved for this one: the stage's throttling
(10 requests per second, burst 20) is the cap.

```sh
build_scripts/aws.sh     # cargo-lambda (pip install cargo-lambda), the AWS CLI profile html-bible
```

## Cost: about nothing for ~100 users

Prices change; check them before relying on this. For a hundred users a
month the bill is cents, and the one real variable is the language model.

| Piece | Why it costs ~0 |
| --- | --- |
| Cloudflare Pages | free plan: static requests and bandwidth are not billed; 20 000 files, 25 MiB a file |
| Lambda | 1M requests and 400 000 GB-s a month free, always; Rust on arm64, 128 MB is plenty (two functions: the API and the evaluator) |
| API Gateway HTTP API | ~$1 per million requests (free for the first 12 months) |
| DynamoDB on-demand | 25 GB storage free; requests are fractions of a cent at this scale |
| SES | $0.10 per 1000 e-mails |
| SQS | 1M requests a month free |
| SSM Parameter Store | standard SecureString parameters are free (Secrets Manager would be $0.40 a month per secret) |
| ACM certificates | free |
| DNS | stays on Cloudflare: no Route 53 hosted zone ($0.50 a month) |
| CloudWatch Logs | 5 GB free; set retention to 14 days so logs do not pile up |
| OpenAI | per use: the evaluations, moderation is free; set a monthly budget limit in the OpenAI project |

What would cost money, and is not used: NAT gateways and VPCs (the Lambdas
run outside a VPC), WAF ($5 a month and up), provisioned concurrency, X-Ray,
CloudFront in front of the API.

Guards against a surprise bill:

- **AWS Budgets**: a $1 monthly budget with an e-mail alert (two budgets are free).
- **API Gateway stage throttling**: for example 10 requests per second, burst 20.
- **Lambda concurrency**: the account's limit is 10 in all (new accounts);
  with a raised limit, reserve 5 for the API and 1–2 for the evaluator.
- **DynamoDB**: on-demand with a maximum throughput on each table.
- **OpenAI**: the project's monthly limit; evaluations are debounced and
  cached by input hash already (`verdicts`).

## Cloudflare Pages: the site and the texts

```sh
build_scripts/cloudflare.sh            # build/cloudflare/: checks data/, builds config/build.json
build_scripts/cloudflare.sh --deploy   # … and `wrangler pages deploy` (logs in the first time)
```

- Once: `npx wrangler@4 pages project create html-bible --production-branch main --force`,
  then attach the custom domain `bible.marketkernel.com` in the dashboard.
  Without `--force` wrangler now tries to make a Workers project instead, and
  fails to guess the folder; with it the project is plain Pages, and later
  commands (`pages deploy`) need no flag. Done (2026-10-19).
- Pages serves `html-bible.html` at `/html-bible` (a 308 from the `.html`
  address); the file itself is the same, links to either work.
- `config/build.json` has `dataUrl: "data/"`: the PWA reads the texts beside
  itself, so the same build works on `html-bible.pages.dev` and on preview
  addresses. `html-bible.html` opened from disk reads them from
  `auth.siteUrl` (`https://bible.marketkernel.com/data/`), which is why
  `_headers` sends `Access-Control-Allow-Origin: *` on `data/`.
- `data/**/*.gz` must arrive as `application/gzip` **without**
  `Content-Encoding` (the page unpacks it, and checks the sha256 of the bytes
  as stored). `_headers` adds `no-transform`; check after the first deploy:
  `curl -sI https://bible.marketkernel.com/data/translations/en-kjv.json.gz`
  shows `content-type: application/gzip` and no `content-encoding`.
- Keep Bot Fight Mode off, or the downloads of a page opened from disk get
  challenges they cannot show.
- `bible.marketkernel.com` is Proxied, so the zone's settings apply to it:
  Caching → Browser Cache TTL is **Respect Existing Headers** (at 4 hours it
  put `max-age=14400` on `.gz` and `.js`, so after a deploy a browser could
  keep an old pack that fails the new catalog's sha256); Rocket Loader and
  Email Address Obfuscation stay off, since they rewrite the HTML under our CSP.
  Check: `index.html` as served is byte-identical to `build/cloudflare/`.
- The AWS records in Cloudflare DNS are **DNS only** (grey cloud): `api.bible`
  → the API Gateway custom domain's target, and the certificate and SES
  records. Proxied, Cloudflare would stand in front of AWS's own TLS and
  custom-domain checks for no gain, and could put a challenge into API calls.

## API Gateway (HTTP API) and Lambda

- **One Lambda** for the whole API, runtime `provided.al2023` on arm64: the
  Rust binary is the bootstrap. Routing, sign-in, CORS and errors are in the
  code (`server/src/router.rs`), so API Gateway only has the **`$default`
  route** to the Lambda, no authorizer, no CORS settings of its own (the code
  answers preflights), and the API mapping of the custom domain with no base
  path (the paths keep `/v1/…`). Moving to another host means running the
  same code there and pointing the CNAME at it.
- **Throttling** on the stage: for example 10 requests per second, burst 20.
- **Settings** come from environment variables (table names, the allowed
  site origins); there are no secrets in them.

## DynamoDB (`server/src/store.rs`: the Store trait)

One table per record type, on-demand. Each `query(table, field, value)` the
code does is a GSI; `insert` (a new login) is a conditional put.

| Table | Key | GSIs | Notes |
| --- | --- | --- | --- |
| `users` | `id` | `invitedBy` | login, displayName, password hash, member number, the invitation limit |
| `logins` | `id` = login | — | uniqueness of logins: `attribute_not_exists(id)` |
| `numbers` | `id` = member number | — | uniqueness of numbers; the inviter of a code |
| `invites` | `id` = `<number>:<seq>` | — | used invitation codes (the codes are never stored) |
| `sessions` | `id` = sha256 of the token | `userId` | sign out everywhere, password change |
| `throttle` | `id` (`fail:<login>`, `sign-in:<ip>`, `register:<ip>`) | — | TTL on `resetAt` |
| `questions` | `id` | — | the list is a scan: a few topics |
| `arguments` | `id` | `questionId` | |
| `verses` | `id` | `argumentId`, `questionId` | `ai` (status, verdicts, inputHash) on the item |
| `interpretations` | `id` | `verseId`, `questionId`, `replyTo` | |
| `votes` | `id` = `<kind>:<targetId>:<userId>` | `targetKey` | one per user and target by construction |
| `verdicts` | `id` = `inputHash:model` | — | the evaluation cache |
| `meta` | `id` | — | `userNumber`: the counter of member numbers (`UpdateItem ADD`) |

A registration writes the login, the code's use, the number and the user in one
`TransactWriteItems`; taking a code saves the user only while `invitesIssued`
is unchanged (a conditional put), so two requests at once cannot get one code.

**The key of invitation codes** is an SSM SecureString, `/html-bible/invite-key`
(free with the AWS-managed key `aws/ssm`). `build_scripts/aws.sh` makes it once
from 32 random bytes and never replaces it; the Lambda reads it at a cold start
and may read nothing else in SSM. A new key voids every unused code.

**root**: the Lambda's cold start makes root (member 1, password `rootroot`) when
the database has no member counter yet, i.e. once.

Verse tags scan `verses`; with many topics they become a table keyed by
`BOOK.chapter`. Tallies stay computed on read.

## AI: review, translation, evaluation (`server/src/llm.rs`, `openai.rs`)

OpenAI's models over Chat Completions with strict JSON schemas; the key is the
SSM SecureString `/html-bible/openai-key` (put there by hand), read at a cold
start. The models are stack parameters: `ReviewModel` (gpt-5.4-mini) and
`EvalModel` (gpt-5.5). Without the key parameter the stubs answer.

- **Review, in the request** (about 1–2 s): one call of the small model per
  save of a topic, subtopic, interpretation or name. It refuses profanity,
  insults and mockery, and text that does not belong where it is written (a
  topic: the Bible and faith; a subtopic: its topic; an interpretation: its
  verse and subtopic), with a reason in the author's language (`422`), and
  translates the fields into the other language. No answer → `503`, nothing saved.
- **Evaluation, after the response**: adding a verse or changing its
  interpretations marks the verse `pending`, and the API starts the Lambda
  `html-bible-evaluator` asynchronously (`InvocationType: Event`: AWS queues
  it and answers 202 at once). The evaluator — the same binary — asks the
  stronger model about the verse: the whole topic (title, summary, both
  positions shuffled as A and B), the subtopic, and every interpretation of
  both columns in its author's own language. The verse goes by reference only
  (KJV numbering): its text is never sent, so no one can slip in a changed
  one — the model relies on its own knowledge of the Bible. It stores the verdict and the verse is `fresh` again, usually within seconds.
  A failed run is tried once more; meanwhile the verse keeps its last verdicts.
  Verdicts are cached by input hash and model: an unchanged input is never
  sent twice. A topic's and a subtopic's AI score is the tally of their verses.
- Locally, `BIBLE_OPENAI_KEY_FILE=private/key.txt npm run server` uses the
  real models; evaluations then run a second after the response, on the
  local server's timer.

## Content-Security-Policy

`connect-src` lists `'self'`, the site (for the single file reading a relative
`dataUrl` from disk) and the API origin; `build.mjs` writes it from the build
profile (Task.md §2.1).

## Checklist

1. ~~`build_scripts/cloudflare.sh --deploy`, the custom domain~~: done
   (2026-10-19), `bible.marketkernel.com`.
2. ~~The stack~~: done, `build_scripts/aws.sh`.
3. A live smoke test: register, a topic with a verse, a vote, an
   interpretation, deleting all of it, sign-out (done by hand once).
4. SES production access (the site must open), then sign-in by e-mail.
