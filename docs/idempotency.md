# Idempotency

`Idempotency-Key` support for the routes HTTP does not make safe on its own. A
retried `PUT` converges; a retried `POST` creates a second user. This closes
that gap: the first request records what it answered, and every later request
carrying the same key gets that answer back instead of executing again.

Source: `src/idempotency/`. Live example: `POST /v1/users` in
`src/users/users.router.ts`. Table: `migrations/*_idempotency_keys.ts`.

## The wire contract

| Situation | Response |
| --- | --- |
| First request with a key | The route runs; its response is recorded |
| Retry, same key, same body, original finished | The recorded response, plus `Idempotency-Replayed: true` |
| Retry, same key, original still running | `409 IDEMPOTENCY_KEY_IN_PROGRESS` with `Retry-After` |
| Same key, different body | `422 IDEMPOTENCY_KEY_REUSED` |
| No key on a route that requires one | `400 IDEMPOTENCY_KEY_REQUIRED` |
| Key longer than 255 chars, or containing a space or control character | `400 IDEMPOTENCY_KEY_INVALID` |

The status codes come from `draft-ietf-httpapi-idempotency-key-header`. They are
the only thing that makes these responses interpretable by a client library that
has never seen this service.

`Idempotency-Replayed` is not decoration. Without it a duplicate submission and
a fresh one are indistinguishable on the wire, and the mechanism becomes
impossible to observe in production or to assert on in a test.

## Why the response is recorded, not the handler's return value

The natural place for this in a codebase that already has `withCache` is another
`RouteOperation` decorator. It does not work, for a reason worth stating
because it is not obvious until the types are written out:

```ts
const user = await repository.create(body); // { created_at: Date, … }
res.json(ok(user)); //                         { created_at: "2026-03-01T…" }
```

A decorator sees `TResult`. What has to be replayed is the *response*, and the
two are different values — a `Date` on one side of `JSON.stringify` and a string
on the other. A store typed by `TResult` would be claiming to return a shape it
cannot produce, and no test on the value side would catch it, because the first
response and the replay serialise identically right up until a client compares
them.

So the record is taken at the boundary, where the artefact is the response
itself. The cost is the one ugly thing in `idempotency.middleware.ts`:
`res.json` and `res.end` are wrapped for the life of the request. `res.json`
covers every enveloped response, success or error; `res.end` covers the
body-less ones (`204`). A response written as a raw chunk is deliberately *not*
recorded — there is nothing to store that a replay could reproduce faithfully —
so the claim is released and a retry re-executes.

The wrapper persists **before** flushing, never after. Recording on
`res.on('finish')` would be tidier and would record nothing in the one case that
matters: a client that disconnects mid-flush never fires `finish`, and that
client is precisely the one about to retry.

## Why a pipeline step, not a classic `(req, res, next)` middleware

Because the ordering is load-bearing, and a middleware array cannot state it.

Keys are client-generated strings — `1`, `retry`, a timestamp — so the table
cannot be keyed by the value alone without letting one caller's `1` collide with
another's. The scope is therefore `principal:METHOD:url`, which means this has
to run *after* authentication. Mounted ahead of it, every caller shares the
`anonymous` scope and one client replays another's response body.

Declared over `Authenticated<Request>`, that ordering is a compile error rather
than a comment — the same mechanism `requireRoles` uses:

```ts
const adminOnly = compose().use(authenticate).use(requireRoles('admin'));

router.post(
  '/',
  adminOnly
    .use(idempotent())
    .use(validateBody(createUserBodySchema))
    .handle(usersOperations.create, { status: 201 }),
);
```

It sits *before* `validateBody` on purpose: the fingerprint is taken over the
body as it arrived, so a retry of a request the schema rejected replays that 422
instead of re-deriving it.

The route it is wired to is also the only one here that needs it. `PUT` and
`DELETE` converge on the same state when repeated, which is why
`usersOperations.create` has a timeout but no `withRetry` — a retry loop cannot
replay a write safely, and a key can.

## The table is the lock

```sql
PRIMARY KEY ("scope", "key")
```

`claim` is one statement on the happy path:

