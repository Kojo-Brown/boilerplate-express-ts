# Distributed locks with Postgres advisory locks

A mutex whose subject is not a row, released by the transaction ending — and
the janitor that needed one.

## Why a row lock could not do this

[Pessimistic locking](./pessimistic-locking.md) can hold still anything that
exists in a table. That is also its limit: `SELECT ... FOR UPDATE` needs rows to
lock, and the things a multi-replica service most needs to serialise have none.

> Only one replica sweeps the expired idempotency records.

There is no row that says "the sweep". The usual workaround is to invent one — a
`jobs` table, a `locks` table, a singleton row updated with `FOR UPDATE` — which
buys a migration, a cleanup story and a stale-row problem in exchange for a
mutex Postgres already offers directly.

An advisory lock *is* that mutex: a 64-bit name in the lock manager, which
Postgres maintains and never interprets. Two properties make it the right
primitive rather than merely an available one, and both were verified against
PostgreSQL 16 rather than assumed:

- **`lock_timeout` bounds a waiting acquisition.** A `pg_advisory_xact_lock`
  waiting on a holder is aborted at the configured time with `55P03`, exactly
  like a row lock.
- **Advisory locks are in the deadlock graph.** Two transactions taking two
  advisory keys in opposite order deadlock and are reported as `40P01`.

So everything `withTransaction` and `withRetryableTransaction` already do about
contention — the lock timeout, the deadlock-retry loop, the SQLSTATE-to-HTTP
mapping in `db.errors.ts` — applies to these locks unchanged. A lock invented in
application code would have needed all of it rebuilt, worse.

The word *advisory* is the caveat: Postgres does not know what a key means. Code
that takes the lock is excluded; code that does not is not. It is exactly as
strong as a mutex in a single process and no stronger, with no equivalent of the
unique index that would have caught the path that forgot to ask.

## Automatic release

Every distributed lock has to answer one question: what happens when the holder
dies still holding it? The usual answer is a lease, a heartbeat to renew it, and
a fencing token so the evicted holder cannot write after its lease lapsed —
three mechanisms, each with its own failure mode.

The transaction-scoped family does not need any of them, because Postgres
already knows the holder is gone: the holder is a session.

```ts
await withTransaction(
  async (tx) => withAdvisoryXactLock(tx, KEY, async (locked) => doTheWork(locked)),
  { lockTimeoutMs: 750 },
);
```

There is no unlock call above and no `finally` that could be skipped.
`pg_advisory_xact_lock` is released when the transaction ends — on `COMMIT`, on
`ROLLBACK`, and on the connection dying with neither.

That is why both transaction-scoped helpers take a `TransactionClient` and not a
`Queryable`. Run on an autocommit connection, `pg_advisory_xact_lock` takes the
lock and releases it at the end of that statement: a second session acquires the
key immediately afterwards, nothing errors, nothing warns, and the critical
section that follows runs unprotected. It is the same silent no-op that
[`FOR UPDATE` outside a transaction](./pessimistic-locking.md) produces, and the
same brand makes it a compile error instead.

## `try` is the default for scheduled work

```ts
const result = await tryAdvisoryXactLock(tx, KEY, (locked) => store.purgeExpired(locked));
if (!result.acquired) return { outcome: 'skipped' };
```

Every replica wakes on the same interval and reaches for the same key. With a
waiting acquisition they queue, and the queue drains into N consecutive runs of
a job that needed one — each finding nothing to do, having been preceded by the
run that did it, while its connection sat blocked for the duration. Skipping
makes the losers free.

The miss comes back as `{ acquired: false }` rather than as an exception,
because for the caller it is an ordinary outcome. It is a discriminated union
and not `T | null` because `null` is a value the callback may legitimately
return, and "nobody else was running, and the answer is nothing" must stay
distinguishable from "somebody else is running".

## Naming a lock

```ts
export const IDEMPOTENCY_PURGE_LOCK = advisoryLockKey('boilerplate-express-ts', 'idempotency.purge');
```

**The two-`int4` form, not the `bigint` one.** Postgres offers both and they are
separate lock spaces — a session holding `pg_advisory_xact_lock(1, 2)` does not
block `pg_advisory_xact_lock(4294967298)` despite the matching bits, and
`pg_locks` tells them apart by `objsubid` (1 for the bigint form, 2 for the
pair). The space is global to the database and shared with everything else
connected to it; `node-pg-migrate` takes an advisory lock of its own around a
migration run. Using the form this codebase does not otherwise use, under a
`classId` derived from a namespace string, keeps an accidental collision with
somebody else's key out of the picture at no cost.

**The digest is a deployed contract.** Two replicas exclude each other only by
computing the same two integers, so how they are derived is not an
implementation detail — changing it has to go out everywhere before it means
anything. That is why it is SHA-256 of the name rather than a JavaScript string
hash, and why a unit test pins the integers for the one key this service
declares.

