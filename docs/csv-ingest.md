# Backpressure-aware CSV ingest

`POST /v1/users/import` reads an arbitrarily large CSV off the request socket,
validates it row by row, and writes it in batches — at a fixed memory cost that
does not grow with the upload.

```
  req ──▶ limitBytes ──▶ CsvParser ──▶ recordMapper ──▶ batchObjects ──▶ asyncSink
  bytes    bytes          records       rows             batches          awaits pg
```

Every stage is a `node:stream` primitive and the whole chain is assembled by
`pipeline()` from `node:stream/promises`. The modules are in `src/streams/`
(generic, HTTP-free) and `src/ingest/` (the CSV-to-rows layer); the users-specific
parts — which columns, which schema, which table — are in
`src/users/users-import.ts`.

## What backpressure actually is here

It is one property, and it lives in exactly one place: `createAsyncSink` does not
call its write callback until the database has answered.

Node's `Writable` will not call `_write` again until the previous callback has
fired. So an outstanding `INSERT` means `stream.write()` returns `false`, which
means the batcher upstream stops pushing, which means the parser stops being
pulled, which means the socket stops being read, which means the kernel's receive
window closes on the client. Nothing polls and no stage knows about any other.

The version that looks identical and is not:

```ts
req.on('data', (chunk) => void insertSomething(chunk)); // ✗
```

This never returns `false` to anyone. Bytes keep arriving at line rate while the
inserts queue in memory — it works on a 2 MB fixture and takes the process out on
a 2 GB upload, with the failure landing as an allocation error somewhere
unrelated. Marking the handler `async` makes it worse: the promise is discarded,
so every rejection is unhandled.

### It is measured, not asserted

`src/ingest/csv-ingest.test.ts` runs an ingest against a source that counts the
bytes it has been asked for, and records how far that counter moves *while a sink
write is awaiting*. Under backpressure the source advances by the chain's fixed
buffers and then stalls; without it, the entire remaining document is read during
that one pause.

The measured plateau on the current configuration is about **272 KiB**, and it is
identical for a 700 KB document and a 1.4 MB one — which is the actual claim.
Raising the sink's or the batcher's `highWaterMark` to something unbounded makes
both assertions fail with the full document as the reading.

Note what is *not* asserted: how much had been read when the first write *began*.
That number is small whether or not anything is throttled, because the first batch
is assembled from the first few chunks either way. It looks like a backpressure
test and is not one.

## Why `pipeline()` and never `.pipe()`

Three distinct failures, each of which `.pipe()` leaves in place:

| | `.pipe()` | `pipeline()` |
|---|---|---|
| Error on a middle stage | not forwarded; the destination never ends and the request hangs until a proxy times it out | rejects with the first error |
| Error at the destination | source keeps flowing and buffering into a dead chain | every stream is `destroy()`ed |
| Client hangs up mid-upload | downstream streams are left open | `ERR_STREAM_PREMATURE_CLOSE`, everything torn down |

The third is the ordinary case for this endpoint rather than an exotic one, and
it is a real outcome of `ingestCsv` — not a bug.

## `highWaterMark` is not a detail

Object-mode streams default to a `highWaterMark` of **16 objects**. For
`batchObjects(500)` those objects are arrays of 500 rows, so accepting the default
would let 8,000 rows sit in memory waiting for a round trip — most of the
buffering the whole design exists to avoid, reintroduced by a default nobody
typed. Every object-mode stage here sets it explicitly to 1.

One honest caveat: a `Transform` pushes everything it produces from a single
`_transform` call regardless of its `highWaterMark`. The mark bounds buffering
*between* input chunks, not within one — so a single 64 KiB chunk yields all of
its ~1,300 records at once. That is bounded by the chunk size, which is bounded by
the transport, so it is a constant too.

## The CSV parser

`src/streams/csv-parser.ts` is a state machine over characters, not a line
splitter. A CSV record is not a line: a quoted field may contain the delimiter,
the quote character, and newlines. Splitting on `\n` first shreds such a record
into pieces no later pass can reassemble.

It keeps **no raw text buffer**. The state machine's position, the field under
construction, and the fields already closed all persist across `_transform` calls,
so a chunk boundary is just the point where one call ends and the next resumes.
`csv-parser.test.ts` re-parses one document at *every* chunk size from 1 byte
upward and requires identical output.

