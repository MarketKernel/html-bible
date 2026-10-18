# Discussions API and sign-in — the contract

This is the contract between the client (`src/core/api-types.ts`,
`src/core/auth.ts`) and the server: today the Python stub in `server/`,
later AWS Lambda behind API Gateway and Amazon Cognito. If this file and the
stub disagree, it's a bug in one of them. `tests/fixtures/api/*.json` holds
request/response pairs that the stub is tested against
(`python3 -m unittest discover -s server/tests -t .`). The client can be
tested against the same files (see [Fixtures](#fixtures)).

**Model (Task.md §3).** A topic (`Question`) has subtopics (`Argument`).
A subtopic collects verses (`ArgumentVerse`), the "stones" on the scale. A
verse is a canonical verse or range that any signed-in user can add, and it
is shared by both sides. People vote on what each verse supports. The two
sides explain the verse in two columns of `Interpretation`s. Models evaluate
each verse too. A subtopic's score, and a topic's, is the tally of its
verses' outcomes.

- [Basics](#basics)
- [Types](#types)
- [Endpoints](#endpoints)
- [Errors](#errors)
- [Outcomes and tallies](#outcomes-and-tallies)
- [AI evaluation and polling](#ai-evaluation-and-polling)
- [Sign-in (Cognito Hosted UI, stub)](#sign-in-cognito-hosted-ui-stub)
- [Local server](#local-server)
- [Fixtures](#fixtures)
- [Decisions the client must know](#decisions-the-client-must-know)

---

## Basics

| | |
| --- | --- |
| Base URL | `apiUrl` from the build config, ending in `/v1/`. Locally: `http://localhost:8787/v1/` |
| Format | JSON, UTF-8, camelCase. Requests with a body send `Content-Type: application/json` |
| Reading | Needs no token |
| Writing and voting | `Authorization: Bearer <access token>`. Without it you get `401` |
| With a token | Every verse's `votes` also has `mine`: your vote, or `null` if you haven't voted |
| Language | `?lang=ru\|en` is accepted (and checked) on reads, but **responses always carry both languages** as `LocalizedText`. The client picks one |
| Ids | Topics, subtopics, verses, interpretations: ULIDs (26 chars, Crockford base32). Users: the token's `sub` (a UUID) |
| Times | ISO 8601 UTC with milliseconds: `2026-10-18T12:00:00.000Z` |
| Unknown request fields | Ignored |
| Pagination | None (everything in one response) |
| Created resources | `201` with a `Location: /v1/<kind>/<id>` header (exposed through CORS) |

### Text in requests and responses

- **In requests**, text fields are plain strings in one language, and the
  body has a top-level `"lang": "ru" | "en"` that says which one. `lang` is
  required whenever the body has a text field.
- **In responses**, every text field is a full `LocalizedText`:

  ```json
  { "orig": "ru", "ru": "Текст автора", "en": "[auto-translated ru→en] Текст автора" }
  ```

  `orig` is the language the author wrote in. The server fills the other
  language through its Translator. The stub's translation is the original
  text with the prefix `[auto-translated ru→en] ` (or `en→ru`). Seed texts
  have real translations. Show "Translated automatically · show original"
  when `orig !== uiLang`.
- An empty optional text (for example `summaryMd` left out) is `""` in both
  languages and is never "translated".
- Markdown subset as in Task.md §2.5. The server checks only length (≤ 5000)
  and the number of images (≤ 5). It never renders the Markdown.

### Verse references

`RefRange = { "from": "JHN.3.16", "to": "JHN.3.18" }`. A single verse has
`from === to`. Only canonical keys (KJV versification) are allowed:

- book: one of the 66 USFM ids `GEN … REV` (the list is in `server/core/books.py`);
- chapter and verse: whole numbers ≥ 1 with no leading zeros. When
  `data/meta/kjv-counts.json` is present (it is now), they must also fit the
  KJV chapter and verse counts. Without that file, the only check is ≥ 1;
- `from` and `to` in the same book, and `from` ≤ `to`. A range may cross
  chapters: `JHN.3.36`–`JHN.4.2`;
- deuterocanonical ids (`TOB`, `JDT`, `WIS`, `SIR`, `LJE`, `BAR`, `1MA`, `2MA`,
  `3MA`, `1ES`, `2ES` and the other USFM ones) → `400 noncanonical_ref`.
  Anything else malformed → `400 invalid_ref`. The error's `field` points
  at the offending part: `ref`, `ref.from`, `ref.to`.

**Canonical order** (verse lists are always sorted this way): book in the
order `GEN … REV`, then chapter, then verse (all numeric, so `JHN.3.2`
comes before `JHN.3.16`), then the end of the range (`JHN.3.16` before
`JHN.3.16–18`).

---

## Types

These are Task.md §3 exactly. Additions are marked **(+)**.

```ts
type Lang = 'ru' | 'en';
interface LocalizedText { orig: Lang; ru?: string; en?: string }   // the server always sends both ru and en
interface User { id: string; provider: 'google' | 'apple' | 'microsoft'; displayName: string; createdAt: string }
interface Author { id: string; displayName: string }               // displayName is the user's current name

type Outcome = 1 | -1 | 0 | null;   // 1 supports the first position ("pro"), -1 the second ("con"), 0 not relevant, null undecided

interface Tally { pro: number; con: number; none: number; open: number }   // counts of verse outcomes (open = null)
interface Tallies { users: Tally; ai: Tally; aiStatus: 'fresh' | 'pending' | 'none' }

interface Question {                 // topic
  id: string;
  title: LocalizedText;
  summaryMd: LocalizedText;
  sides: { pro: LocalizedText; con: LocalizedText };   // position labels
  tags: string[];
  author: Author; createdAt: string;
  updatedAt?: string;                // present after an edit or soft delete
  deleted?: true;                    // present only when soft-deleted
  tally: Tallies;                    // over all verses of all its subtopics
  argumentCount?: number;            // list endpoint only: live (not deleted) subtopics
  verseCount?: number;               // list endpoint only: all verses of the topic
}
interface Argument {                 // subtopic
  id: string; questionId: string;
  title: LocalizedText; summaryMd: LocalizedText;
  author: Author; createdAt: string; updatedAt?: string; deleted?: true;
  tally: Tallies;                    // over its verses
}
interface ArgumentVerse {            // a "stone"
  id: string; argumentId: string; questionId: string;
  ref: RefRange;                     // canonical; unique within the subtopic
  author: Author; createdAt: string;
  votes: { pro: number; con: number; none: number; mine?: 1 | -1 | 0 | null };   // mine: only with a token
  users: { outcome: Outcome };
  ai: { outcome: Outcome; status: 'fresh' | 'pending' | 'none'; verdicts: VerseVerdict[] };
}
interface VerseVerdict {
  verseId: string;
  model: string;                     // "openai-stub-mini" | "openai-stub-large" in the stub
  value: 1 | -1 | 0;
  confidence: number;                // 0 … 1
  rationaleMd: LocalizedText;        // position labels already filled in
  inputHash: string;                 // sha256 hex of the evaluated input
  createdAt: string;
}
interface Interpretation {
  id: string; verseId: string; argumentId: string; questionId: string;
  side: 'pro' | 'con';               // the column
  bodyMd: LocalizedText;
  replyTo?: string;                  // another interpretation of the same verse, either column
  author: Author; createdAt: string; updatedAt?: string; deleted?: true;
  votes: { up: number; down: number; mine?: 1 | -1 | null };   // + / − ratings; mine only with a token
}
interface QuestionFull { question: Question; arguments: Argument[]; verses: ArgumentVerse[]; interpretations: Interpretation[] }
interface VerseTag {
  key: VerseKey; questionId: string; questionTitle: LocalizedText;
  argumentId: string; argumentTitle: LocalizedText; verseId: string;
  users: Outcome; ai: Outcome;
}
interface VerseContext { argument: { id: string; tally: Tallies }; question: { id: string; tally: Tallies } }   // (+) name only
interface VoteResult extends VerseContext { votes: ArgumentVerse['votes']; users: { outcome: Outcome } }
interface VerseRating extends VoteResult { ai: ArgumentVerse['ai'] }
interface ApiErrorBody { error: { code: string; message: string; field?: string; reason?: string; id?: string } }
```

Optional keys are **left out** when they don't apply. They are never sent as
`null` or `false`. The exception is `votes.mine`, which is `null` for a
signed-in viewer who hasn't voted.

**Deleted items** (soft delete, see [Deletion](#deletion)) have
`deleted: true`. Their text fields are emptied to
`{ "orig": <as before>, "ru": "", "en": "" }`, and the author is kept. Show
"deleted by author".

---

## Endpoints

| Method | Path | Token | Success |
| --- | --- | --- | --- |
| GET | `/v1/health` | — | 200 `{ ok, version }` |
| GET | `/v1/me` | required | 200 `User` |
| PATCH | `/v1/me` | required | 200 `User` |
| GET | `/v1/questions?lang=&tag=` | optional | 200 `{ questions: Question[] }` |
| POST | `/v1/questions` | required | 201 `Question` |
| GET | `/v1/questions/{id}?lang=` | optional | 200 `QuestionFull` |
| PATCH | `/v1/questions/{id}` | required, author | 200 `Question` |
| DELETE | `/v1/questions/{id}` | required, author | 200 `{ id, deleted: 'soft' \| 'hard' }` |
| POST | `/v1/questions/{id}/arguments` | required | 201 `Argument` |
| PATCH | `/v1/arguments/{id}` | required, author | 200 `Argument` |
| DELETE | `/v1/arguments/{id}` | required, author | 200 `{ id, deleted }` |
| POST | `/v1/arguments/{id}/verses` | required | 201 `ArgumentVerse` |
| DELETE | `/v1/verses/{id}` | required, author | 200 `{ id, deleted: 'hard' }` |
| GET | `/v1/verses/{id}/rating` | optional | 200 `VerseRating` |
| POST | `/v1/verses/{id}/interpretations` | required | 201 `Interpretation` |
| PATCH | `/v1/interpretations/{id}` | required, author | 200 `Interpretation` |
| DELETE | `/v1/interpretations/{id}` | required, author | 200 `{ id, deleted }` |
| PUT | `/v1/votes/verse/{id}` | required | 200 `VoteResult` |
| PUT | `/v1/votes/interpretation/{id}` | required, not author | 200 `{ votes: { up, down, mine } }` |
| GET | `/v1/verse-tags?book=&chapter=&lang=` | optional | 200 `{ book, chapter, tags: VerseTag[] }` |

"optional" means that reading works without a token. If you send a token
anyway, it must be valid: an expired or bad token gets `401` even on reads.
Refresh the token and retry, or drop it.

**These are gone** and now answer `404 not_found`: points (`/v1/arguments/{id}/points`,
`/v1/points/{id}`), `PUT /v1/votes/point|argument|question/{id}`,
`GET /v1/arguments/{id}/rating`. Positions on a topic and "important" votes
on subtopics no longer exist.

### GET /v1/health

```json
{ "ok": true, "version": "0.1.0-stub" }
```

The API is reachable when this answers 200 (Task.md §2.4). Fixture: `health.json`.

### GET /v1/me · PATCH /v1/me

The user is created on their **first authenticated request** to any endpoint.
`displayName` starts as the token's `name` claim, and `provider` comes from the
token's IdP (see [Tokens](#tokens)).

```json
{ "id": "5cbfc5b0-9bd2-5637-bfe0-7d28368f5ace", "provider": "apple", "displayName": "Elena", "createdAt": "2026-09-29T10:00:00.000Z" }
```

PATCH body: `{ "displayName": "Elena K." }`. The name is trimmed and must be
1–40 characters on one line (otherwise `400`, `field: "displayName"`). It is
moderated (`422`/`503`). The new name shows at once as the `author` of
everything the user wrote. Fixtures: `me-*.json`, `invalid-token.json`.

### GET /v1/questions

All topics, newest first (`createdAt` desc). Each one has `argumentCount`
and `verseCount`. `?tag=x` filters by tag (lowercase match). Soft-deleted
topics are listed with `deleted: true`.

```json
{ "questions": [ { "id": "01JAS000000000000000000Q01", "title": { "orig": "ru", "ru": "…", "en": "…" },
  "summaryMd": { … }, "sides": { "pro": { "orig": "ru", "ru": "Соответствует", "en": "Consistent" }, "con": { … } },
  "tags": ["trinity", "christology", "holy-spirit"],
  "author": { "id": "2764d8bf-…", "displayName": "Anna" }, "createdAt": "2026-09-28T09:00:00.000Z",
  "tally": { "users": { "pro": 7, "con": 6, "none": 1, "open": 3 },
             "ai": { "pro": 3, "con": 2, "none": 10, "open": 2 }, "aiStatus": "fresh" },
  "argumentCount": 3, "verseCount": 17 } ] }
```

Fixtures: `questions-list.json`, `questions-list-tag.json`.

### POST /v1/questions

```json
{ "lang": "en", "title": "Is baptism necessary for salvation?", "summaryMd": "Weigh the **texts** on both sides.",
  "sides": { "pro": "Necessary", "con": "Not necessary" }, "tags": ["baptism", "Salvation"] }
```

| Field | Rules |
| --- | --- |
| `lang` | required, `ru` or `en` |
| `title` | required, 1–200 characters, one line |
| `summaryMd` | optional (default `""`), ≤ 5000 characters, ≤ 5 images |
| `sides` | optional `{ pro, con }`, each 1–60 characters, one line. When it's left out: `{ "orig": lang, "ru": "За", "en": "For" }` / `"Против"`, `"Against"` |
| `tags` | optional (default `[]`), ≤ 10. Each tag is 1–32 letters, digits or `-`, lowercased; duplicates are dropped |

→ `201 Question` with an all-zero tally and `aiStatus: "none"`. Fixtures: `question-create*.json`.

### GET /v1/questions/{id}

The whole discussion as one `QuestionFull`, all flat lists:

- `question`: the `Question` (without the counts);
- `arguments`: oldest first (`createdAt`), soft-deleted ones included;
- `verses`: every verse of every subtopic, in **canonical Bible order**
  (ties broken by `argumentId`, then `id`). Group them by `argumentId`, and
  each group stays in canonical order;
- `interpretations`: every interpretation of the topic, grouped by verse (in
  the order of `verses`) and by side (`pro` first). Within one verse and side
  they are sorted by **score (`votes.up − votes.down`) descending, then
  `createdAt` ascending**. Clients may re-sort, for example to build `replyTo`
  threads under their parents.

Fixtures: `question-get.json` (the full seed topic as David sees it, with
`mine` on every verse) and `question-not-found.json`.

### PATCH /v1/questions/{id}

Send any of `title`, `summaryMd`, `sides` (both `pro` and `con`), `tags`.
`lang` is required if any text field is present. Only the author can do this
(`403 forbidden`). A deleted topic → `409 deleted`. Fixture: `question-patch.json`.

### POST /v1/questions/{id}/arguments · PATCH /v1/arguments/{id}

`{ "lang": "ru", "title": "…", "summaryMd": "…" }`: `title` is 1–200
characters, `summaryMd` is optional. → `201 Argument` with an all-zero tally,
`aiStatus: "none"`. PATCH takes `title` and/or `summaryMd`, plus `lang`,
and is for the author only. Adding to a deleted topic → `409 deleted`.
Fixtures: `argument-create.json`, `argument-patch.json`.

### POST /v1/arguments/{id}/verses

```json
{ "ref": { "from": "JHN.5.19", "to": "JHN.5.20" } }
```

→ `201 ArgumentVerse`. Any signed-in user may add one. This starts an
**AI evaluation of the verse**. With the default `--eval-delay 0` the
response already has `ai.status: "fresh"`; a verse without interpretations
gets value `0`, confidence 0.3, from both models. With a delay it is
`"pending"`, with `outcome: null` and `verdicts: []`.

- The same `{from, to}` twice in one subtopic → `409 duplicate_verse`, and
  the error carries the existing verse's id:
  `{ "error": { "code": "duplicate_verse", "message": "…", "field": "ref", "id": "01JAS000000000000000000V01" } }`.
  Show "already there" and jump to it. A different range (`JHN.1.1–2`
  besides `JHN.1.1`), or the same range in another subtopic, is a new verse.
- Bad references → `400 invalid_ref` / `noncanonical_ref` (see [Verse references](#verse-references)).
- Adding to a deleted subtopic or topic → `409 deleted`.

Fixtures: `verse-create*.json`.

### DELETE /v1/verses/{id}

Only the author can do this (`403 forbidden`), and only while **nobody else
has voted** on the verse (the author's own vote doesn't count) **and it has
no interpretations at all**, even deleted ones. Otherwise → `409 in_use`. On
success → `{ "id": "…", "deleted": "hard" }`; the verse and its votes are
removed. Verses are never soft-deleted. Fixtures: `verse-delete.json`, `verse-delete-in-use.json`.

### GET /v1/verses/{id}/rating

```json
{ "votes": { "pro": 1, "con": 3, "none": 0 }, "users": { "outcome": -1 },
  "ai": { "outcome": -1, "status": "fresh", "verdicts": [ … ] },
  "argument": { "id": "01JAS000000000000000000A01", "tally": Tallies },
  "question": { "id": "01JAS000000000000000000Q01", "tally": Tallies } }
```

This is what you poll during `pending`. It also carries the subtopic's and
topic's tallies, because they change when the evaluation finishes.
Fixture: `verse-rating.json`.

### POST /v1/verses/{id}/interpretations

```json
{ "lang": "ru", "side": "pro", "replyTo": "01JAS000000000000000000T05",
  "bodyMd": "В Ин 17 ученики едины с Отцом и Сыном *через* них…" }
```

| Field | Rules |
| --- | --- |
| `side` | `pro` or `con`: the column, meaning which position this reading supports |
| `bodyMd` | required, 1–5000 characters, ≤ 5 images |
| `replyTo` | optional. Another interpretation **of the same verse**, in either column (`400` otherwise), not deleted (`409 deleted`) |

→ `201 Interpretation`. This **re-evaluates the verse**. Writing on a verse
of a deleted subtopic → `409 deleted`. Fixtures: `interpretation-create*.json`.

### PATCH /v1/interpretations/{id}

`bodyMd` + `lang`, author only. `side` and `replyTo` can't change: sending a
different value gives `400`. → `200 Interpretation` with `updatedAt`, and the
verse is re-evaluated. Fixture: `interpretation-patch.json`.

### Deletion

`DELETE /v1/interpretations/{id}`, `/v1/arguments/{id}` and `/v1/questions/{id}`
are for the author only (`403 forbidden`). They return
`{ "id": "…", "deleted": "hard" | "soft" }`:

- **hard**: nothing hangs off the item, so it is removed;
- **soft**: something does hang off it (an interpretation that has replies,
  a subtopic that has verses, a topic that has subtopics). It stays as
  "deleted by author" (`deleted: true`, texts emptied) and others'
  contributions stay. You can't edit it, reply to it, or add to it
  (`409 deleted`). Deleting it again returns `soft` again;
- when the last child of a soft-deleted item disappears, the item is removed
  too. This walks up: reply chains, a subtopic whose last verse was removed,
  a topic whose last subtopic was removed;
- deleting an interpretation re-evaluates its verse. A hard delete removes the
  interpretation's +/− votes. A soft delete keeps them stored but hides them:
  the deleted interpretation shows `votes: { up: 0, down: 0 }`, with
  `mine: null` for a signed-in viewer.

Fixtures: `interpretation-delete-*.json`, `argument-delete-soft.json`,
`question-delete-*.json`.

### PUT /v1/votes/interpretation/{id}

Body `{ "value": 1 | -1 | null }`: `1` is "+", `-1` is "−", and `null` removes
your rating. `0` or any other value → `400 validation_error`
(`field: "value"`). Each user has one rating per interpretation and can change
or remove it. Rating your own interpretation → `403 own_item`. Rating a
soft-deleted one → `409 deleted`. An unknown id → `404`.

```json
{ "votes": { "up": 3, "down": 1, "mine": 1 } }
```

These ratings only rank interpretations. They never change verse outcomes,
tallies or the AI evaluation, and they aren't part of the AI input hash.
Every response that contains an interpretation carries its `votes`.
Fixtures: `vote-interpretation*.json`.

### PUT /v1/votes/verse/{id}

Body `{ "value": 1 | -1 | 0 | null }` (the key is required): `1` means the
verse supports the first position (`sides.pro`), `-1` the second
(`sides.con`), `0` that it is not relevant to the subtopic, and `null` removes
your vote (that's fine even when there was none). Each user has one vote per
verse, and a new value replaces the old one. **Voting on a verse you added is
allowed.** Any other value → `400 validation_error`, `field: "value"`.

```json
{ "votes": { "pro": 3, "con": 2, "none": 0, "mine": 1 },
  "users": { "outcome": 1 },
  "argument": { "id": "01JAS000000000000000000A01",
                "tally": { "users": { "pro": 5, "con": 2, "none": 0, "open": 0 }, "ai": { "pro": 2, "con": 1, "none": 3, "open": 1 }, "aiStatus": "fresh" } },
  "question": { "id": "01JAS000000000000000000Q01",
                "tally": { "users": { "pro": 8, "con": 6, "none": 1, "open": 2 }, "ai": { "pro": 3, "con": 2, "none": 10, "open": 2 }, "aiStatus": "fresh" } } }
```

Fixtures: `vote-*.json`.

### GET /v1/verse-tags?book=JHN&chapter=14

```json
{ "book": "JHN", "chapter": 14, "tags": [
  { "key": "JHN.14.26", "questionId": "01JAS000000000000000000Q01", "questionTitle": { "orig": "ru", "ru": "…", "en": "…" },
    "argumentId": "01JAS000000000000000000A02", "argumentTitle": { "orig": "ru", "ru": "Личность Святого Духа", "en": "The personhood of the Holy Spirit" },
    "verseId": "01JAS000000000000000000V11", "users": null, "ai": 0 },
  … ] }
```

- There is one tag per (verse key, ArgumentVerse). A range is expanded to
  every verse key it covers in the requested chapter, so `GEN.1.26–27` gives
  two tags. A range that crosses chapters tags the covered part of each
  chapter. If the counts file were missing, a chapter that a range runs past
  would be tagged up to verse 176.
- Sort order: verse, then `questionId`, `argumentId`, `verseId`. `users` and
  `ai` are the verse's two outcomes.
- `book` must be canonical (`400 noncanonical_ref` / `invalid_ref`).
  `chapter` must be ≥ 1 and within the KJV count.

Fixtures: `verse-tags*.json`.

---

## Errors

```json
{ "error": { "code": "validation_error", "message": "\"title\" must be 1–200 characters", "field": "title" } }
```

`message` is English text for developers (and for logs). Build user-facing
text from `code` and `field`. The exception is `reason` on `422`, which is
already in the author's language and is meant to be shown.

| Status | code | When |
| --- | --- | --- |
| 400 | `bad_request` | The body is missing, isn't JSON, or isn't an object |
| 400 | `validation_error` | A field breaks a rule. `field` names it (`title`, `sides.pro`, `tags[2]`, `lang`, `value`, `side`, `replyTo`, …) |
| 400 | `invalid_ref` | A malformed or impossible verse reference (`field`: `ref`, `ref.from`, `ref.to`, `book`, `chapter`) |
| 400 | `noncanonical_ref` | A deuterocanonical book in a reference or in `?book=` |
| 401 | `unauthorized` | No token where one is required. Has a `WWW-Authenticate: Bearer` header |
| 401 | `invalid_token` | Bad signature, malformed, wrong issuer or audience, `alg` other than HS256 |
| 401 | `token_expired` | `exp` has passed. Refresh and retry |
| 403 | `forbidden` | You edited or deleted someone else's item |
| 403 | `own_item` | You rated your own interpretation (votes on your own verse are allowed) |
| 404 | `not_found` | Unknown id, or a route that doesn't exist (including the removed ones) |
| 405 | `method_not_allowed` | A known path with the wrong method. Has an `Allow` header |
| 409 | `duplicate_verse` | The range is already in this subtopic. `id` = the existing verse |
| 409 | `in_use` | You deleted a verse that others have voted on, or that has interpretations |
| 409 | `deleted` | You edited, added to, replied to, or rated a soft-deleted item |
| 413 | `payload_too_large` | The body is over 1 MB (local server) |
| 422 | `moderation_rejected` | The text was refused. `reason` is in the author's language. Nothing was saved |
| 500 | `internal_error` | A server bug |
| 503 | `moderation_unavailable` | The moderator couldn't answer. Nothing was saved; keep the form text and retry |

The stub's moderator allows everything except two magic words. A text that
contains `__reject__` gives `422`, and `__unavailable__` gives `503`. This is
for testing the client's error paths (fixtures `moderation-*.json`).

In AWS, a missing or invalid token on a route that requires one is refused by
API Gateway itself, with the body `{"message":"Unauthorized"}`. **Treat any
401 as "sign in or refresh again", whatever the body.**

---

## Outcomes and tallies

A verse is one point on the scale. People and AI each give it an outcome,
and the two are never mixed. The code is `server/core/ratings.py`.

| What | Rule |
| --- | --- |
| People's outcome of a verse | The value (`1`, `-1`, `0`) with the most votes. **No votes, or a tie between the top two → `null`** (e.g. 2:2:0, 2:0:2 and 1:1:1 are all `null`; 2:1:1 is decided) |
| AI outcome of a verse | The same rule over the models' values, one per model. With two models, if they disagree the outcome is `null` |
| AI outcome while `pending` | Still computed from the previous verdicts. A brand-new verse has `null` and `verdicts: []` |
| `Tally` | Counts of verse outcomes: `pro` (1), `con` (-1), `none` (0), `open` (null) |
| Subtopic `tally` | `{ users: Tally, ai: Tally, aiStatus }` over its verses |
| Topic `tally` | The sum over its subtopics, which is the same as over all its verses |
| `aiStatus` | `"none"` if there are no verses, `"pending"` if any verse is pending, otherwise `"fresh"` |
| Scale (client) | `lean = (pro − con) / (pro + con) × 100`, `null` when `pro + con = 0` |

---

## AI evaluation and polling

Adding a verse, and adding, editing or deleting an interpretation of it,
runs the pipeline `validate → moderate → translate → save`. Then that
**verse's** `ai.status` becomes `"pending"` and the verse is evaluated by
every configured model. Tallies are computed on read, so they are always current.

- **Stub, default (`--eval-delay 0`)**: the evaluation runs inside the same
  request. By the time you get the `201`, the verse is already `fresh`.
- **`--eval-delay N`**: the evaluation finishes N seconds later. Meanwhile the
  verse's `ai.status` is `"pending"`, and so is the `aiStatus` of its
  subtopic's and topic's tallies. The previous verdicts and outcome stay
  visible.
- **Polling**: while `status === "pending"`, call `GET /v1/verses/{id}/rating`
  **every 3 s**. Stop when it isn't `pending`, and update the verse, its
  subtopic and the topic from the response. Give up after about 2 minutes.
- **Debounce**: while an evaluation of a verse is already scheduled, further
  changes don't queue another one. The scheduled run reads the verse and its
  interpretations as they are when it fires, so several quick interpretations
  cost one evaluation. In production the window will be about 30 s.
- **Cache**: verdicts are cached under `inputHash + model`. `inputHash` is
  the sha256 (hex) of the canonical JSON (sorted keys, no whitespace, UTF-8)
  of `{ verse: { id, ref }, interpretations: [{ id, side, bodyMd, replyTo? }] }`
  over the live interpretations sorted by id.
- **Model input** (`server/llm/base.py`): the topic, the subtopic, both
  positions, the verse, and the interpretations of both sides. Votes are
  never included. The positions are shuffled and labelled `A` and `B`;
  which side is A depends on the content. There is a hook for the KJV text
  with ±3 verses of context (`App.verse_text`), and the stub works without it.
  Models answer `A | B | none` with a confidence and a rationale that may say
  `[A]` / `[B]`. The server maps the answer back to `1 / -1 / 0` and puts the
  position labels into the rationale, so the client gets plain text.

The stub models are deterministic. For each side,
`S = wn·count + wl·chars/100` over that side's interpretations, and
`margin = (S_A − S_B)/(S_A + S_B)`. If `|margin| < threshold`, the answer is
`none` (confidence lowered by 0.2); otherwise it is the larger side. A verse
with no interpretations gets `none` with confidence 0.3.

| model | wn | wl | threshold | confidence |
| --- | --- | --- | --- | --- |
| `openai-stub-mini` | 1 | 0.5 | 0.05 | 0.6 |
| `openai-stub-large` | 0.5 | 1 | 0.1 | 0.8 |

---

## Sign-in (Cognito Hosted UI, stub)

The stub serves Cognito's paths on the same origin as the API (locally
`auth.issuer = http://localhost:8787/`). The client code doesn't change when
it moves to Cognito; only `auth.issuer` and `auth.clientId` in the build
profile do. The flow is Authorization Code + PKCE (S256) with a public
client and no secret.

### 1. Redirect to authorize

```
GET {issuer}oauth2/authorize?response_type=code&client_id=<clientId>
    &redirect_uri=<location.origin + location.pathname>&state=<random>
    &code_challenge=<BASE64URL(SHA256(verifier))>&code_challenge_method=S256
    &identity_provider=Google|SignInWithApple|Microsoft&scope=openid%20profile%20email
```

- The stub shows a page marked **DEVELOPMENT STUB**: "Sign in as… (Google)"
  with a name field. Without `identity_provider` it offers all three.
- The same name with the same provider is always the same user
  (`sub = uuid5(provider:name)`). Signing in as **Anna** with Google, **David**
  with Microsoft, **Elena** with Apple (also Mikhail/Google, Sarah/Apple) makes
  you the seed user of that name.
- Submit → `302` to `redirect_uri?code=…&state=…` (appended with `&` if the
  URI already has a query). Cancel → `redirect_uri?error=access_denied&error_description=…&state=…`.
- `redirect_uri` must be `http://localhost:*`, `http://127.0.0.1:*` or
  `https://bible.marketkernel.com/…`, and must not contain a `#`. Otherwise
  the stub shows an error page and doesn't redirect. Other problems
  (`response_type` other than `code`, a missing challenge, a method other
  than S256, an unknown IdP) redirect back with `error=invalid_request` or
  `unsupported_response_type`.
- `client_id`: the stub accepts any non-empty value (`html-bible-dev` in the
  dev profile), but the code is bound to it.

### 2. Exchange the code

```
POST {issuer}oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&client_id=<clientId>&code=<code>&redirect_uri=<same as above>&code_verifier=<verifier>
```

```json
{ "access_token": "<jwt>", "id_token": "<jwt>", "refresh_token": "<opaque>", "token_type": "Bearer", "expires_in": 3600 }
```

- The code is single-use and lives 300 s. `redirect_uri` and `client_id`
  must match the authorize request. The verifier must be 43–128 characters
  of `[A-Za-z0-9-._~]`, and `BASE64URL(SHA256(verifier))` must equal the
  challenge.
- `expires_in` = `--token-ttl` (default 3600).

### 3. Refresh

```
grant_type=refresh_token&client_id=<clientId>&refresh_token=<refresh_token>
```

→ `{ access_token, id_token, token_type, expires_in }`. As in Cognito, there
is **no new refresh token**: keep the old one. Refresh tokens live 30 days in
the stub. Refresh about a minute before `expires_in` runs out, or on any `401`.

### Token endpoint errors (OAuth format, not the API one)

`400 { "error": "<code>", "error_description": "…" }` with one of these
codes: `invalid_request` (a field is missing, or the body isn't a form),
`invalid_client` (no `client_id`), `invalid_grant` (unknown, used or
expired code; PKCE failed; redirect or client mismatch; bad refresh token),
`unsupported_grant_type`. Fixture: `oauth-token-invalid-grant.json`.

### 4. Sign out

- Delete the tokens locally. Optionally call `POST {issuer}oauth2/revoke` with
  the form `token=<refresh_token>&client_id=<clientId>`, which returns `200`
  with an empty body (Cognito has this endpoint too).
- Then go to `GET {issuer}logout?client_id=<clientId>&logout_uri=<url>`, which
  redirects (`302`) to `logout_uri` (same allow-list as `redirect_uri`).

`GET {issuer}.well-known/openid-configuration` lists the endpoints.

### Tokens

Both tokens are JWTs. The stub signs them with HS256 and a development secret
(header `{"alg":"HS256","kid":"stub-hs256","typ":"JWT"}`). Cognito will use RS256.
The client doesn't verify signatures; it only reads `name` and `exp`.

| claim | access token | ID token |
| --- | --- | --- |
| `sub` | user id (UUID) | same |
| `iss` | the issuer, e.g. `http://localhost:8787` | same |
| `aud` | client id | client id |
| `client_id` | client id | — |
| `token_use` | `"access"` | `"id"` |
| `iat`, `auth_time`, `exp` | seconds since epoch; `exp = iat + token-ttl` | same |
| `name` | display name typed on the stub page | same |
| `email` | fake: `maria@google.stub.invalid` (never shown, never stored by the API) | same, plus `email_verified: true` |
| `identities` | `[{ providerName: "Google"\|"SignInWithApple"\|"Microsoft", providerType, userId, primary }]` | same |
| `username` / `cognito:username` | `"<providerName>_<sub>"` | `cognito:username` |
| `scope`, `jti` | `"openid profile email"`, random | — |

**Send the access token** to the API. The server takes the user id from
`sub` and the provider from `identities[0].providerName` (or the username
prefix). It takes the first display name from `name`. Real Cognito access
tokens have no `name`; see `docs/deploy.md`.

---

## Local server

```
python3 server/local_server.py --port 8787 [--latency MS] [--eval-delay S] [--token-ttl S] [--reset] [--static DIR]
npm run server        # the same with --port 8787
```

| Flag | Effect |
| --- | --- |
| `--latency MS` | Delays every `/v1/` and auth response |
| `--eval-delay S` | AI evaluation finishes S seconds after the change (default 0: inside the request) |
| `--token-ttl S` | Access and ID token lifetime (default 3600) |
| `--reset` | Wipes `server/.data/` and loads the seed again. An empty store is seeded automatically on first start |
| `--static DIR` | Serves DIR at `/`, e.g. `build/pages`. `index.html` serves directories, so `http://localhost:8787/?code=…&state=…` works as a redirect URI |
| `--data-root DIR` | What `/data/` serves (default: the repo's `data/`). `.json` is served as `application/json`; `.gz` as `application/gzip` **without** `Content-Encoding` (the client unpacks it) |
| `--data-dir DIR` | Where the JSON store lives (default `server/.data/`) |
| `--issuer URL` | Token `iss` (default `http://localhost:PORT`) |
| `--allow-origin ORIGIN` | An extra CORS / redirect origin (repeatable) |
| `--host`, `--quiet` | Bind address (default 127.0.0.1); no request log |

**CORS** applies to every response, including `/data/` and `/oauth2/token`.
The allowed origins are `null` (pages opened from `file://`, read-only in
practice because sign-in needs a site), any `http://localhost:*` and
`http://127.0.0.1:*`, and `https://bible.marketkernel.com`. The server
echoes the origin, with `Vary: Origin`. Preflight answers `204` with
`Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`,
`Access-Control-Allow-Headers: Authorization, Content-Type` and `Max-Age 600`,
plus `Access-Control-Allow-Private-Network: true` when Chrome asks for it.
`Location` is exposed. Credentials (cookies) aren't used.

Seed: one topic, "Is the doctrine of the Trinity consistent with the
Bible?", with 3 subtopics, 17 verses and 36 interpretations. It has fixed ids:
`01JAS000000000000000000Q01`, `…A01`–`…A03`, verses `…V01`–`…V17`,
interpretations `…T01`–`…T36`. The users are Anna (google), David
(microsoft), Elena (apple), Mikhail (google) and Sarah (apple). Their votes
give every kind of outcome, for a people's tally of 7 : 6, 1 not relevant,
3 undecided. Several interpretations have +/− ratings from other seed users.
Initial verdicts are dated `2026-10-01T09:00:00.000Z`. A store
written by an older seed version (an older data model) is wiped and seeded
again at start.

---

## Fixtures

`tests/fixtures/api/<name>.json`:

```json
{
  "name": "verse-delete",
  "description": "What it shows",
  "server": { "evalDelay": 30 },
  "steps": [
    { "request": { "method": "POST", "path": "/v1/arguments/…/verses",
                   "headers": { "Authorization": "Bearer <jwt:elena>" },
                   "body": { "ref": { "from": "JHN.8.58", "to": "JHN.8.58" } } },
      "save": { "newVerse": "id" },
      "response": { "status": 201, "body": { … } } },
    { "request": { "method": "DELETE", "path": "/v1/verses/{newVerse}", … }, "response": { … } }
  ]
}
```

- Each fixture starts from a fresh seeded server with its clock at
  `2026-10-18T12:00:00.000Z` and `evalDelay` from `server` (default 0). The
  steps run in order against the same server.
- `<jwt:anna>`, `<jwt:david>`, `<jwt:elena>`, `<jwt:mikhail>` and
  `<jwt:sarah>` stand for a valid access token of that seed user. A request
  has either `body` (JSON) or `form` (urlencoded). `path` may include a
  query string.
- `save: { name: key }` stores the response body's top-level `key`, and later
  paths can use it as `{name}`.
- Response bodies must match **exactly**, with the same keys (no extra, no
  missing) and the same JSON types. The exception is these placeholder
  strings: `<ulid>`, `<iso8601>`, `<sha256>`, `<jwt>`, `<string>`, `<number>`.
- The checker is `server/tests/contract.py`
  (`python3 -m server.tests.contract`). `--write` refills the responses from
  the stub. That changes the contract, so review the diff.

---

## Decisions the client must know

1. Responses carry **both languages**; `?lang` is checked but changes nothing.
   Requests send plain strings plus a top-level `lang`.
2. `GET /v1/questions` → `{ questions }`, with `argumentCount` (live
   subtopics) and `verseCount` only there. `GET /v1/questions/{id}` →
   `{ question, arguments, verses, interpretations }`, all flat. Arguments
   are ordered by `createdAt`, verses canonically, interpretations by `createdAt`.
3. `POST /v1/arguments/{id}/verses` takes `{ ref }` only; no `lang` is needed.
   A duplicate gets `409 duplicate_verse` with `error.id`, and `error.field: "ref"`.
4. `votes.mine` is there **only with a valid token**: `null` means no vote. A
   bad or expired token on a read endpoint gets `401`; it isn't ignored.
5. `PUT /v1/votes/verse/{id}` → `{ votes, users, argument: { id, tally }, question: { id, tally } }`.
   `GET /v1/verses/{id}/rating` returns the same plus `ai`. Votes on your own
   verse are allowed.
6. `DELETE /v1/verses/{id}` is always hard; it is refused with `409 in_use`
   once someone else has voted or any interpretation exists. Interpretations,
   subtopics and topics are soft-deleted when something hangs off them
   (`{ id, deleted: 'soft' | 'hard' }`, `deleted: true`, texts emptied).
7. Interpretations: `replyTo` must be an interpretation of the same verse
   (either column). `side` and `replyTo` are fixed after creation.
   Interpretations carry `votes: { up, down, mine? }`. They are rated with
   `PUT /v1/votes/interpretation/{id}` (`1`, `-1` or `null`; `0` gives 400; your
   own gives `403 own_item`; a deleted one gives 409), and the response is
   `{ votes }`. Ratings affect only the order of interpretations: score
   descending, then oldest first, within each verse and side.
8. A new verse is evaluated at once. Without interpretations both stub models
   say `0` (not relevant), confidence 0.3. With `--eval-delay` it starts as
   `pending` with `outcome: null`, `verdicts: []`.
9. `VerseVerdict.rationaleMd` already has the position labels in it (“Consistent”
   / «Соответствует»). The A/B shuffling is internal.
10. Tallies are computed on read. `aiStatus` is `pending` if any verse is,
    and `none` when there are no verses.
11. Error bodies may have `field` (validation, refs), `reason` (422,
    localized) and `id` (`duplicate_verse`). Token endpoint errors use the
    OAuth shape `{ error, error_description }`.
12. The refresh grant returns no new `refresh_token`. Send the **access token**
    to the API.
13. Removed: points, votes on points, subtopics and topics, `GET /v1/arguments/{id}/rating`,
    `Verdict`/`AiRating`/`UserRating`, `Question.votes`/`ai`/`users`,
    `Argument.votes`/`ai`/`users`, `pointCount`. They give `404` or are gone from responses.