**A collision inside the namespace is a latency bug, not a correctness bug.**
`objId` is 32 bits, so two names in one namespace can hash to the same lock:
two unrelated jobs serialise against each other. That is a false conflict and
never a missed one. It is still the reason to keep a namespace to a handful of
named coordination points rather than minting a key per row — at a few dozen
names a collision is vanishingly unlikely, at tens of thousands it is expected,
and a per-row mutex is `SELECT ... FOR UPDATE`, which has the row and needs no
hash at all.

## Session-scoped locks, and making *their* release automatic

`withAdvisorySessionLock` holds a key across transactions on a connection pinned
for the duration. It exists for the case the transaction-scoped pair cannot
serve: work that runs for minutes.

A transaction open that long pins its connection *and* holds back the cluster's
`xmin` horizon, so autovacuum cannot reclaim dead tuples anywhere in the
database while it runs — a job that wanted a mutex ends up bloating tables it
never touched. It is also the only option for work that must commit
incrementally, such as a relay marking each batch delivered as it goes.

The cost is that the release is no longer free. A session lock is released when
the session ends, and a pooled connection's session does not end: it goes back
into the pool still holding the key, and the next request to pick it up owns a
lock it never asked for. So the unlock is explicit, and the interesting part is
what happens when the explicit unlock does not work:

| outcome | what it means | what happens |
|---|---|---|
| `pg_advisory_unlock` → `true` | released | connection returns to the pool |
| → `false` | this session did not hold it (Postgres also warns) | connection **destroyed** |
| throws | connection state unknown | connection **destroyed** |

Destroying the connection *is* the release: ending the session is what Postgres
drops session locks on. The alternative is a key held until the process exits,
silently, by a connection nobody can identify.

Two more consequences of the pinned connection:

- **`lockTimeoutMs` is applied with `SET LOCAL` inside a short transaction that
  exists only to take the lock.** The session lock survives that transaction's
  `COMMIT`; the setting does not, which is the point — a session-level `SET` on
  a pooled connection outlives the request that made it.
- **It is not reentrant.** Each call checks out its own connection, so a nested
  acquisition of the same key is a *different* session asking a holder to let
  go. Under `wait` that is a self-deadlock no detector will report, since the
  two are not waiting on each other in the graph — the outer one is not waiting
  at all. Hence the default of `nowait`, where the nested call cleanly answers
  `{ acquired: false }`.

## What it was wired into

`idempotency_keys` was append-only in practice. `claim` inserts, `complete`
updates, and nothing ever deleted an expired row — `claim` treats one as absent,
so nothing was *incorrect*, and the table simply grew for the life of the
deployment. `PostgresIdempotencyStore.purgeExpired` had existed since the record
was introduced and was called by exactly one thing: its own unit test.

```
IDEMPOTENCY_PURGE_INTERVAL_SECONDS=3600   # 0 disables the in-process job
```

Every replica runs the schedule; the lock decides which one sweeps on any given
tick. Nominating one replica instead would need a way to nominate it, which is a
leader election, which is the thing the lock already is.

Three properties of the scheduler are load-bearing rather than tidy:

- **The delete runs on the locked transaction.** `purgeExpired` takes the
  optional `Queryable` every database-backed method here takes. Sent to the pool
  it would land on a different connection — still serialised, since the
  transaction stays open across the await, but no longer covered by the lock,
  and now vulnerable to `idle_in_transaction_session_timeout` ending the
  lock-holder while the delete is still running.
- **Runs never overlap in-process.** The lock excludes *replicas*; it cannot
  exclude a second tick on the same one, because a pool hands each tick a
  different connection and both would legitimately acquire. A sweep that outruns
  its interval skips ticks rather than stacking.
- **A failure never escapes.** An unhandled rejection from a timer callback is
  attributable to no request and, under Node's default
  `--unhandled-rejections=throw`, takes the process down. A janitor that cannot
  reach the database must not be able to kill a service that is otherwise
  answering fine.

The timer is `unref`'d for the same reason: the least important thing in the
process should not be the thing deciding when it exits.

The job is started in `server.ts` and not in `createApp()`, because a background
timer belongs to the process rather than to the application object — every e2e
suite builds an app, and none of them should acquire a lock, sweep a table or
leave a handle behind. `runIdempotencyPurge` is exported separately so a
deployment that prefers an external cron can call it and exit; the lock is what
makes that safe to run alongside the in-process schedule.

## What is deliberately not here

**No lock table, no lease, no fencing token.** All three exist to answer "the
holder died"; a transaction-scoped advisory lock answers it by construction. A
system that outgrows this needs them, and the moment it does is the moment the
lock has to be held by something that is not a live Postgres session.

**Nothing is retried on `55P03`.** Unchanged from
[the retry wrapper's rules](./pessimistic-locking.md): a lock timeout is the
caller's own deadline expiring, and re-entering the same wait immediately is a
busy-wait against a holder that is still holding.

**Advisory locks are per-database, not per-cluster.** Two services in two
databases on one server do not exclude each other whatever they name their keys.

**They do not survive a connection pooler in transaction mode.** Session-scoped
advisory locks assume the session is yours for its lifetime, which is precisely
what PgBouncer's transaction pooling takes away. The transaction-scoped family
is safe there; `withAdvisorySessionLock` is not.