Two things it does that a `chunk.toString()` parser cannot:

- **`StringDecoder`.** A 3-byte `€` split across TCP segments becomes U+FFFD and
  is lost permanently under `toString()` — silently, on some payloads at some
  sizes, which is why it survives every single-chunk fixture.
- **A bounded record.** `maxRecordChars` (1 MiB by default) is what keeps a file
  containing no delimiter at all from becoming one enormous string. Every
  hand-rolled `buffer += chunk` line splitter has this hole, and the stream's
  `highWaterMark` does not close it: that bounds what the stream buffers for you,
  not what the transform chooses to keep.

Accepted: `\n`, `\r\n` and a lone `\r`; `""` as an escaped quote; blank lines as
separators; a UTF-8 BOM at offset 0 only (Excel writes one, and left in place it
makes `email` fail to match `﻿email`).

Refused, with the line named: an unterminated quoted field, and a character after
a closing quote that the grammar has no reading for (`"a"b`). Guessing there is
how a parser turns a corrupt export into plausible-looking rows.

## Two classes of failure

The split matters more than any individual rule.

**Document-level** — a header that cannot be bound, a quote that never closes, a
record over the limit, a body over the byte limit. These abort the upload with a
4xx, because there is no row that could then be read correctly.

**Row-level** — a bad address, a ragged row, a value that fails the schema. These
are collected and the import continues. Aborting on the first one turns a
30,000-row upload into 30,000 round trips to discover 12 bad rows one at a time.

The response reports both: exact counts always, plus up to
`USER_IMPORT_MAX_REPORTED_ERRORS` individual explanations with
`errorsTruncated` saying whether the list is complete. The cap exists because the
wrong file uploaded here rejects *every* row, and a per-row explanation for a
million of them is an out-of-memory on the error path.

## Why the response is one JSON body at the end

Streaming NDJSON progress per batch is the tempting shape and it costs the status
code: the head goes out with the first byte, so a header that turns out to be
unbindable can no longer be a 400 — it becomes a 200 whose body says something
went wrong, which every generated client will read as success.

The cost, stated plainly: the client learns nothing until the import finishes.
The summary itself is bounded (counts plus a capped list), so buffering the
*response* does not mean buffering the *upload*.

## Atomicity, and what replaces it

Each batch is its own statement, so an ingest that fails at row 40,000 leaves the
first 39,500 rows written. The alternative — one transaction spanning the whole
upload — would hold a pooled connection and pin the cluster's `xmin` horizon for
the length of an arbitrarily long HTTP request, stalling autovacuum
database-wide because somebody is on hotel wifi. (Same reasoning as
`docs/advisory-locks.md` gives for `withAdvisorySessionLock`.)

What pays for it is that every row is inserted `ON CONFLICT (email) DO NOTHING`,
so **re-uploading the same file is the correct response to any failure**. It
converges instead of duplicating.

Two consequences worth knowing:

- Rows are de-duplicated *within* a batch first — as an optimisation, not a
  correctness fix. `ON CONFLICT ... DO NOTHING` does handle a repeat inside one
  command, through speculative insertion (verified against PostgreSQL 16.13; it
  is `DO UPDATE` that fails with "cannot affect row a second time"). What
  de-duplication buys is that a file listing one address 500 times does not spend
  500 of the statement's bind slots to insert one row.
- A retry reports `written: 0` for work the first attempt did. The rows are
  idempotent; the response is not. That is weaker than an `Idempotency-Key` and
  it is why the route does not carry one — the middleware fingerprints the
  request body, and there is no body to fingerprint until the stream has been
  read.

## Bounding the request

`express.json()` and `express.urlencoded()` each carry a `limit` and each declines
a `text/csv` body — which is exactly what leaves the raw stream available to this
route, and exactly what leaves it unbounded. Two things replace that limit:

- `requireCsvBody` refuses a `Content-Length` over `USER_IMPORT_MAX_BYTES` before
  a byte is read. A fast path only: a chunked request declares no length at all.
- `limitBytes` counts what actually arrives and fails the moment the boundary is
  crossed, so a client sending a gigabyte is cut off after the limit rather than
  after the gigabyte.

