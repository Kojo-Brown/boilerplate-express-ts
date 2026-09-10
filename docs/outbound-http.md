# Outbound HTTP: a circuit breaker with a retry ladder inside it

`src/resilience/` is what this service calls other services with. One client per
dependency, and each one is a bulkhead around a retry ladder with full jitter,
around a circuit breaker that gets a vote on every attempt, with three deadlines
on each of those attempts.

```ts
import { createDependencyClient } from '@/resilience';

const payments = createDependencyClient({
  name: 'payments',
  baseUrl: 'https://payments.internal/v1/',
});

const response = await payments.fetch('charges/ch_123');
```

`fetch` is `fetch`: it returns a `Response`, a 4xx is a response and not a
throw, and the body is yours to read. Two things are different. It may have made
the request more than once, and it may refuse to make it at all — a
`CircuitOpenError` or a `BulkheadFullError`, both of which are `AppError`s and
therefore already a 503 with a `Retry-After` by the time the error middleware
sees it.

Three statuses come out of this module and the difference between them is the
one thing worth getting right:

| Error | Status | What it means |
| --- | --- | --- |
| `BulkheadFullError` | 503 | We declined. Too many calls to this dependency are already in flight. |
| `CircuitOpenError` | 503 | We declined. This dependency has been failing and we are not asking again yet. |
| `DependencyTimeoutError` | 504 | We asked. It did not answer in time. |

Only the 504 is a claim about the upstream, and only the 504 should page
whoever owns it. The two 503s are this service rationing itself.

Nothing in this service calls it yet. There is no outbound HTTP dependency here
today — Google OAuth goes through Passport's own transport and S3 through the
AWS SDK's — so this is the mechanism the first one uses, and the reason it is
written before there is a caller is that a retry policy invented at the call
site is how every service ends up with four of them.

---

## Why retries need a breaker to be safe

A retry is a load multiplier aimed at whatever is already failing. Three
attempts is three times the traffic, arriving exactly when the dependency is
least able to serve it, and each attempt holds a socket and a slice of this
process for the length of its timeout. Retries alone turn a dependency's bad
minute into a caller's outage; that is the failure they are supposed to prevent.

The breaker is what bounds it. Once enough of a window has failed it stops
asking, and the cost of a call to a dead dependency drops from a timeout to a
thrown error. The two are one feature, and the ordering is not a preference:

**The breaker sits inside the loop and takes a permit per attempt.** From
outside it would see one outcome per call, count a third of the real traffic,
and shed load a window later than the traffic it is shedding. `http-client.test.ts`
pins this — three attempts of one failing call record three failures, not one.

The same arithmetic is an invariant in `env.ts`:
`HTTP_CLIENT_BREAKER_MIN_THROUGHPUT` may not be below
`HTTP_CLIENT_RETRY_ATTEMPTS`. Below it, one unlucky call's own ladder fills the
window at a 100% failure rate and opens the circuit for everybody.

## Why this is not `withRetry`

[`withRetry`](./route-decorators.md) already retries, and it is not this. It
wraps a `RouteOperation` — an inbound request this service is answering — and
retries on a **throw**. Outbound, the failure that matters most is a *value*: a
`Response` with a 503 in it is a successful `fetch`, and a loop written around
exceptions never sees it. The outbound loop also has to read `Retry-After` off
the response, drain a body before discarding it, refuse to replay a stream body
and settle a breaker permit — none of which a `RouteOperation`, whose premise is
that it never touches a `Response`, has anything to say about.

What they do share is shared: `fullJitterDelay` is one function in
`@/lib/backoff`, used by both plus the job queue and the outbox relay, and this
branch pulled the abort-aware sleep out of `with-retry.ts` into
`@/lib/abortable-delay` so the two ladders cannot disagree about what happens
when the caller goes away.

## What counts as a failure

Two questions, deliberately separate, both answered by `classifyResponse`:

| Response | Retried | Counts against the dependency | Why |
| --- | --- | --- | --- |
| 2xx, 3xx | no | no | It answered. |
| 400, 401, 404, 409, 422 | no | **no** | It answered *correctly*. The request was wrong. |
| 408 | yes | yes | It gave up waiting for the request; sending it again is the point. |
| 429 | yes | yes | It is shedding load. Continuing to send is what the breaker exists to stop. |
| 500, 502, 503, 504 | yes | yes | Transient until proven otherwise. |
| 501 | no | no | A permanent statement about the endpoint, not a sick server. |
| Network fault | yes | yes | DNS, connect, TLS, reset. |
| `TypeError` with no `cause` | no | no | An invalid URL or option — a bug here, equally invalid next time. |
| Caller aborted | no | **not recorded at all** | See below. |

The 4xx row is the one that matters most. Counting 4xx would let a single caller
with a wrong URL open the circuit in front of a perfectly healthy dependency for
every other caller in the process.

500 is the debatable row. A deterministic bug returns it every time, so retrying
triples the load on a server that is already failing; it stays retryable because
500 is also what a healthy service returns for a dropped database connection or
a restarting pod, and because the breaker is what bounds the amplification.

**A cancelled request is neither.** When the caller's own signal aborts — the
browser hung up, an enclosing deadline blew — the permit is `ignore()`d: it
releases its half-open probe slot and records nothing. Counting it would open
circuits during a rolling deploy, when every in-flight request is cancelled and
every upstream is healthy.

## What may be replayed

Three independent reasons not to, each with a different silent failure:

- **The method.** `GET`, `HEAD`, `OPTIONS`, `TRACE`, `PUT` and `DELETE` are
  replayed. `POST` and `PATCH` are not, because a retry after an *ambiguous*
  failure — the write landed, the response was lost — charges the card twice,
  and a socket reset is indistinguishable from a lost response to a request that
  succeeded.
- **An `Idempotency-Key`.** A `POST` carrying one is replayed, because the key
  is the caller's own statement that a duplicate will be absorbed. It is the
  same contract this service offers its callers in [idempotency.md](./idempotency.md).
  `retry.retryNonIdempotent` is the escape hatch for an endpoint you know is
  idempotent in fact, whatever its method says.
- **The body.** A `ReadableStream` body is consumed by the first attempt. The
  second would send nothing and the origin would answer a truncated request with
  a 400 that reads like the caller's fault — so it is detected, not documented.

## The ladder

`fullJitterDelay` from `@/lib/backoff`, the same function the job queue and the
outbox relay use: a uniform draw from `[0, min(maxMs, baseMs · 2^(n-1)))`. Full
jitter rather than a fixed step because every caller that failed together is
otherwise on the same schedule, and the retry arrives as one spike that fails
the recovery the same way the original outage did.

`Retry-After` is honoured when the origin sends one, with two adjustments:

- **Jitter is added on top rather than replacing it.** Every client that
  received that response got the same number; honouring it exactly
  re-synchronises all of them onto one instant — the herd the header was sent to
  prevent.
- **A long one is not waited out.** Above `maxRetryAfterMs` the response is
  returned unretried, header intact. Ten minutes is an outage, not a blip, and
  holding an inbound request open to honour it converts one dependency's problem
  into exhausted capacity here.

The header itself is parsed by `parseRetryAfter` in `@/http`, which is two
grammars in one field name — `delta-seconds` or an `HTTP-date`. Writing its
tests found a real trap: `Date.parse('2000')`, `Date.parse('-5')` and
`Date.parse('1.5')` are all valid instants to V8, so a date-first parser reads
`Retry-After: 2000` as a date in the past and a malformed `-5` as one too. Both
collapse to "retry immediately", from an origin that was asking for the
opposite. Numbers are matched strictly first and a numeric field that fails that
grammar is rejected rather than handed to the date parser.

## Draining a body you are about to throw away

