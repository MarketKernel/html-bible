# Deploying: Cloudflare for the site, AWS for the server (notes, not all done yet)

The Python stub was written so that the handlers move unchanged. This file
lists what replaces each stub piece. The contract (`docs/api.md`) stays the same.

## Overview

```text
GitHub Pages (demo)           build/pages with config/build.demo.json: no data, no server —
                              the user opens translation files from disk
bible.marketkernel.com        Cloudflare Pages: the PWA, html-bible.html and data/ in one folder
                              (build_scripts/cloudflare.sh)
api.bible.marketkernel.com    API Gateway HTTP API ── JWT authorizer (Cognito) ── Lambda ── DynamoDB
auth.bible.marketkernel.com   Cognito User Pool domain with Google, Apple, Microsoft IdPs
                              SSM Parameter Store: OpenAI key    SQS: delayed AI evaluations
```

The texts are not in git. They are built locally (`tools/translations`,
`tools/commentaries`) into `data/` and published with the site. The page and
the texts are on one Cloudflare site on purpose: when Cloudflare shows a
challenge (a captcha), the user sees it on the page itself instead of
downloads failing for no visible reason.

## Cost: about nothing for ~100 users

Prices change; check them before relying on this. For a hundred users a
month the bill is cents, and the one real variable is the language model.

| Piece | Why it costs ~0 |
| --- | --- |
| Cloudflare Pages | free plan: static requests and bandwidth are not billed; 20 000 files, 25 MiB a file |
| Lambda | 1M requests and 400 000 GB-s a month free, always; arm64, 256 MB |
| API Gateway HTTP API | ~$1 per million requests (free for the first 12 months) |
| DynamoDB on-demand | 25 GB storage free; requests are fractions of a cent at this scale |
| Cognito, Lite tier | 10 000 MAU free for social sign-in (Google, Apple); Microsoft comes through OIDC federation: 50 MAU free, then ~$0.015 per MAU |
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
- **Lambda reserved concurrency**: 5 for the API, 1–2 for the evaluator: a
  loop or an attack cannot fan out.
- **DynamoDB**: on-demand with a maximum throughput on each table.
- **OpenAI**: the project's monthly limit; evaluations are debounced and
  cached by input hash already (`verdicts`).

## Cloudflare Pages: the site and the texts

```sh
build_scripts/cloudflare.sh            # build/cloudflare/: checks data/, builds config/build.json
build_scripts/cloudflare.sh --deploy   # … and `wrangler pages deploy` (logs in the first time)
```

- Once: `npx wrangler@4 pages project create html-bible --production-branch main`,
  then attach the custom domain `bible.marketkernel.com` in the dashboard.
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
- The API and Cognito records in Cloudflare DNS are **DNS only** (grey
  cloud): `api` → the API Gateway custom domain's target, `auth` → Cognito's
  CloudFront alias. Proxied, Cloudflare would stand in front of AWS's own TLS
  and custom-domain checks for no gain.

## API Gateway (HTTP API) and Lambda

- **One Lambda for the whole API** (plus the evaluator on SQS): with a
  hundred users most calls are cold anyway, and one function warms up for all
  routes. Its entry point (`server/aws.py`, to write) picks
  `server.handlers.<module>.handler` by `event.routeKey` from the same
  `ROUTES` as `server/gateway.py`. Package the whole `server/` directory:
  the handlers import `server.core`, `server.storage` and `server.llm`. The
  runtime is Python 3.12+ on arm64 with no dependencies but boto3 (in the runtime).
- **Routes**: the ones in `server/gateway.py` (`ROUTES`), declared as
  `GET /v1/questions/{id}` and so on. The handlers also accept routes without
  `/v1` (for a custom-domain API mapping `v1`), because they strip the prefix.
- **JWT authorizer** on the write routes and `/v1/me`: issuer
  `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`, audience = the
  app client id. The claims arrive where the handlers read them:
  `event.requestContext.authorizer.jwt.claims`, all values as strings
  (the local gateway mimics that).
- **Read routes with an optional token** (`GET /questions…`, `/rating`,
  `/verse-tags`): HTTP API can't make an authorizer optional. Leave those
  routes without an authorizer, and have the Lambda verify a `Bearer` token
  if one is present. That means Cognito's JWKS (RS256) instead of the stub's
  HS256 secret; it is about 40 lines plus a cached JWKS fetch, and is used
  only to fill `votes.mine`. Keep the stub's behaviour: an invalid token gets 401.
- **CORS**: API Gateway's built-in CORS config, with origins
  `https://bible.marketkernel.com` (plus every other site that hosts the
  HTML) and `null` (the single file from disk). The GitHub demo has no server. Headers `Authorization, Content-Type`, methods
  `GET, POST, PUT, PATCH, DELETE, OPTIONS`, expose `Location`.
- **Settings**: `Config.from_env()` reads `BIBLE_EVAL_DELAY`,
  `BIBLE_CLIENT_IDS`, `BIBLE_KJV_COUNTS`, `BIBLE_ALLOWED_ORIGINS`, and so on.

## Cognito

