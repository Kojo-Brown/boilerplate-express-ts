# Range requests and `ETag` on downloads

`GET /v1/uploads/:objectId` serves a stored object. It streams, it resumes, and
it revalidates — three things that are one feature, because a client that cannot
tell whether its half-finished download is still current cannot safely resume it.

```bash
# whole object
curl -H "authorization: Bearer $TOKEN" localhost:4000/v1/uploads/$ID -o report.pdf

# how big is it, without transferring it
curl -I -H "authorization: Bearer $TOKEN" localhost:4000/v1/uploads/$ID
# HTTP/1.1 200 OK
# Accept-Ranges: bytes
# Content-Length: 41943040
# ETag: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

# one slice
curl -H "authorization: Bearer $TOKEN" -H 'range: bytes=0-1023' \
     localhost:4000/v1/uploads/$ID
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1023/41943040
# Content-Length: 1024

# resume, and only if it is still the same file
curl -C - -H "authorization: Bearer $TOKEN" localhost:4000/v1/uploads/$ID -o report.pdf
```

## Where the pieces live

| Module | Owns |
|--------|------|
| `http/entity-tag.ts` | The RFC 9110 entity-tag grammar and the strong/weak comparisons |
| `http/range.ts` | The `Range` grammar, and resolving it against a known size |
| `http/conditional.ts` | `If-None-Match`, `If-Modified-Since`, `If-Range` |
| `http/byte-range.ts` | The response: status, headers, and the stream |
| `upload/storage/*` | `stat` and `openRange` per backend |
| `upload/download.controller.ts` | The route: id → key → source |

Only the last two know anything about storage, and only `byte-range.ts` knows
anything about Express. Everything else takes strings and numbers and returns
values, which is why the range table below is exhaustive rather than
representative — those cases are all cheap to write.

## What each request produces

| Request | Answer | Why |
|---------|--------|-----|
| no `Range` | 200, whole object | |
| `bytes=0-499` | 206, `Content-Range: bytes 0-499/N` | |
| `bytes=500-` | 206, to the last byte | how "the rest" is asked for |
| `bytes=-500` | 206, the final 500 bytes | |
| `bytes=-5000` on a 100-byte object | 206, all 100 bytes | a suffix longer than the object *is* the object |
| `bytes=0-999999` on a 100-byte object | 206, all 100 bytes | `last-pos` past the end is clamped, not refused |
| `bytes=N-` where `N ≥ size` | **416**, `Content-Range: bytes */N` | well-formed and names nothing |
| `bytes=-0` | **416** | "the last zero bytes" |
| any range on a 0-byte object | **416** | there is no byte to start at |
| `bytes=10-5` | 200, whole object | invalid syntax, so the header is ignored |
| `lines=0-5` | 200, whole object | a unit this server does not implement |
| `bytes=0-9, 20-29` | 200, whole object | see below |

### Why an invalid `Range` is 200 and an unsatisfiable one is 416

They look like the same mistake and are not. RFC 9110 §14.2 requires a recipient
to **ignore** a `Range` it cannot parse — a header it does not understand must
not change the answer, which is what keeps a range-unaware intermediary from
breaking a request. An unsatisfiable range is understood perfectly; it just
names bytes that are not there, and quietly serving the whole object instead
would hand a resuming client the bytes it already has, starting at the offset it
explicitly asked to skip past. The 416 carries `Content-Range: bytes */N` so the
client can see that its idea of the length is stale.

### Why a multi-range request gets the whole object

A 206 answering several ranges has to be a `multipart/byteranges` body: sending
just one of them is not permitted, because the client cannot tell which it got.
That body means a generated boundary, a part header per range and a total length
computed up front — for a feature whose real users all send exactly one range
(`curl -C -`, a video player seeking, a resumable download library). Ignoring
`Range` is always a correct answer, so a multi-range request gets 200. If you
need the multipart form, `resolveRange` is where it would be decided and
`byte-range.ts` is where it would be written; nothing else changes.

## Validators

`ObjectStat.etag` is a **strong** entity-tag, and that is forced rather than
chosen: `If-Range` is evaluated by strong comparison, so a weak validator
silently disables resumption for every client that sends one.

- **memory** — the SHA-256 of the stored bytes, digested once at write time.
- **s3** — S3's own `ETag`, passed through untouched. Re-quoting or lower-casing
  it would produce a tag matching nothing a previous response handed out.

`If-None-Match` uses **weak** comparison (RFC 9110 §13.1.2) and `If-Range` uses
**strong** (§13.1.5). The two comparison functions are one line each in
`entity-tag.ts` and the difference is the whole point: a cache asking "is my copy
still good enough" and a client asking "may I splice these bytes onto those" are
not asking the same question.

