# Optimistic concurrency

Two clients read the same user, both edit it, both `PUT` it back. Without a
precondition the second write wins silently and the first client's change is
gone — no error, no trace, and the first client believes it succeeded. This
closes that gap: a write states the version it expects, and the database decides
whether that expectation still holds.

Source: `src/concurrency/` and `src/db/versioned-repository.ts`. Live example:
`PUT` and `DELETE /v1/users/:id` in `src/users/users.router.ts`. Column and
trigger: `migrations/*_users_version_column.ts`.

## The wire contract

| Situation | Response |
| --- | --- |
| `GET /v1/users/:id` | `200` with `ETag: "<version>"`, and `version` in the body |
| `PUT`/`DELETE` with `If-Match` naming the current version | The write happens; `PUT` answers `200` with the *new* `ETag` |
| `If-Match: *` | The write happens if the row exists, whatever version it is at |
| `If-Match` naming some other version | `412 PRECONDITION_FAILED`, with `ETag` set to the current version |
| No `If-Match` at all | `428 PRECONDITION_REQUIRED` |
| `If-Match` that is not an entity-tag list, or carries a weak tag | `400 PRECONDITION_MALFORMED` |
| Row does not exist | `404 NOT_FOUND` |

Nothing here is invented: 412 and the `If-Match` semantics are RFC 9110, 428 is
RFC 6585. They are the only reason a client library that has never seen this
service can act on these responses.

## Why a `version` column and not `updated_at`

The table already had a timestamp, and it is not a substitute. `updated_at`
answers "when", and a conditional write asks "is this still the state I read?"
Two writes inside one clock tick share a timestamp, and `NOW()` in Postgres is
the *transaction* start time, so two transactions that began together share it
however far apart they commit. A counter has neither problem: it changes on
every write by construction, and no two states of the row can collide.

## Why the increment is a trigger

Because a validator that only holds when the writer remembers to opt in is not a
validator. `BaseRepository.update`, a backfill migration, a `psql` session
fixing one row by hand — each is a writer, and if any of them can change the row
without moving the version, an `ETag` handed out beforehand still compares equal
afterwards and the conditional write it guards silently overwrites that change.

Putting the rule in the database makes the set of writers irrelevant, which is
what lets `VersionedRepository` keep exposing the inherited unconditional
`update` and `delete` without reopening the hole. Verified rather than assumed:
against a real PostgreSQL 16, a hand-written `UPDATE` bumps the version, and so
does one that tries to set `version` itself — the `BEFORE` trigger's assignment
wins.

## Why the check is in the `WHERE` clause

The obvious implementation is read-then-compare-then-write, and it has a window
between the read and the write for exactly the concurrent update it is meant to
catch — the bug reintroduced at the point of fixing it. The version the client
named goes into the statement instead:

```sql
UPDATE "users" SET … WHERE "id" = $2 AND "version" = ANY($3::int[])
```

`= ANY(...)` rather than `= $3` because `If-Match` accepts a *list* of
entity-tags and passes if any of them matches. An empty list — what a header of
only unmatchable tags reduces to — matches no row, which is the correct reading
rather than a special case.

Twenty concurrent writers naming the same version were run against a real
PostgreSQL 16: exactly one was told `updated`, nineteen were told `conflict`,
and the row advanced by exactly one.

## Why one statement and not two

A conditional `UPDATE` that affects no rows cannot say why, and the two reasons
owe the client different answers: 404 if the row is gone, 412 if it is merely at
another version. Asking afterwards introduces a race of its own — the row can be
deleted between the failed update and the follow-up `SELECT`, turning a genuine
conflict into a 404, the one answer that tells a client to stop retrying. Both
branches live in a single statement, and therefore a single snapshot:

```sql
WITH updated AS (
  UPDATE "users" SET … WHERE … RETURNING *
)
SELECT TRUE AS "__updated", u.* FROM updated u
UNION ALL
SELECT FALSE AS "__updated", c.* FROM "users" c
WHERE c."id" = $2 AND NOT EXISTS (SELECT 1 FROM updated)
```

The discriminator is a real column rather than `to_jsonb(row)`, which would have
flattened `created_at` from a `Date` into a string on the way out. It is
stripped in `stripOutcomeFlag`, the one cast in that file.

## What the parser refuses, and what it merely drops

`parseIfMatch` splits its inputs three ways, and the split is the contract:

