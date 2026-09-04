# Redis Streams: a consumer group with claim-on-stall recovery

`src/redis/` is a durable work queue built on Redis Streams: a producer appends
event envelopes to a stream, a **consumer group** divides them among worker
replicas, and entries that a replica took but never finished are **reclaimed**
by the survivors after an idle timeout.

Run the consumer as its own process:

```bash
REDIS_URL=redis://localhost:6379 pnpm worker:stream
```

Nothing is wired to Redis by default. With `REDIS_URL` empty — the shipped
default — the API boots exactly as before and the outbox relay keeps publishing
to the claiming replica's in-process bus.

---

## Why a consumer group at all

`XREAD` gives every reader every entry, so N replicas do the work N times. A
consumer group partitions instead: each entry goes to exactly one consumer, and
the group records what it handed out in the **pending entries list** (PEL) until
that consumer acknowledges it.

The PEL is the whole reason this is more than a fan-out. A consumer that dies
mid-entry leaves the entry in the list, owned by a name that will never come
back, where another consumer can find it by how long it has sat idle. Nothing
else in Redis gives you that.

What you give up is **ordering**. Entries go to whichever consumer asked first,
a failed entry stays pending while later ones are processed, and a reclaim can
run an entry minutes after the ones behind it. A handler that assumes "the
update always arrives after the create" is wrong on the first retry, not on the
first outage.

## The shape of it

```
 request ──▶ outbox_messages ──▶ relay ──XADD──▶ stream ──┬─▶ worker A ─▶ local bus
             (same transaction)                            ├─▶ worker B ─▶ local bus
                                                           └─▶ worker C ─▶ local bus
                                        each entry to exactly one of them
```

Four files carry it, and the split is deliberate:

| file | what it owns |
| --- | --- |
| `stream.types.ts` | the port — seven commands in this application's vocabulary |
| `ioredis.adapter.ts` | the only file that imports `ioredis` |
| `resp.ts` | reply parsing, pure, pinned to real transcripts |
| `stream.worker.ts` | the loop: read, handle, acknowledge, reclaim, park |

`stream.publisher.ts` is the producing end, `parking-lot.ts` the end of the
road for an entry nothing can process, and `stream.memory.ts` an in-memory
implementation of the port so a handler's tests need no server.

---

## At-least-once, and where the "at least" comes from

An entry is acknowledged **after** its handler resolves. A crash in between
leaves it pending; it is reclaimed on idle time and runs again. Acknowledging
first would trade that for lost work, which is not a trade — a duplicate is
recoverable by an idempotent handler, a loss is recoverable by nothing.

So: **handlers must be idempotent.** `envelope.id` is stable across every
redelivery (it is the outbox row's primary key, carried in the entry rather than
assigned by Redis), so "have I already done this one" is answerable.
`context.deliveryCount` tells a handler which attempt this is.

With `OUTBOX_DISPATCH_TARGET=redis-stream` there are two at-least-once hops
rather than one — the relay may republish an entry it already wrote if it dies
before deleting its row — and both are answered by that same id.

## Retries are idle time, not a timer

There is no retry scheduler here, because Redis already keeps one per entry. A
handler that throws simply does not acknowledge; the entry stays in the PEL and
its idle clock runs. Once it passes `REDIS_STREAM_MIN_IDLE_MS`, the next reclaim
picks it up. The idle floor *is* the backoff interval.

## Claim-on-stall, step by step

Every `REDIS_STREAM_RECLAIM_INTERVAL_MS`, before reading anything new:

1. `XPENDING key group IDLE <minIdle> - + <count>` — entries nobody has
   acknowledged in that long, with their **delivery counts**.
2. `XCLAIM key group <us> <minIdle> <ids…>` — take them, repeating the idle
   floor.
3. Anything already at `REDIS_STREAM_MAX_DELIVERIES` is parked instead of run.

Three details matter.

**The idle floor is repeated on the claim on purpose.** Between the `XPENDING`
that selected an id and the `XCLAIM` that takes it, another worker may have
claimed it and reset its clock. Passing the floor again makes the server refuse,
atomically and per entry — so two workers reclaiming in the same instant divide
the entries instead of duplicating them. A short claim is therefore ordinary,
not an error.

**A short claim can also mean the entry is gone.** `MAXLEN` can evict an entry
that is still pending; Redis drops the dangling reference when it is claimed.
That is the one place work is genuinely lost here, and the reason
`REDIS_STREAM_MAX_LEN` is a safety margin over the worst tolerable backlog
rather than a queue depth.

**`XAUTOCLAIM` is not used.** It does the same job in one round trip and does
not report delivery counts. Without them there is no way to distinguish a
consumer that died holding good work from an entry that *kills* consumers: both
are idle, both get claimed, and the poisoned one is claimed again a minute
later, forever. The extra round trip buys the ceiling that stops that.

## The invariant that will bite you

```
REDIS_STREAM_MIN_IDLE_MS  >  REDIS_STREAM_HANDLER_TIMEOUT_MS
```

An entry's idle clock starts when it is delivered, which is the instant its
handler starts. A handler allowed to run for the timeout will routinely leave an
entry idle for that long **while nothing is wrong**. Set the reclaim floor at or
below it and a merely-slow consumer's entries become claimable: the same work
runs twice, concurrently, on a healthy system, and it looks like a
duplicate-processing bug rather than a configuration one.

Both `createStreamWorker` and the env schema refuse the combination at boot.