Before a retry, the discarded response's body is **read**, up to
`retry.drainBytes`. This is the line usually written as
`response.body?.cancel()`, and cancelling is the worst of the three options.
Measured against a local origin returning 200 KiB error bodies over three
attempts (`http-client.integration.test.ts`):

| Handling of the discarded body | TCP connections for 3 requests |
| --- | --- |
| Read it | **2** |
| Ignore it | 3 |
| `body.cancel()` | 4 |

Cancelling destroys a connection that has a half-read response on it and then
opens a replacement, so every retry pays a fresh TCP — and in production, TLS —
handshake at the moment the dependency can least afford one. Below about 64 KiB
all three are identical, which is why this stays invisible until an origin
starts returning a real error page.

The cap is what keeps "read it" from being an unbounded read of whatever an
angry proxy decided to send. Past it, cancelling is correct and the connection
is the price.

## The state machine

```
closed ──(failure rate ≥ threshold, with volume)──► open
  ▲                                                  │
  │                                          (openMs, jittered)
  │                                                  ▼
  └──────(halfOpenSuccessThreshold probes)──────  half-open
                                                     │
                                     (one probe fails)│
                                                     ▼
                                                    open
```

- The window is a ring of buckets, so history **slides** rather than resetting.
  A counter cleared on a timer forgets everything at once; a dependency that
  failed hard an hour ago and has been healthy since must not be one bad
  response from tripping.
- Nothing is scheduled. The open-to-half-open transition is evaluated when the
  state is read, so a breaker for a dependency nobody is calling costs no timer.
- `minimumThroughput` is what stops one failed call in a quiet minute from
  reading as a 100% failure rate. A breaker that opens on a single bad response
  converts a blip into a guaranteed `openMs` of outage.
- The probe instant is **jittered** across the last fifth of `openMs`. Every
  replica tripped at the same moment for the same reason, so an exact `openMs`
  sends all of them at the recovering dependency in one tick.
- One probe at a time. The question is "is it back", and asking it ten times in
  parallel is that herd again, aimed at the worst moment.
- Closing **clears the window**. Carrying the failures over would leave a
  dependency that just proved it recovered one unrelated 500 from re-tripping,
  and the circuit would flap for a full window after every incident.
- A probe carries the generation it was issued under, so one that settles after
  its episode ended is recorded but decides nothing — otherwise a straggler from
  a previous episode closes a circuit that has since reopened.

## Errors

`CircuitOpenError` is an `AppError`, so the existing translator chain answers a
caller that never learns a breaker exists: **503** with a `Retry-After` naming
the instant this breaker next admits a probe.

503 rather than the 504 `withTimeout` uses, and the difference is what the two
know. A timeout says the dependency has not answered *yet* — no estimate,
nothing to tell the client beyond "too long". An open circuit says we did not
ask and here is when we will, which is a `Retry-After` with a real number behind
it. A 504 carrying one would be inventing it.

That 503 is a claim about *this* service being unable to serve the request,
which is only true when the route has nothing degraded to offer. A route that
can serve stale data or omit a section should catch `CircuitOpenError` rather
than let it reach the error middleware — which is why the client throws instead
of returning a sentinel.

## The bulkhead

A circuit breaker needs failures. That is its whole premise, and it is also the
gap it leaves.

A dependency that degrades from 20ms to 5s does not fail. It *succeeds slowly*,
so every outcome the breaker records is a success and it stays closed —
correctly. What happens instead is arithmetic: at a steady 50 calls per second,
20ms of latency means one call in flight at a time, and 5s means 250. Each of
those 250 is holding an inbound request, a socket, and the heap behind a pending
response. Nothing has errored anywhere, no alert has fired, and this service is
out of capacity — including on the routes that never touch that dependency at
all.

That is the outage a bulkhead prevents, and why it is not an alternative to a
breaker but the other half of one:

- the **breaker** bounds calls to a dependency that is *failing*
- the **bulkhead** bounds calls to a dependency that is merely *slow*