When a request carries both `If-None-Match` and `If-Modified-Since`, the date is
**ignored** — §13.1.3. Clients send both so an origin with only one kind of
validator can still answer; requiring both to pass turns every revalidation of a
file whose mtime moved but whose bytes did not into a full transfer.

## Resuming: `If-Range`

`If-Range` is the field that makes `curl -C -` safe, and its logic is inverted
from every other precondition: a **failed** `If-Range` is not an error, it is an
instruction to ignore the `Range` and send everything. The client said "bytes
5000– if this is still the file I was downloading, otherwise start again", and
200 is the second half of that sentence. Answering 412 would strand a client that
is perfectly able to restart.

Dates in `If-Range` are compared for **equality**, not for "not newer": a
representation rewritten twice inside one second carries an unchanged
`Last-Modified`, and a `>=` comparison would splice bytes from the second one.

## Streaming

Nothing buffers the object.

- `ByteSource.open(range)` yields a `Readable` over exactly that interval, and
  `pipeline(stream, res)` connects it to the socket. Backpressure is the
  response's: a slow client stops reading, `res.write` returns `false`, and the
  source stops being pulled.
- **`pipeline`, never `stream.pipe(res)`.** On a client disconnect `pipe` leaves
  the source running — for a 40 GB S3 object that means this process goes on
  paying for a transfer whose recipient hung up. `pipeline` destroys the source,
  and destroying the source is what aborts the underlying request.
  `ERR_STREAM_PREMATURE_CLOSE` is swallowed: a cancelled download is ordinary
  traffic, not an error to log.
- The S3 adapter pushes the `Range` down to `GetObject` rather than fetching the
  whole object and slicing. Fetching and discarding would pay for the entire
  transfer to serve 1 KB of it, which is the cost this endpoint exists to avoid.
- The memory adapter hands its object out in 64 KiB chunks. A
  `Readable.from([slice])` would satisfy the interface and make the driver
  useless for proving any of the above — with the whole range in one chunk there
  is no second `read()`, so nothing can ever exert backpressure.

## Two calls to the backend, not one

`stat` then `openRange`. A 304 and a 416 are complete answers built entirely out
of the metadata, and an endpoint that had to open the object to produce them
would transfer the thing it is about to tell the client not to transfer.

The cost is one extra round trip (a `HeadObject`, which moves no data) on
requests that *do* transfer. The alternative — a single ranged `GetObject` with
the conditional headers forwarded for S3 to evaluate — cannot express `If-Range`,
whose failure mode is "ignore the range and send everything" rather than an
error, and would leave this API's cache semantics defined by the backend's.

The `stat`'s tag is passed back into `openRange` as `ifMatch`, so the two calls
are pinned to the same representation. Without it, an object replaced in the
window between them is served under the *previous* one's `Content-Length` and
`Content-Range` — a corrupt file that every checksum downstream blames on the
network. S3 enforces it with `IfMatch` and answers 412; the memory driver checks
its own digest.

## Errors after the first byte

Once a byte of the body is out, the status line is spent. `next(err)` would have
the error middleware write a second set of headers onto a response that already
has some, so `sendByteRange` throws only while the head is unwritten and destroys
the connection otherwise. The declared `Content-Length` is what lets the client
detect the truncation.

For the same reason the source is opened **before** `Content-Type` and
`Content-Length` are set. A failing `open` is ordinary — the object was deleted
between the `stat` and the read — and it has to be able to become a 404 or a
503; committing `video/mp4` and four gigabytes first leaves both on the error
response, so the client gets a JSON body framed as a truncated video.

## Cache-Control

`private, max-age=31536000, immutable`.

A stored object's key contains a UUID minted when the bytes were written and
nothing ever writes twice to the same one, so the answer for a given key
genuinely cannot change — the long `max-age` is a fact about the resource, not
optimism. `private` because the route is behind `requireAuth` and a shared cache
must not hand one user's upload to the next caller. `immutable` is the part that
pays: without it a browser revalidates on reload, and a revalidation of a 4 GB
video is a round trip in front of every seek whose only possible outcome is 304.

`sendByteRange` defaults to `private, no-cache` instead — the safe default for a
representation whose stability the caller has not vouched for.

## What is not here

- **`multipart/byteranges`.** See above.
- **`Content-Disposition`.** The original filename is not stored; `buildObjectKey`
  keeps the extension and discards the rest, deliberately. Adding it means
  storing the name, which means deciding how to encode a non-ASCII one
  (RFC 6266) and what to do with a name chosen to be misleading.
- **`If-Match`/`If-Unmodified-Since` on reads.** `@/concurrency` owns `If-Match`,
  where it guards a `PATCH` against a lost update. On a GET the only thing it
  could do is turn a cache miss into a 412.
- **Range on a presigned URL.** A presigned `GET` goes straight to S3, which
  implements all of this itself; this route exists for the objects that must stay
  behind the API's own authorisation.
