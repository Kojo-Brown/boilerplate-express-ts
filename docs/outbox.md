# Transactional outbox

`POST /v1/users` used to do this:

```ts
const user = await users.create(req.body);        // commits
await bus.publish('user.created', { … });         // in-process, at-most-once
```

Two writes, to two systems, with a window between them. If the process dies in
that window the user exists and nothing downstream ever hears about it —
permanently, because the process that would have retried the publish is the one
that died. Neither side shows a trace afterwards: the row is there and looks
right.

Swapping the order does not help. Publish first and a rolled-back insert
announces a user that does not exist, which is worse — a subscriber acting on
it has nothing to read.

There are only two ways out: make the event part of the write, or make the
write part of the event. The outbox is the first. The event is inserted into
`outbox_messages` **inside the same transaction** as the row it describes, so
the two commit together or not at all, and a separate relay drains the table.

```ts
const user = await withTransaction(async (tx) => {
  const created = await users.create(req.body, tx);
  await outbox.enqueue(tx, 'user.created', { userId: created.id, … }, {
    correlationId: context.correlationId,
  });
  return created;
});
```

## The guarantee, exactly

**At-least-once.** Every enqueued message is delivered at least once, and may
be delivered more than once. That is not a gap to be closed later — exactly-once
delivery between two systems that cannot commit together does not exist, and the
honest arrangement is the one that never loses a message and says plainly that
it may repeat one.

The duplicate has a specific shape. One batch is one transaction: claim,
dispatch, delete, commit. A crash between the dispatch and the commit rolls back
the delete while leaving whatever the dispatcher already did done, so the next
relay claims the same row again.

Which makes the consumer's obligation the load-bearing half:

> **Subscribers must be idempotent**, and `event.id` is what they deduplicate
> on. It is the outbox row's primary key, and it does not change between
> deliveries — `PublishOptions.eventId` exists so the relay can hand it to the
> bus rather than letting a fresh one be minted per publish.

`event.occurredAt` is likewise the time the fact happened, not the time it was
delivered.

## Bus or outbox?

Both are still here, and a publisher picks:

| | `EVENT_BUS` | `OUTBOX` |
|---|---|---|
| Delivery | immediate, in-process | after the commit, by the relay |
| Guarantee | at-most-once | at-least-once |
| Survives a crash | no | yes |
| Needs a transaction | no | **yes** — it is the point |
| Cost | none | a row, and delivery latency |

The rule is the one `EventBusOptions.onHandlerError` already stated: the bus
carries consequences a publisher can afford to lose. Anything that must happen
even if this process dies in the next millisecond goes in the outbox — and
because it must join the caller's transaction, it is available exactly where
there is a write to be atomic with.

## Why `enqueue` takes a `TransactionClient`

An enqueue on the pool lands on a *different* connection. It commits whether or
not the write it describes does, so the failure mode inverts: instead of losing
an event for a row that exists, the service announces a row that was rolled
back. Neither symptom shows up in a single-request test.

So `enqueue` takes the branded `TransactionClient` (`IN_TRANSACTION`), and
passing the pool does not compile. Same brand, same argument as the row-lock
helpers: a defect whose only symptom is a race under load is worth a compile
error.

One consequence is worth stating: an enqueue is safe inside
`withRetryableTransaction`, where a `bus.publish` is not. A retried transaction
takes its writes back with it — including the outbox row — which is exactly what
the retry contract asks of a callback and exactly what a published event cannot
offer.

## The table

```
outbox_messages
  id            uuid  primary key   -- also the delivered event's id
  seq           bigserial           -- claim order (not commit order — see below)
  event_name    text
  payload       jsonb
  correlation_id text
  occurred_at   timestamptz         -- transaction_timestamp() of the enqueue
  status        text                -- 'pending' | 'dead'
  attempts      integer
  available_at  timestamptz         -- earliest next attempt
  last_error    text
```

**Two states, not three.** A delivered row is deleted, not marked `published`.
Nothing ever reads a delivered outbox row, so keeping it turns a queue into an
unbounded log and needs a second janitor to stop it growing — the defect PR #33
found in `idempotency_keys`. The steady-state size of this table is the backlog,
not the traffic.

**`seq` is a tiebreak, not an ordering guarantee.** A sequence value is assigned
at INSERT, so a transaction that took its number first can commit second, and
the relay sees the later number first. Ordering by it keeps a backlog draining
roughly FIFO. Per-aggregate ordered delivery needs a partition key and one
in-flight message per key — a broker's job, and deliberately not this table's.

## The relay

```
withTransaction:
  SELECT … WHERE status='pending' AND available_at <= now()
    ORDER BY available_at, seq LIMIT $1 FOR UPDATE SKIP LOCKED
  for each message:
     dispatch  → DELETE
     failed    → attempts+1, available_at = now() + backoff, last_error
     exhausted → status = 'dead'
  COMMIT
```

**`FOR UPDATE SKIP LOCKED`, not an advisory lock.** The idempotency purge takes
an advisory lock because a sweep wants exactly one winner. A queue wants every
worker busy: `SKIP LOCKED` lets each replica claim a disjoint batch and never
wait for another, so the backlog drains *faster* as replicas are added. Same
question, opposite answer, for a reason that is in the shape of the work.

