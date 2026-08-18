# Pessimistic locking

`SELECT ... FOR UPDATE`, deterministic lock ordering, and a deadlock-retry
wrapper — plus the rule they were added to enforce: **this system always has at
least one administrator.**

## Why the version column was not enough

[Optimistic concurrency](./optimistic-concurrency.md) already guards the two
writes on `/v1/users/:id`. It is a compare-and-swap: the version the client sent
in `If-Match` is part of the `WHERE` clause, so a write that lost a race affects
no rows and answers 412. That is the right mechanism for a *lost update* — two
callers overwriting the same row — and it is complete for that problem.

It cannot express this one:

| | Request A | Request B |
|---|---|---|
| reads | two administrators exist | two administrators exist |
| writes | demote Alice, `If-Match: "3"` | demote Carol, `If-Match: "7"` |
| version check | passes — Alice is still at 3 | passes — Carol is still at 7 |
| result | 200 | 200 |

Neither request touched the other's row, so neither precondition can fail.
Both writes are individually correct and the pair leaves nobody able to
administer the system. The rule is not about one row's version; it is about a
*set*, and the only way to decide something about a set is to stop it changing
while you look. That is what a row lock does and what a version column cannot.

## The shape of the guard

```ts
await withRetryableTransaction(async (tx) => {
  assertAdminRemains(await users.lockAdmins(tx, 'no key update'), req.params.id);
  return users.updateWithVersion(req.params.id, req.body, req.precondition, tx);
}, { lockTimeoutMs: 750, deadlockTimeoutMs: 250 });
```

`lockAdmins` issues

```sql
SELECT * FROM "users" WHERE "roles" @> $1 ORDER BY "id" ASC FOR NO KEY UPDATE
```

and holds every administrator until the transaction ends. The second
transaction blocks on that lock; when the first commits, Postgres re-checks the
row it was waiting on against the *new* version, sees that Alice is no longer an
administrator, drops her from the result — and the guard counts one survivor and
refuses. Verified, not assumed: eight concurrent demotions of eight
administrators against a real PostgreSQL 16 end with seven successes, one
`409 LAST_ADMIN`, and exactly one administrator left.

## Four decisions worth the words

### The lock cannot be taken outside a transaction

`SELECT ... FOR UPDATE` on an autocommit connection takes the lock and releases
it when the statement ends. Nothing fails — no error, no warning — and the
read-modify-write it was added to protect is exactly as racy as before. The only
symptom is a race under load.

So `lockById` and `lockWhereArrayContains` take a `TransactionClient`, a type
carrying a symbol brand that only `withTransaction` produces. Passing the pool
does not compile. The brand is exported so a test double or an adapter can
construct one, because that should be possible — but it should be a line
somebody wrote on purpose and a reviewer can grep for, not something that
happens by passing the wrong argument.

### The set is locked in primary-key order, and unconditionally

Two transactions locking the same rows in opposite orders deadlock. Ordering by
`id` gives every caller the same sequence, so they queue instead — which is
strictly better than being aborted, since a deadlock is not detected until
`deadlock_timeout` elapses.

The delete path therefore locks the administrator set on *every* delete,
including the overwhelming majority whose target is not an administrator. The
cheaper shape — lock the target first, reach for the set only if it turns out to
hold `admin` — reintroduces exactly the cycle the ordering rule removes: two
deletes of two different administrators would each hold their own row and then
wait for the other's. One order for everybody, or no order at all. The cost is
that concurrent deletes serialise; deletes are rare and correctness is not.

Ordering only binds participants who share the convention. An unconditional
`UPDATE` from a backfill, a `psql` session, or a future method locking by some
other key can still close a cycle — which is why the retry wrapper exists and is
not made redundant by the ordering.

### `FOR NO KEY UPDATE` for the patch, `FOR UPDATE` for the delete

A foreign-key check — an insert into any table referencing a user — takes
`FOR KEY SHARE` on the parent row. `FOR UPDATE` conflicts with it; `FOR NO KEY
UPDATE` does not. A transaction editing a user's *roles* changes no key, so
taking the stronger lock would block every insert that merely references that
user, for nothing.

A delete does change the key, so it takes `FOR UPDATE` — a referencing insert
allowed to proceed against a row that is about to disappear is precisely what
the stronger mode prevents.

