# BullMQ job queue: retries, full-jitter backoff, and a dead-letter queue

`src/queue/` is a typed job queue on top of [BullMQ](https://docs.bullmq.io):
an API replica **enqueues** a unit of work, a worker process **runs** it, a
failure is **retried** on a ladder with a ceiling, and a job the ladder gives up
on is copied to a **dead-letter queue** where a person can read it and put it
back.

Run the worker as its own process:

```bash
REDIS_URL=redis://localhost:6379 pnpm worker:queue
```

Nothing is wired to Redis by default. With `REDIS_URL` empty — the shipped
default — the API boots exactly as before and no queue is constructed.

---

## Why not the Redis Streams consumer that is already here

Both are Redis, both have a worker process, and both have somewhere for what
failed to end up. They answer different questions.

`src/redis/` carries **events**. A stream is an append-only log; a consumer
group hands each entry to one member; a second group can read the same history
without taking anything away from the first. What it has no notion of is
*scheduling a single entry*: there is no "run this again in 400ms", no per-entry
attempt budget, no priority. An entry that fails is redelivered whenever the
reclaim loop next notices it has been idle for `REDIS_STREAM_MIN_IDLE_MS`.

`src/queue/` carries **work**. Every job has its own delay, priority, attempt
ceiling and backoff, and the queue exists to run it once rather than to record
that it happened.

The rule of thumb: if two subscribers might want it, it is an event. If exactly
one thing has to happen and the timing of the retry matters, it is a job. A
subscriber on the bus enqueuing a job is a normal shape; the reverse is not.

## The shape of it

```
                   API replica                         worker process
   ┌───────────────────────────────────┐   ┌────────────────────────────────────┐
   │ producer.enqueue('name', payload) │   │  createJobQueueWorker              │
   │   → { payload, correlationId }    │   │    ├─ name → handler (exhaustive)  │
   │   → attempts, backoff, retention  │   │    ├─ envelope → payload           │
   └────────────────┬──────────────────┘   │    └─ handler(payload, context)    │
                    │                      └──────┬──────────────────┬──────────┘
                    ▼                             │ throw            │ throw
              ┌──────────┐                        ▼                  ▼
              │  jobs    │◀── retry (delayed) ── ladder ──▶ last attempt
              └──────────┘                                          │
                    ▲                                               ▼
                    │                                    ┌─────────────────────┐
                    └──── replayDeadLetters ─────────────│ jobs-dead-letter    │
                                                         └─────────────────────┘
```

Five files carry the decisions:

| file | what it owns |
| --- | --- |
| `queue.types.ts` | the payload map, the handler table, the envelope |
| `retry.ts` | the ladder — attempts on the producer, delays on the worker |
| `producer.ts` | `enqueue`, and the job options every job is written with |
| `worker.ts` | name → handler, the backoff registration, the terminal-failure hook |
| `dead-letter.ts` | the record, its bound, and the store it is written through |

## One payload map, both ends

BullMQ's generics are per-`Queue`: `Queue<TData, …>` fixes one payload type for
every name on that queue. A service whose queue carries several kinds of work
can only satisfy that with `TData = unknown` and a cast in every handler — which
puts the one thing a type system is for on the far side of a process boundary
and a JSON round-trip.

So the map is declared once and both ends are typed against it:

```ts
export type AppJobPayloads = {
  'auth.magic-link.deliver': { email: string; token: string; expiresAt: number };
};
```

`enqueue` refuses a payload that does not match its name, and
`JobHandlers<AppJobPayloads>` is exhaustive — adding a name to the map is a
compile error until something handles it.

What is stored is an **envelope**, not the payload itself:

```jsonc
{ "payload": { "email": "…" }, "correlationId": "req-abc" }
```

The nesting is what lets queue-level metadata be added without colliding with a
payload field, and without every payload type having to declare it. Today that
is the originating request's `x-correlation-id`, so a log line a handler writes
minutes later joins back to the request that queued the work.

## The retry ladder, and the trap in the middle of it

BullMQ splits the ladder across two processes:

- **How many attempts** is a *job* option, written into Redis by the producer.
- **How long between them** is a *worker* setting, resolved where the job runs.

That split is genuinely useful — a deployment can change its backoff without
re-enqueuing anything — but it means the two ends have to agree about a strategy
*name*, and the failure mode when they do not is unusually bad. A job carrying
`backoff: { type: 'full-jitter' }` that fails on a worker with no such strategy
registered makes BullMQ's `lookupStrategy` throw from inside `Job#moveToFailed`
— that is, from the code whose entire job is to handle a throw. The original
failure is lost and the worker reports something else.

So neither end names the strategy. `retryJobOptions` and
`createFullJitterBackoffStrategy` both take one `RetryPolicy` and both use a
constant that is not exported:

```ts
const retry = {
  attempts: env.JOB_QUEUE_ATTEMPTS,
  baseDelayMs: env.JOB_QUEUE_BASE_DELAY_MS,
  maxDelayMs: env.JOB_QUEUE_MAX_DELAY_MS,
};

createJobProducer<AppJobPayloads>({ queue: toJobQueueWriter(queue), retry });
createJobQueueWorker<AppJobPayloads>({ connection, queueName, handlers, retry, deadLetter });
```

### Why a custom strategy at all

BullMQ 6 ships `exponential` with a `jitter` fraction, and `jitter: 1` is
arithmetically identical to full jitter. It is not used here because it has **no
ceiling**: its window is `2^(attempt-1) * delay` for as many attempts as the job
has. Raising `attempts` from 5 to 12 turns a 16-second worst case into a
two-hour one, silently.

`fullJitterDelay` from `@/lib/backoff` takes a `maxMs`, so "how many times" and
"how long between" stay independent operational decisions. It is also the same
function the outbox relay, the stream worker's reconnect loop, `withRetry` and
the serialisation-failure retry use — so the reason for *full* jitter, that
everything which failed together would otherwise retry together and hand the
recovering dependency the same spike that took it down, is written down once.

`env.ts` refuses `JOB_QUEUE_MAX_DELAY_MS < JOB_QUEUE_BASE_DELAY_MS` at boot: a
ceiling below the first rung is not a slow ladder, it is one that never widens.

### Skipping the ladder

Some failures are failures of the *job*, not of the *attempt*. A timeout talking
to a mail provider is the second kind — the next attempt runs against a
different second and may well succeed. A payload naming a user that no longer
exists is the first: four more attempts produce four more identical failures and
a dead-letter record a minute later than the one available immediately.

```ts
throw new UnprocessableJobError('the user no longer exists');
```

It subclasses BullMQ's `UnrecoverableError`, because the check that matters
happens inside `Job#shouldRetryJob` where our code does not run — `instanceof`
is the only thing that reaches it.

## The dead-letter queue

Terminal failures are copied to `<queue>-dead-letter`, a queue **nothing
consumes**. Its jobs sit in `wait` forever, which is the point: `wait` is the
inbox.

### Why not just use the failed set

BullMQ already keeps failed jobs, so "we have a dead-letter queue already" is a
reasonable first reaction. Three things are wrong with it:

- The failed set holds every failed *attempt*'s end state, including jobs that
  went on to succeed. A queue with a flaky dependency fills it with jobs that
  are fine.
- Its retention is a memory-cleanup policy (`removeOnFail` counts and ages), so
  the entries worth reading are evicted on the same schedule as the noise.
- It is not a worklist. `job.retry()` puts one job back; there is nowhere to see
  "everything we have given up on".

### What the transfer guarantees

The copy happens **after** BullMQ has moved the job to `failed`, so a worker
that dies in between leaves the record unwritten. That is why
`createJobProducer` refuses a `retention.failed` below 1: the failed set is the
durable backstop, and the dead-letter queue is a convenient index over it rather
than the authority. A lost write is reported through the sink's `onError` and
recoverable by hand; it is not silent loss.

In the other direction the transfer is idempotent. The record's job id is
`dlq:<queue>:<jobId>`, and BullMQ does not add a second job under an id already
present — so a job re-processed after a stall and failed again produces one
record, not two.

The queue is bounded (`JOB_DEAD_LETTER_MAX_SIZE`, oldest evicted first) for the
reason the stream parking lot is: records arrive at the rate things go wrong
rather than at the rate things happen, and one that ages out unexamined was
never going to be examined. It is still a bound — a producer emitting malformed
payloads in a loop would otherwise fill the instance with the evidence of it.

### Redaction

A dead-letter record is the longest-lived copy of a payload in the system: the
source job is evicted within hours and this sits in `wait` until somebody looks.
Any payload carrying a credential must not be kept that way.

```ts
createDeadLetterSink({ store, redact: redactAppJobPayload });
```

The redaction is **per job name**, not "blank anything called `token`". The
blanket rule reads as safer and is not: it fails silently the first time
somebody names a field `secret` or nests one a level down. Naming the job that
has a credential is a decision a reviewer can check against the payload map.

The cost is stated rather than hidden: a redacted record cannot be replayed,
because what was kept is the redacted payload. Redaction is therefore also a
decision about whether a job name is replayable at all.

### Replay

```ts
const outcome = await replayDeadLetters({
  store: createBullDeadLetterStore(deadLetterQueue),
  producer,
  only: ['upload.transcode'],   // optional
  limit: 100,
});
// → { examined, replayed, skipped, failed }
```

Re-enqueue first, then delete the record. A crash between them leaves a dead
letter that has already been replayed, so the next replay runs the job twice;
the other order loses the work entirely. Every handler here is required to be
idempotent — delivery is at-least-once regardless — so a duplicate is absorbed
while a loss is not recoverable from anywhere.

Replay is deliberately manual, a script or an admin route and never a timer.
Everything in this queue failed the ladder already; a loop that put it back
automatically would be a slower version of the ladder with no ceiling.

## The worked example: magic link delivery

`MagicLinkDelivery` was written as a port because the transport is
deployment-specific — "SES here, Postmark there, a queue somewhere else". This
is the queue.

```ts
// composition root — not the shipped default; see below
const delivery = createQueuedMagicLinkDelivery(producer);
```

This is opt-in rather than wired in, for the same reason nothing else here talks
to Redis by default: `selectMagicLinkDelivery` still returns the in-process
delivery, so a clean clone boots and logs in without a Redis running, and the
e2e suite can still read a token back out of the recording inbox. Swapping it is
one line in the composition root once `REDIS_URL` is set and
`pnpm worker:queue` is running.

Inline, a slow mail provider is a slow login endpoint and a down one is a 500
the user reads as "login is broken" — on an endpoint that is deliberately
reachable without credentials. Queued, the request returns 202 either way and a
provider outage is retried over about a minute.

Two details are worth copying:

- The job id is `magic-link:<email>:<expiresAt>`, never the token. A job id is
  readable from `getJobs`, from a queue UI, and from any log line that renders a
  job. Deriving it also makes the enqueue idempotent, so an issuer retried by
  its own caller queues one send.
- The handler refuses a link whose `expiresAt` has passed, with
  `UnprocessableJobError`. Delivering an expired link is a support ticket rather
  than an error, and retrying cannot make it less expired.

The worker builds the **real** delivery, never the queued one: a queued delivery
handed to its own handler would enqueue a copy of every job it ran.

## Operating it

```bash
# one worker process; scale by replica count, not by concurrency alone
REDIS_URL=redis://localhost:6379 pnpm worker:queue
```

| variable | default | what it decides |
| --- | --- | --- |
| `JOB_QUEUE_NAME` | `jobs` | the queue produced onto and consumed from |
| `JOB_QUEUE_PREFIX` | `bull` | Redis key namespace; must match in both processes |
| `JOB_QUEUE_ATTEMPTS` | `5` | runs before a job is dead-lettered, counting the first |
| `JOB_QUEUE_BASE_DELAY_MS` | `500` | first retry's window; doubles per attempt |
| `JOB_QUEUE_MAX_DELAY_MS` | `30000` | ceiling on any single delay |
| `JOB_QUEUE_CONCURRENCY` | `4` | jobs one process runs at once |
| `JOB_QUEUE_LOCK_DURATION_MS` | `30000` | how long a crashed worker's job stays locked |
| `JOB_QUEUE_KEEP_COMPLETED` | `1000` | completed jobs kept |
| `JOB_QUEUE_KEEP_FAILED` | `5000` | failed jobs kept — the dead-letter backstop |
| `JOB_DEAD_LETTER_MAX_SIZE` | `10000` | dead-letter records kept |

**Concurrency is not a thread pool.** The jobs share one event loop, so it buys
overlap on I/O and nothing at all on CPU — and it multiplies how many jobs a
`SIGKILL` leaves for another worker to reclaim. CPU-bound work belongs in
`src/workers/` (see [worker-pool.md](./worker-pool.md)); a job that needs it
should dispatch to the pool rather than run it inline.

**The lock duration is the stall trade.** BullMQ renews a job's lock every half
of it while the handler runs, so it bounds recovery after a *crash* rather than
the handler itself. Set below the slowest healthy handler, it classifies a slow
job as a dead one and runs the work twice, concurrently — the same trade
`REDIS_STREAM_MIN_IDLE_MS` makes.

**Shutdown drains.** `SIGTERM` stops the fetch and waits for the jobs in flight.
Killing the connection instead abandons a handler mid-job: the job keeps its
lock until it expires, is treated as stalled, and runs a second time — paying
for a second of shutdown in duplicate side effects.

## Testing it

`queue.integration.test.ts` runs against a real Redis, because what it asserts
is BullMQ's behaviour rather than ours: that a strategy registered on the
*worker* is the one that gets called, that the delay it returns lands on the
delayed job, that `finishedOn` marks the last attempt and not the ones before
it, that an `UnrecoverableError` subclass really does skip the ladder, that a
duplicate `jobId` is silently not added, and that reading the wait list with
`asc` yields the oldest entries. A fake asserting those would only be asserting
what its author believed.

It skips itself without `REDIS_TEST_URL` so a contributor without Redis can
still run `pnpm test`; `redis.guard.test.ts` fails the build if `CI` is set and
the variable is not.

Everything else is unit-tested without a Redis, which is what
`createJobProcessor` and `createFailureListener` are exported for: constructing
a `Worker` to reach the name lookup or the terminal-failure rule would mean a
server for every test of either.