`requireCsvBody` also refuses `Content-Encoding: gzip`. Node does not decompress a
request body for anybody, so the parser would receive the gzip container, find no
delimiter in it, and report an over-long record — true, and completely
misleading.

One subtlety it encodes: `req.is()` is three-valued. It returns `false` for a
non-matching type, the matched type for a match, and **`null` when the request
declares no body at all**. A check written as `req.is('text/csv') !== false`
therefore accepts a bodyless request, which parses as an empty document and is
reported as a successful import of nothing.

## Why the route is undecorated

Every other write here is wrapped in `withTimeout`, and most reads in `withRetry`
and `withCache`. All three are wrong for an operation whose input is a stream that
can be read once:

- **`withRetry`** would re-invoke an operation whose `req` is already consumed and
  destroyed. The second attempt reads zero bytes and reports a successful import
  of nothing — a retry that converts a transient failure into silent data loss.
- **`withCache`** would key a response on a URL that says nothing about the body.
- **`withTimeout`** is a deadline on a request whose legitimate duration is a
  function of how much the client chose to send. `USER_IMPORT_MAX_BYTES` bounds
  the work instead of the clock.

## Format

```csv
email,roles
alice@example.test,"admin,auditor"
bob@example.test,
carol@example.test,user
```

- `email` is required, trimmed and lower-cased (providers compare
  case-insensitively, and without this a file containing both `A@x.test` and
  `a@x.test` creates two accounts every human involved believes are one).
- `roles` is optional and comma-separated *inside one field*, so it must be
  quoted. That is the format doing its job, and it means the parser's
  quoted-field path is exercised by the ordinary case rather than only by a test.
- A blank `roles` cell means "not stated" and falls through to the column's
  `ARRAY['user']` default. It is not `[]`, which would create a user who can do
  nothing.
- There is deliberately **no `password_hash` column**. A bulk endpoint that sets a
  credential directly can mint accounts whose pre-image the caller knows.
  Imported users go through magic-link or OAuth.
- An unrecognised header column is refused rather than ignored: ignoring is
  friendlier right up until someone uploads the wrong export, where the shared
  columns bind, the rest are dropped, and the import "succeeds" while discarding
  most of the file.

## Response

```json
{
  "data": {
    "recordsRead": 3,
    "accepted": 2,
    "written": 1,
    "rejected": 1,
    "errors": [{ "line": 3, "column": "email", "message": "email must be a valid address" }],
    "errorsTruncated": false
  },
  "meta": null,
  "error": null
}
```

`accepted` and `written` are separate because the gap between them is
information: a duplicate email validates, reaches the sink, and does not become a
row. Reporting one number forces the caller to guess which, and "I uploaded 500
and it says 500" reads as success whether or not anything changed.

| Status | When |
|---|---|
| 200 | the document was read; the body says what happened, including rejected rows |
| 400 | `CSV_HEADER_INVALID`, `CSV_UNTERMINATED_QUOTE`, `CSV_INVALID_QUOTE`, `CSV_RECORD_TOO_LARGE` |
| 401 / 403 | no token / not an administrator |
| 413 | `PAYLOAD_TOO_LARGE`, from either the declared length or the counted bytes |
| 415 | not a CSV media type, a compressed body, or no body at all |

The 400s and the 413 arrive through `csvErrorTranslator`, registered in the
composition root alongside the Postgres and Multer translators — so the parser
itself stays free of any HTTP concept and is usable from a CLI or a worker.

## Reusing the pieces

`ingestCsv` is generic over the row type. A second importer needs a column list, a
Zod schema over `Record<string, string>`, and a `write` function:

```ts
const summary = await ingestCsv({
  source: req,
  columns: [{ name: 'sku', required: true }, { name: 'price', required: false }],
  schema: productImportRowSchema,
  batchSize: 500,
  maxBytes: env.USER_IMPORT_MAX_BYTES,
  write: (batch) => writeProductBatch(repository, batch),
});
```

Pick `batchSize` against the protocol's ceiling: one extended-query message
carries at most `MAX_BIND_PARAMETERS` (65,535) bind parameters, so
`batchSize × columns` must stay under it. `BaseRepository.createMany` checks this
and throws with both numbers named — unchecked, `pg` builds a message the server
rejects with an error that leads nobody back to the batch size.