## Poison entries and the parking lot

Two things take an entry out of the retry cycle:

- **`delivery-ceiling`** — its handler failed `REDIS_STREAM_MAX_DELIVERIES`
  times.
- **`undecodable`** — it is not a valid envelope. Parked on the *first*
  delivery, without consuming the ladder: nothing about a second `JSON.parse` on
  the same bytes goes differently.

Parked entries are written to `<key>:parked` with their original fields intact
plus `park.reason`, `park.lastError`, `park.deliveryCount`, `park.sourceStream`,
`park.sourceEntryId` and `park.parkedAt`, then acknowledged. Because the
original fields are stored beside the metadata rather than nested inside it, a
replay is an `XRANGE` and an `XADD` back onto the source:

```bash
redis-cli XRANGE domain-events:parked - + COUNT 10
```

The park runs **before** the acknowledgement, so a parking lot that is itself
down leaves the entry pending to be parked again later, rather than dropping it.

This is not the dead-letter queue of the next spec item: there is no retry
ladder, no scheduler and no automatic replay. It is the durable end of the road.

## Trimming, and the thing everybody gets wrong

**Acknowledging an entry does not remove it from the stream.** `XACK` clears the
pending entry; the entry itself stays where it is, forever. A stream consumed
perfectly by a healthy group grows without bound until the instance runs out of
memory, and the incident looks like a Redis problem rather than a producer that
never trimmed.

So the producer caps it: `XADD … MAXLEN ~ <n>`. Approximate by default, because
exact trimming has to split the radix-tree node containing the boundary and
makes every append pay for it.

## Shutdown

`worker.stop()` finishes the tick in flight before resolving — up to one block
plus one handler. Dropping the connection to cut that short would abandon a
handler mid-entry, and the entry would be reclaimed and its work repeated to
save a second of shutdown. `REDIS_STREAM_BLOCK_MS` is therefore the floor on how
long a graceful stop takes.

Afterwards the consumer is retired, **but only if it holds nothing**:
`XGROUP DELCONSUMER` does not hand a consumer's pending entries to anybody, it
deletes them. A consumer still holding work is left in place, and another
replica reclaims its entries on idle time.

This is also why `REDIS_STREAM_CONSUMER` should be stable per replica — the
hostname, which is what it defaults to. A name containing the pid makes every
restart a new consumer, leaving the old one in `XINFO CONSUMERS` forever.

## Two connections, never one

A blocking `XREADGROUP` owns its connection for the whole block. An `XACK` sent
on the same one queues behind it and lands up to `blockMs` late; a shutdown
trying to retire a consumer cannot get a command through at all. Redis clients
do not multiplex, so `createStreamConnections` opens two — `blocking` and
`commands` — and the split is in the type so it cannot be got wrong by accident.

## When Redis is down

The loop logs and retries with an escalating, jittered backoff (500ms doubling
to 30s). Without it a read against an unreachable server rejects instantly and
the loop is a busy wait for the length of the outage, on every replica at once.
The pause is interruptible: a `SIGTERM` during an outage does not wait out the
ladder.

`NOGROUP` is handled separately, because it is recoverable in exactly one way —
recreate the group. It is logged loudly, because the new group starts at `$` and
entries written while it was missing are delivered to nobody.

## Testing

- `stream.memory.ts` implements the port in memory with an injectable clock, so
  a handler's tests — and the worker's own — need no server and no waiting.
- `redis.integration.test.ts` proves the claims that are about **Redis** rather
  than about the loop, against a real server: that `XCLAIM` refuses an entry
  below the idle floor, that `XPENDING` reports delivery counts, that a pending
  reference to a trimmed entry is dropped, that `DELCONSUMER` destroys pending
  entries, that `XREADGROUP >` never redelivers.

It skips itself without `REDIS_TEST_URL` so a contributor with no Redis can
still run `pnpm test`; `redis.guard.test.ts` fails the build if that skip ever
applies in CI.

That division is load-bearing. A fake asserting Redis's semantics only asserts
what its author believed — and running the adapter against a real server is what
caught the reply-shape divergence in `parseReadGroupReply`, where `ioredis`
returns RESP2's array-of-pairs through its typed helper and RESP3's flattened
map through `call`.

## Configuration

Everything is in `.env.example` under **Redis Streams consumer**. The ones worth
thinking about:

| variable | default | what it decides |
| --- | --- | --- |
| `REDIS_URL` | *(empty)* | Empty disables the subsystem entirely |
| `REDIS_STREAM_MAX_LEN` | `100000` | Safety margin over the worst backlog; entries evicted while pending are lost |
| `REDIS_STREAM_MIN_IDLE_MS` | `30000` | Recovery latency after a replica dies. Must exceed the handler timeout |
| `REDIS_STREAM_HANDLER_TIMEOUT_MS` | `10000` | Bounds the worker's *wait*, not the work |
| `REDIS_STREAM_MAX_DELIVERIES` | `5` | Attempts before an entry is parked |
| `REDIS_STREAM_BLOCK_MS` | `2000` | Also the floor on graceful shutdown |
| `OUTBOX_DISPATCH_TARGET` | `bus` | `redis-stream` moves subscriber work off the API replicas |

## Related

- `docs/outbox.md` — where the events come from, and why delivery is
  at-least-once before Redis is involved at all.
- `docs/event-bus.md` — what a subscriber sees once an entry has been decoded.