### The transaction contains database work and nothing else

`withRetryableTransaction` may run its callback more than once. A rolled-back
attempt takes its writes with it — but not a published event, a cleared cache, a
sent email, or a charged card. So the controller keeps all of those *outside*
the call, operating on the committed result. Anything inside that reaches beyond
Postgres gets duplicated by the first deadlock, and the duplicate will not
reproduce on a quiet machine.

## What the retry wrapper retries, and what it refuses

| SQLSTATE | | Retried |
|---|---|---|
| `40P01` | deadlock_detected | yes |
| `40001` | serialization_failure | yes |
| `55P03` | lock_not_available | no |
| connection loss, pool timeout | | no |
| everything else | | no |

The two it retries share a property stronger than "looks transient": Postgres
has already rolled the transaction back and said so on a healthy connection.
There is no outcome in which the failed attempt's writes survive, so replaying
cannot double-apply them.

`55P03` is the caller's own `NOWAIT`, or its `lock_timeout` expiring. Re-entering
the same wait immediately is a busy-wait against a holder that is still holding,
and it spends the request's remaining deadline to learn what it already knows.
The backoff belongs at the client, which is why the error is rendered as a 409
rather than swallowed.

Connection-level failures are the important refusal. A connection that dies with
`COMMIT` in flight leaves the outcome genuinely unknown — the server may have
committed and lost the acknowledgement — so a retry can apply the transaction
twice. Recovering from *that* needs a deduplication key, which this codebase
spells [`Idempotency-Key`](./idempotency.md).

## Timeouts, and the trap between them

Two `SET LOCAL` settings, both bounded by the route's own two-second deadline:

- **`lock_timeout: 750ms`.** A statement blocked on a lock does not notice the
  route deadline. The request gets its answer and the transaction keeps waiting
  — and keeps its pooled connection, which is the actual failure: one slow lock
  holder parks every connection in the pool on the same row while requests that
  never touch it queue behind them.
- **`deadlock_timeout: 250ms`.** This one exists because of how the first
  interacts with the retry loop. At the server default of one second, a genuine
  cycle is reported as `55P03` at 750ms — "somebody still holds it" — before the
  detector ever runs, and the retry loop, which only handles `40P01`, never
  engages. **A lock timeout below `deadlock_timeout` makes the retry wrapper
  unreachable.** Set under it, the cycle is detected, one participant is
  aborted, and the retry finds the row free with most of the deadline left.

Lowering `deadlock_timeout` is not free — each check walks the wait graph under
a global lock, and every lock wait longer than the value pays for one. It suits
a short, contended transaction; a bulk job whose statements routinely wait
should leave it alone and take the longer lock timeout instead.

Both are `SET LOCAL`, never `SET`. The connection returns to the pool, and a
session-scoped setting would follow it there and apply to some unrelated request
— a bug that appears only under load and only on some requests.

## What is deliberately not here

- **No `lockByIds` for an arbitrary id list.** Nothing needs it. The ordering
  argument that justifies it is already carried by the set lock that is actually
  used, and an unused locking primitive is a thing to get wrong later.
- **No `skip locked` on a single-row lock.** `SingleRowLockOptions` removes it,
  because on a one-row read "locked by someone else" and "no such row" both
  arrive as zero rows — so the contended case would be reported as a 404, the
  one answer that tells a client to stop retrying at the moment retrying was
  right. It remains available on the set lock, where the caller can see how many
  rows came back.
- **No serialisable isolation for this invariant.** `withTransaction` accepts an
  isolation level and `withRetryableTransaction` retries `40001`, so the tools
  are there. This rule does not need them: the check is "at least one must
  remain", and the phantom `read committed` can miss — a new administrator
  appearing mid-transaction — can only make the set larger. An invariant of the
  form "at most N" has the opposite exposure and does need `repeatable read`
  plus the retry loop.
- **No enforcement outside these two routes.** `PUT` and `DELETE` on
  `/v1/users/:id` are the only paths that can remove the last administrator, and
  both are guarded. A direct `UPDATE` in `psql` is not, and no application-level
  rule can be — which is the honest limit of an invariant that a `CHECK`
  constraint cannot express.