```sql
INSERT INTO "idempotency_keys" (…) VALUES (…)
ON CONFLICT ("scope", "key") DO NOTHING
RETURNING "claim_id"
```

No row back means someone else got here first. A `SELECT` followed by an
`INSERT` looks equivalent and is not: two concurrent retries both read nothing
and both proceed, which is the double-submit the table exists to stop. Only on
conflict does the store read the existing record and decide between replay, 409
and 422.

Every timestamp comparison is evaluated by Postgres. Reading `now()` in Node and
passing it down would rest the correctness of a lease on every application
server's clock agreeing with the database's.

`claim_id` fences the writes. `complete` and `release` both require it, so a
request whose claim was taken over cannot overwrite the record its successor is
about to write.

## The lease, and the gap it cannot close

A process that dies between committing its work and recording its response
leaves the key claimed. Two bad options, and the configuration picks between
them:

- **No lease.** Every retry answers 409 until the retention window ends — a day,
  by default — and the client can neither retry nor find out what happened.
- **A lease** (`IDEMPOTENCY_LEASE_SECONDS`, 60s). A claim older than the lease
  is taken over and the request re-executes. For a claim that was merely *slow*
  rather than dead, that means the work runs twice.

The lease is therefore an upper bound on how long a guarded route may
legitimately take, and should stay comfortably above the slowest one. The
operations here run under a 2s timeout.

What no setting fixes: the claim and the work commit separately. The sequence is
`INSERT claim` → run the route → `UPDATE` with the response, and a crash in the
middle of that third step is indistinguishable from a crash before the work
committed. Closing it means writing the idempotency record inside the same
transaction as the write it guards, which is the transactional-outbox shape
further down `SPEC.md` — not something a middleware above the handler can
arrange. Until then the guarantee is honestly stated as: **duplicates are
absorbed; a crash between commit and record costs one re-execution.**

## What gets recorded

Anything `2xx`–`4xx`, except `408`, `425` and `429`.

4xx *is* recorded, deliberately. A deterministic rejection — 422 on a malformed
body, 409 on a duplicate email — is the answer to this request, and a retry that
re-executes it re-does the work of deciding.

`408`, `425` and `429` are never recorded whatever `isReplayable` says. Each
means "not now" rather than "here is your answer", and freezing one into the
retention window would keep a rate-limited client receiving 429 for a day from a
limiter that had long since relented.

5xx releases the claim rather than recording it. There is no answer to replay,
and leaving the record in place would answer 409 for the rest of the window to a
client whose failure was an invitation to retry.

If the store itself fails while recording, the response still goes out and the
failure is logged. The work has already happened; answering 500 because the
*bookkeeping* failed trades a duplicate for a lie. The unrecorded claim expires
with its lease.

## Configuration

| Variable | Default | What it controls |
| --- | --- | --- |
| `IDEMPOTENCY_RETENTION_SECONDS` | `86400` | How long a recorded response stays replayable |
| `IDEMPOTENCY_LEASE_SECONDS` | `60` | How long an unfinished claim blocks a retry |

Per-route overrides go through `idempotent({ … })`: `required: false` makes the
key opt-in, `isReplayable` narrows what is recorded, and `store` substitutes the
implementation.

`IdempotencyStore.purgeExpired()` deletes records past their retention window
and reports how many it removed. Nothing calls it on a schedule yet — expired
records are already ignored by `claim`, so this is housekeeping for the table's
size rather than for correctness, and it wants the same worker loop the outbox
relay will need.

## Using it on another route

```ts
router.post(
  '/payments',
  compose()
    .use(authenticate)
    .use(idempotent())
    .use(validateBody(createPaymentBodySchema))
    .handle(paymentsOperations.create, { status: 201 }),
);
```

Two things it will not do:

- **Guard an unauthenticated route.** The step's input type requires a
  principal. Scoping anonymous callers by IP is the obvious substitute and a bad
  one — every client behind one NAT shares a namespace — so that variant is left
  undone rather than shipped as a footgun.
- **Deduplicate across scopes.** One key used on two endpoints is two
  independent operations, not a conflict. A key identifies the operation it was
  minted for; it is not a slot in a global registry the client has to keep
  collision-free.