**Claims are locks, not marks.** A relay that dies mid-batch releases its rows
the moment its connection does. A `status = 'in_flight'` column would need a
lease, a clock and a recovery sweep to reach the same place — and a lease that
expires while the dispatcher is still running redelivers a message *concurrently
with itself*, which a lock cannot do.

**The marks are inside the claim's transaction**, because a lock only exists for
as long as its transaction: a delete issued after the commit would race whichever
relay claimed the row in the meantime.

**The cost of that is a transaction held open for the batch**, holding a pooled
connection and the cluster's `xmin` horizon. It is bounded rather than hoped
about — worst case `OUTBOX_RELAY_BATCH_SIZE * OUTBOX_DISPATCH_TIMEOUT_MS` — which
is why the batch is 20 and the poll interval, not the batch size, is where
throughput comes from.

**A dispatcher failure is contained per message; a store failure is not.** The
first is not a SQL error, the transaction is healthy, and one poison message
must not cost the nineteen beside it their outcomes. The second means the
transaction is in doubt: it propagates, the batch rolls back, and the rows are
claimed again.

### The ladder

Full jitter (`lib/backoff.ts`), doubling from `baseDelayMs` to `maxDelayMs`, then
`status = 'dead'` after `maxAttempts`. Full jitter matters more here than
anywhere else in the codebase: every message in a batch that failed because one
dependency is down failed at the same instant, so a fixed ladder re-presents all
of them together and the recovering dependency meets the same spike that took it
down.

Dead rows are never claimed again and stay for a person to read — which is why
the schema refuses `status = 'dead'` without a `last_error`. There is no
automatic replay: a message that failed eight times over four minutes failed for
a reason, and moving it back to `pending` before anyone has looked is how a
poison message becomes an infinite loop with extra steps.

## Where delivery actually ends

The relay hands a message to an `OutboxDispatcher`, and **a dispatcher that
resolves has asserted delivery** — the row is deleted on the strength of it.

The shipped one publishes to the in-process bus, and it has to work slightly
harder than it looks. `bus.publish` isolates handler failures by design and
resolves regardless, so merely awaiting it would delete a durable row for an
event nothing processed. `createEventBusDispatcher` passes a per-publish
`onHandlerError`, collects the failures, and throws — so a failed subscriber is
a failed delivery and the ladder retries it.

That is what closes the exposure `session-revocation.subscriber.ts` documents:
for events routed through the outbox, revocation is no longer best-effort.

The cost, stated: **a retry redelivers to every subscriber**, not just the failed
one. The outbox holds one row per event, not one per subscriber; splitting it
would mean a per-subscriber cursor and a per-subscriber dead-letter, which is a
different data model rather than a tweak. Hence the idempotency rule above.

An event with no subscriber in this build is *delivered*, not owed — otherwise
every event a deployment does not consume would dead-letter. An event whose
*name* this build does not know is a different case: it throws
`UnknownOutboxEventError` and is retried, because the ordinary cause is a rolling
deploy and the deploy finishing is what makes the retry succeed.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OUTBOX_RELAY_INTERVAL_SECONDS` | `5` | Poll interval, and therefore delivery latency. `0` disables the in-process relay. |
| `OUTBOX_RELAY_BATCH_SIZE` | `20` | Messages per transaction. |
| `OUTBOX_RELAY_MAX_ATTEMPTS` | `8` | Attempts before dead-lettering. |
| `OUTBOX_DISPATCH_TIMEOUT_MS` | `5000` | How long the relay waits for one dispatch. |

Every replica relays. Disabling it loses nothing — messages accumulate and are
delivered by whichever relay runs next, which is what makes running the relay as
its own process a deployment decision rather than a code change.

## What is not claimed

- **Ordering.** None, beyond a rough FIFO within a backlog. See `seq` above.
- **Only `user.created` is routed through the outbox today.** `user.updated` and
  `user.deleted` still publish on the bus. Moving `user.deleted` trades
  *immediate best-effort* session revocation for *delayed guaranteed* revocation,
  which is a product decision about how long a deleted account may keep minting
  tokens, not a mechanical one — and it wants its consumers checked for
  idempotency first. The mechanism is here; that call is not this change's to
  make.
- **No dead-letter replay endpoint**, and no metrics beyond the relay's outcome
  log.
- **`LISTEN`/`NOTIFY`** would remove the poll's latency floor at the cost of a
  dedicated connection per replica. Not worth it at five seconds; revisit if the
  interval has to come down.
- **The dispatch timeout does not cancel the dispatch.** A promise cannot be
  cancelled. It bounds the relay's wait, and the work may still land — which is
  one of the ways delivery is at-least-once rather than exactly-once.
- **Payloads must survive `jsonb`.** The `JsonSafe` constraint on `enqueue`
  makes a `Date` or a `Set` in a payload a compile error, because a `Date`
  written here comes back a string and a `Set` comes back `{}`.