`Bulkhead` is a fair semaphore with a bounded queue and a deadline on the queue.
Three numbers:

- `maxConcurrent` — calls in flight at once. A statement about how much of *our*
  capacity we will let one upstream own, not about what the upstream can take.
- `maxQueue` — callers allowed to wait. Zero is legitimate and makes the
  bulkhead pure load-shedding; the default is two rounds of the cap, because a
  short queue absorbs the bursts every real traffic pattern has and refusing
  those would trade a latency spike for an error rate.
- `queueTimeoutMs` — how long a queued caller waits before being refused. This
  is the one that is usually missing. A bounded queue with no deadline is still
  unbounded *in time*: the caller that reaches the front after eight seconds is
  handed a slot to make a call whose requester left seven seconds ago. Work
  admitted with no reader left is the pathology every "just add a queue" fix
  arrives at.

Fairness is FIFO, and a released slot is handed *directly* to the waiter at the
head rather than freed for whoever wakes first. Under saturation — the only time
any of this runs — a barging semaphore starves the oldest waiter indefinitely,
and the oldest waiter is precisely the one whose own deadline is closest to
expiring.

### Where it sits, and why

The bulkhead is **outside** the retry ladder; the breaker is **inside** it. That
asymmetry is not an oversight, it follows from what each one counts.

The breaker counts *attempts*, because retries are what multiply load onto a
failing dependency and it has to be able to stop them individually. The bulkhead
counts *calls*, because what it rations is this service's own capacity — and an
inbound request sitting out a 2s backoff is holding a handler exactly as firmly
as one waiting on a socket. Released per attempt instead, the cap would be
exceeded by however many calls happened to be in backoff, which is most of them
precisely when the cap starts to matter.

Two consequences worth knowing:

- A permit is released when the **headers** are in hand, not when the caller
  finishes reading the body — this module cannot see that read. Streaming is
  bounded by the deadlines below instead. Releasing on body completion would
  leak a slot permanently the first time a caller ignored a body, and a cap that
  erodes is worse than one that undercounts.
- An open circuit drains a full queue at memory speed. Each admitted call throws
  from `breaker.acquire()` without opening a socket, so a queue that built up
  behind an outage empties as fast as promises can settle.

## Three deadlines, not one

| Option | Covers | Fires when |
| --- | --- | --- |
| `timeoutMs` | headers and body | the whole exchange runs past its budget |
| `headersTimeoutMs` | headers only | the dependency has not started answering |
| `bodyIdleTimeoutMs` | gap between chunks | it started answering and stopped |

`timeoutMs` is the backstop and is not optional: the failure a breaker most
needs to see is a dependency that accepts connections and never answers, and
without a deadline that attempt never completes, so nothing is recorded, the
ladder is never reached, and the socket is held indefinitely.

It is also the one that scales badly, and that is the whole argument for the
other two. Because it covers the body, it has to be sized for the *largest
legitimate response* — so a 60s budget for a 200MB export is also 60s of
patience for an origin that sent one byte and died.

`headersTimeoutMs` covers no body, so it can be set to what a healthy answer
actually costs. A wedged upstream is written off in that fraction rather than
holding a request handler for the full budget. It is cleared the instant headers
arrive; the exchange clock keeps running underneath it.

`bodyIdleTimeoutMs` is independent of body size, which is what keeps it
meaningful once `timeoutMs` has been raised for a big download. It asks "has
anything arrived recently", not "has this taken long" — a transfer of any
duration is fine so long as it never goes quiet for that long at once. The timer
is armed only while a read is outstanding, so a consumer that is slow to ask for
the next chunk is not mistaken for a stalled origin.

All three abort the attempt's `AbortSignal` **with** a `DependencyTimeoutError`
rather than rejecting a promise beside it. Both halves matter. Aborting the
signal is what closes the socket — a timer that only rejects leaves the request
in flight at the origin forever. Aborting *with the error* is what makes the
phase survive: `fetch` surfaces an abort reason verbatim, so callers catch a
typed 504 that names which deadline fired, instead of a `DOMException` that
could equally have been their own cancellation.