- A User Pool on the **Lite** feature plan (the page sends
  `identity_provider`, so Cognito's own sign-in screens are never shown and
  the Essentials plan's managed login is not needed), with the domain
  `auth.bible.marketkernel.com` (ACM certificate in us-east-1; the parent
  domain must resolve, which the Cloudflare site does).
- An app client: public (no secret), Authorization code grant + PKCE,
  scopes `openid profile email`. Callback and sign-out URLs are every site
  that hosts the HTML (`https://bible.marketkernel.com/`, plus
  `http://localhost:8787/` for development if wanted). Access token TTL
  60 min, refresh token TTL 30 days.
- Identity providers, each named exactly as the client sends it in `identity_provider`:
  - `Google`: a Google Cloud OAuth client (web). The redirect is
    `https://auth.bible.marketkernel.com/oauth2/idpresponse`.
  - `SignInWithApple`: an Apple Developer Program membership, an App ID +
    Services ID, a key (.p8), and domain verification. Apple sends the name
    only on the first sign-in.
  - `Microsoft`: an OIDC IdP on Microsoft Entra ID (an app registration,
    "personal and work accounts", issuer `https://login.microsoftonline.com/common/v2.0`).
- Attribute mapping: `name` and `email` from each IdP. The API never shows
  or stores email.
- Real **access tokens have no `name` or `identities`**. The server already
  falls back to the `username` prefix (`Google_…`) for the provider. For the
  first display name, add a *pre token generation* trigger (V2) that copies
  `name` into the access token, or let the client `PATCH /v1/me` after the
  first sign-in (the name step in the UI does that anyway).

## DynamoDB (replaces `server/storage/json_store.py`)

Implement `server/storage/base.py:Store` over boto3 (bundled in the Lambda
runtime). Each `query(table, field, value)` call becomes a GSI.

| Table | Key | GSIs | Notes |
| --- | --- | --- | --- |
| `users` | `id` (sub) | — | |
| `questions` | `id` | `byCreated` (constant partition, `createdAt` sort) | the list endpoint |
| `arguments` | `id` | `questionId` | |
| `verses` | `id` | `argumentId`, `questionId` | `ai` (status, verdicts, inputHash) on the item; uniqueness of `ref` per argument via a conditional put on a `argumentId#from#to` key item |
| `interpretations` | `id` | `verseId`, `questionId`, `replyTo` | |
| `votes` | `id` = `verse:<verseId>:<user>` | `targetKey` | conditional writes instead of the global lock |
| `verdicts` | `id` = `inputHash:model` | — | the evaluation cache; TTL optional |
| `verse_tags` | `bookChapter` (`JHN.3`) + `verse#verseId` | — | **new**: written on verse add/delete instead of scanning verses; outcomes read from the verse |

Outcomes and tallies can stay computed on read at first. If the list becomes
slow, store each verse's outcomes on the verse and per-argument/per-question
tallies as counters updated on every vote and verdict.

## AI evaluation, translation, moderation

- `server/llm/openai.py` (to write) implements `Evaluator`, `Translator` and
  `Moderator` from `server/llm/base.py` with the OpenAI API: structured
  outputs for `VerseVerdict` (`answer: A|B|none`), the moderation endpoint, translation that keeps
  Markdown, verse references and URLs intact. The models come from config
  (env), for example `BIBLE_EVAL_MODELS=gpt-…,gpt-…`.
- **The OpenAI key** is a SecureString in SSM Parameter Store (free, unlike
  Secrets Manager). The Lambda reads it once per cold start, and its IAM
  role may only `ssm:GetParameter` on that one parameter.
- **Asynchronous evaluation** replaces the stub's `threading.Timer`: on save,
  mark the verse `pending` and send `{verseId}` to an SQS queue with
  `DelaySeconds=30`. A conditional "evaluation scheduled" flag on the
  verse keeps the debounce. The evaluator needs the KJV text with ±3 verses
  of context: install `App.verse_text` reading `data/translations/en-kjv.json.gz`
  bundled into the evaluator's package (it is not in git: copy it from
  `data/` when packaging). An evaluator Lambda on the queue runs
  `EvaluationScheduler.run`. Lambda can't keep working after it has returned
  the response, so this queue is required.
- Moderation runs synchronously in the save Lambda (`422` / `503` as in the contract).

## Content-Security-Policy

`connect-src` lists the API origin, the Cognito domain and, for the data,
`'self'` plus `auth.siteUrl` (a relative `dataUrl`); `build.mjs` writes it
from the build profile (Task.md §2.1).

## Checklist before the first real sign-in

1. Google Cloud OAuth client.
2. Apple Developer Program: Services ID, key, domain verification.
3. Microsoft Entra app registration.
4. Cognito domain `auth.bible.marketkernel.com`, the app client, and the three IdPs.
5. Build profile `config/build.json`: `auth.issuer = https://auth.bible.marketkernel.com/`, `auth.clientId`, `apiUrl`.
   Then `build_scripts/cloudflare.sh --deploy`.
6. Run the contract fixtures against the deployed API (same files, different base URL).