- **Rejected (400).** A header that is not an entity-tag list, and any weak
  (`W/"…"`) tag. `If-Match` is defined by *strong comparison*, so a weak tag can
  never match anything; answering 412 would send the client back for a fresh
  validator that it would weaken again, forever. A malformed header is a
  statement about the request, and 412 is a statement about the resource.
- **Dropped (leading to 412).** Well-formed tags that cannot name a version:
  `"abc"`, `"007"`, anything past `integer` range. `"007"` is dropped precisely
  *because* comparison is by octets — it is not the tag this API emits for
  version 7, and accepting anything `Number()` would swallow would quietly turn
  the strong comparison into a numeric one.
- **Accepted.** `*`, and any list of strong tags.

The list is scanned rather than `split(',')`, because a comma is a legal
character inside an entity-tag and splitting tears `"a,b"` into two malformed
halves.

## The 412 carries an `ETag`

The version the write lost to is read in the same statement and snapshot as the
failed write, so it is not a follow-up `SELECT` that could itself be overtaken.
Returning it turns recovery into one round trip instead of two.

Getting it onto the response needed one small seam: a `RouteOperation` never
sees a `Response` — that is the premise the route decorators are built on — so
`AppError` now carries optional `headers` that `errorMiddleware` sets before the
body. The idempotency middleware's `res.setHeader('Retry-After', …)` immediately
before its `throw` is the same need solved by hand, from a place that happened to
hold a `Response`.

## Ordering, and what the types enforce

```ts
router.put(
  '/:id',
  authenticated
    .use(validateParams(userIdParamsSchema))
    .use(requireIfMatch)
    .use(validateBody(updateUserBodySchema))
    .handle(usersOperations.update, { send: sendWithETag }),
);
```

`requireIfMatch` refines the request to `WithPrecondition<…>`, and
`usersOperations.update` is declared over that type. A router that dropped the
step — turning the route back into an unconditional, lost-update-prone write —
does not compile. That is the same move `Authenticated` makes for `req.auth`,
and the reason `precondition` is *not* added to Express's global `Request`: a
global property would describe every request in the process, including the ones
that never went near a precondition.

RFC 9110 asks that preconditions not be evaluated for a request that would have
failed anyway. That holds by construction rather than by this ordering: the only
place a precondition is *evaluated* is the `WHERE` clause of the write, which
runs after every step above. What sits between the role check and the body
schema is the requirement that an expectation be stated at all, which is closer
to authorization than to validation.

## Requiring the header, and the objection to it

Making `If-Match` optional means the route protects careful clients and nobody
else, and no client can tell which kind of server it is talking to. The usual
objection — "now every write needs a `GET` first" — is not actually charged,
because `If-Match: *` is a first-class answer. A caller that genuinely means
"delete it whatever it says now" writes one header and skips the read. What is
required is that the expectation be *stated*, not that it be narrow.

`DELETE` is guarded for the same reason as `PUT`, not for symmetry: "delete the
user I looked at" is a claim about a specific state, and between the read and the
delete that user may have been granted a role or re-assigned.

## A conflict drops this replica's cached reads

`GET /v1/users/:id` is behind `withCache`, so the `ETag` a client receives can
come from a cached row and can therefore be stale. That is safe on its own — a
stale validator conflicts, and a conflict never loses a write — but left alone it
livelocks: the client's recovery `GET` is answered from the same entry that
produced the stale tag, and its retry conflicts again for the length of the TTL.
So a conflict clears the store, on a path that is already failing.

## What this does not do

- **No `If-None-Match` / 304 on reads.** The `ETag` is issued and honoured for
  conditional *writes*. Conditional GET is a caching feature, not a concurrency
  one, and it is a separate decision about response bandwidth.
- **No `ETag` on `POST /v1/users`.** The idempotency record stores a status and
  a body, not headers, so a replayed response could not reproduce the tag — and
  an `ETag` present on the first response but absent on its replay is worse than
  absent on both. A created resource is at version 1; a client that wants the
  validator can read it from the `version` field in the body.
- **No collection-level validator.** A tag over `GET /v1/users` would change
  whenever any member did, which is a validator no client can act on.
- **No lost-update protection between `PUT` and other writers of the same row**
  beyond the version check itself. Two writers naming the same version still
  serialise correctly, but a client that wants to *hold* the row across several
  statements wants a lock, not a version — the next two spec items.