Two things follow from `bodyIdleTimeoutMs` being a guard on the returned stream:

- Turning it on re-wraps the `Response`. `status`, `statusText`, `headers`,
  `url` and `redirected` are carried across; nothing else observes the
  difference.
- A stall **mid-body** does not count against the circuit. The breaker settled
  this attempt's outcome when the headers arrived, which is the same reason the
  bulkhead released its permit there. It fails the caller's read, not the
  dependency's score.

### Connect and TLS timeouts

Not here, and not because they were overlooked. They are not expressible over
`fetch`: they need the dispatcher underneath it, and undici's dispatcher
protocol is not compatible between the copy Node bundles and the copy npm
installs — an `Agent` from `undici@8` handed to Node 22's global `fetch` fails
immediately with `UND_ERR_INVALID_ARG: invalid onRequestStart method`. Pinning
around that would tie this service's outbound HTTP to one Node minor.

A deployment that wants them injects its own `fetch`, bound to a dispatcher it
controls, through the `fetch` option — which is what that option is for. In
practice `headersTimeoutMs` covers what a connect timeout is usually reached
for, since it bounds connect, TLS and time-to-first-byte together.

## What is deliberately not here

No hedging (a second request fired before the first has failed),
no retry budget across calls (a token bucket bounding what fraction of total
traffic may be retries — the next thing to add if these clients ever front a
high-volume dependency), and no shared state between replicas. Each process
learns about the outage on its own, which is the usual trade: a shared breaker
is a dependency of its own, in the path of every call, whose own failure mode is
the one you least want during an incident.

The bulkhead is per-process for a stronger reason than the breaker is: what it
rations is *this process's* handlers and sockets, so a cap shared across
replicas would be measuring the wrong thing. Size `maxConcurrent` per replica
and multiply by the replica count to get what the dependency will see.

## Configuration

Every knob is an environment variable with a documented default, listed in
`.env.example` under *Outbound HTTP*, and every one is overridable per client
and per call. Five combinations are refused at boot rather than at the
incident:

- `HTTP_CLIENT_RETRY_MAX_DELAY_MS` below `HTTP_CLIENT_RETRY_BASE_DELAY_MS` — not
  a slow ladder but one that never widens, since every attempt would draw from
  the same window.
- `HTTP_CLIENT_BREAKER_WINDOW_MS` below `HTTP_CLIENT_BREAKER_BUCKETS` — a bucket
  spanning less than a millisecond cannot advance, so the window never slides.
- `HTTP_CLIENT_BREAKER_MIN_THROUGHPUT` below `HTTP_CLIENT_RETRY_ATTEMPTS` — one
  call's own retries could fill the window and open the circuit alone.
- `HTTP_CLIENT_HEADERS_TIMEOUT_MS` above `HTTP_CLIENT_TIMEOUT_MS` — not a laxer
  deadline but a dead one, since the coarse deadline always fires first and the
  finer instrument silently never runs.
- `HTTP_CLIENT_BODY_IDLE_TIMEOUT_MS` above `HTTP_CLIENT_TIMEOUT_MS` — the same
  argument: a gap longer than the whole exchange is one the exchange never
  survives to measure.

Those last two are refused only when *both* are named. A call that lowers
`timeoutMs` alone — `{ timeoutMs: 500 }` for one cheap probe — has the finer
deadlines it did not mention narrowed to fit rather than rejected: the intent is
complete on its own, and failing it over a configured default the caller never
chose would be the library arguing about somebody else's number. Name both in
one call and contradict yourself, and it throws.

One client per dependency, always. A single client in front of two upstreams
opens on the failures of the sick one and refuses calls to the healthy one,
which is a worse outage than the one it was containing — and its bulkhead sheds
calls to the healthy one because the sick one filled the queue.
