# Graceful shutdown

A rolling deploy replaces every replica of this service. If a replica going away
drops requests, the deploy drops requests — once per replica, every deploy,
usually without a single line in a log, because the failures happen at the
connection layer where no handler ever runs.

The whole of this document is about two windows and the four phases that fill
them.

## `server.close()` is not a drain

The obvious implementation is the one that does not work:

```ts
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));   // hangs, and refuses traffic before it does
});
```

Two separate faults, and they fail in opposite directions.

### 1. It refuses traffic that was routed in good faith

`close()` shuts the listener immediately. But a load balancer does not know
that: it learns an instance is gone by polling it, so for up to one polling
interval it keeps routing requests here — and every one of them now meets a
closed port. The client sees `ECONNREFUSED`, which no application code can log,
because no application code was reached.

### 2. It then waits forever anyway

`close()` stops the listener and waits for open connections to end. HTTP/1.1
keep-alive means they do not end. The sequence, on Node 22:

1. A request is in flight when the signal arrives.
2. `close()` shuts the listener; the request is served normally.
3. The response goes out with `Connection: keep-alive`, because that is what was
   negotiated, so the socket stays open and idle.
4. `close()`'s callback never fires. The process sits there until the
   orchestrator's grace period expires and `SIGKILL` lands — killing *every
   other* in-flight request with it.

Node ≥ 19 closes connections that are already idle when `close()` is called, so
the version of this bug with no traffic at the moment of the signal works fine.
That is exactly why it ships. The socket that matters is the one that becomes
idle a few milliseconds *later*, and nothing in the runtime closes that.

Measured, in `src/shutdown/http-drain.test.ts`: with the fix suppressed, the
in-flight response still arrives in full and the drain is still unsettled a
second later.

## The shape

```
SIGTERM
  │
  ├─ 1. unready ───────── /v1/health → 503. Everything else served normally.
  │                       Waits SHUTDOWN_DRAIN_DELAY_MS for the balancer to notice.
  │
  ├─ 2. long-lived ────── SSE streams closed, WebSockets closed with 1001.
  │                       They never end on their own; the drain would wait out
  │                       the entire budget on them.
  │
  ├─ 3. in-flight ─────── Listener closed. Requests already running finish.
  │                       Background jobs stop and their current tick completes.
  │
  └─ 4. resources ─────── The Postgres pool, and the outbox's Redis connection.
                          Last, because everything above can still be using them.
```

Phases run in order; tasks inside a phase run together. One budget
(`SHUTDOWN_TIMEOUT_MS`) covers the whole sequence — not one per task, because
four tasks with a ten-second timeout each is a forty-second shutdown inside a
thirty-second grace period.

## Phase 1 is the one people leave out

It does no teardown at all. It flips readiness and waits.

```ts
{ name: 'unready', tasks: [waitTask('load-balancer-drain', env.SHUTDOWN_DRAIN_DELAY_MS)] }
```

Removing it reintroduces fault 1 above. `GET /v1/health` answers 503
`SERVER_DRAINING` from the first instant of shutdown, before anything has
closed, and the instance keeps serving every request normally for the whole
window. The gap between "stopped advertising" and "stopped listening" is what
the balancer needs in order to take this instance out of rotation while it is
still able to answer.

Size it above the readiness probe's period times its failure threshold. The
default, 5s, covers a Kubernetes probe on a 2s period; a 10s period wants 15.

The wait is deliberately **not** abortable by the shutdown budget. A wait the
deadline can cut short is a wait that does not reliably happen, and the
balancer's polling interval does not care that the process is in a hurry. The
boot-time check that `SHUTDOWN_DRAIN_DELAY_MS < SHUTDOWN_TIMEOUT_MS` is what
keeps that from eating the whole budget.

## Phase 3 and the `Connection: close` header

The drain (`trackHttpServer`) is what makes `server.close()` terminate. For each
exchange still open when the signal lands:

| state of the response | what happens |
| --- | --- |
| headers not sent | `Connection: close` is set — Node ends the socket after the response, and the client stops reusing it |
| headers already sent (a stream) | the body is allowed to finish, then the socket is `end()`ed |
| already finished, not yet closed | the socket is `end()`ed now |

`end()` and never `destroy()`: a FIN lets whatever is in the kernel's send
buffer arrive, while a destroy can surface at the client as a reset that
discards the response it was reading.

The tracking is installed at **startup**, not when the signal arrives — a
`request` listener attached at shutdown sees nothing already in flight, and
those are the only exchanges a drain exists to protect. It is attached with
`prependListener`, ahead of the application's own listener, so a request that
arrives mid-drain still has unsent headers when the header is set on it.

If the budget runs out first, the remaining connections are destroyed with
`closeAllConnections()` and the report says how many — which is the number of
clients that got a truncated response, and the one fact about a bad shutdown
worth having in a log.

### The narrow job of `shutdownGuard`

Three of the four lifecycle states pass straight through it, `draining`
included. What it catches is a request arriving on a **keep-alive socket opened
before the listener closed**: closing a listener stops new connections and does
nothing to established ones, and a client with a warm pool will happily send
another request down one. That request would otherwise be routed into an app
whose dependencies are being torn down underneath it. It gets a 503
`SERVER_SHUTTING_DOWN` with `Retry-After` and `Connection: close` instead — a
refusal a client may safely repeat, including a non-idempotent one, which is
precisely what a socket that vanishes mid-request does not give it.

## Phase 4, and why the pool is last

`pool.end()` waits for checked-out clients to be returned. Closing it while a
request is still running turns a graceful shutdown into a 500 the client did not
have to see; closing it while the outbox relay is mid-batch rolls back the
deletes for messages it has already dispatched, and every one of them is
redelivered by the next replica. Phase 3 finishing is what makes phase 4 quick.

The background jobs sit in phase 3 rather than phase 4 for the same reason.
`stop()` on the purge job and the relay both resolve once the tick in flight has
finished, and both of those ticks are holding a pooled connection inside an open
transaction.

## Exit codes

`clean` exits 0. Anything else — a task that failed, timed out, or was skipped
because the budget was already spent — exits 1. A deploy that is quietly cutting
connections on every replica it replaces looks identical to a healthy one from
the outside, and the exit code is the only place it shows.

A **second** signal exits immediately with 1. An operator sending one twice is
saying the sequence is taking too long, and a process that ignores repeated
signals is how people learn to reach for `kill -9` — which is the outcome this
module exists to avoid. It is also what makes a non-zero
`SHUTDOWN_DRAIN_DELAY_MS` bearable during local development: the first `Ctrl-C`
starts the window, the second skips it.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `SHUTDOWN_DRAIN_DELAY_MS` | `5000` | The phase-1 window. `0` for a deployment nothing is polling. |
| `SHUTDOWN_TIMEOUT_MS` | `25000` | The whole sequence. Must sit below the orchestrator's grace period. |

Kubernetes' `terminationGracePeriodSeconds` defaults to 30s, and that clock ends
in `SIGKILL`. The 5s difference is the margin the process needs to report what it
closed and exit on its own terms instead of being killed mid-sentence.

## The workers already do this

`pnpm worker:queue` and `pnpm worker:stream` have had their own shutdown
sequences since they were written, for the same reason and with the same
ordering argument: a BullMQ job abandoned mid-handler keeps its lock until it
expires, is treated as stalled, and runs a second time — paying for a second of
shutdown in duplicate side effects. They are separate sequences because they are
separate processes with nothing to drain: no listener, no in-flight requests.
