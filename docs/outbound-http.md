# Outbound HTTP: a circuit breaker with a retry ladder inside it

`src/resilience/` is what this service calls other services with. One client per
dependency, and each one is a retry ladder with full jitter wrapped around a
circuit breaker that gets a vote on every attempt.

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
`CircuitOpenError`, which is an `AppError` and therefore already a 503 with a
`Retry-After` by the time the error middleware sees it.

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

## Timeouts, and what is deliberately not here

`timeoutMs` is one deadline per attempt covering headers **and** body. It is
coarse on purpose, and it is not optional: the failure a breaker most needs to
see is a dependency that accepts connections and never answers, and without a
deadline that attempt never completes, so nothing is ever recorded, the ladder
is never reached, and the socket is held indefinitely.

Because it covers the body, a response this client returns is still on that
deadline — a caller streaming something large from a slow origin should raise
`timeoutMs` for that call rather than assume it is headers-only.

Not here, and next in `SPEC.md`: per-dependency **bulkheads** (a concurrency cap
per dependency, so one slow upstream cannot consume every worker) and **hard
socket timeouts** at connect, TLS and body-idle granularity. Nothing above
forecloses either.

Also not here: no hedging (a second request fired before the first has failed),
no retry budget across calls (a token bucket bounding what fraction of total
traffic may be retries — the next thing to add if these clients ever front a
high-volume dependency), and no shared state between replicas. Each process
learns about the outage on its own, which is the usual trade: a shared breaker
is a dependency of its own, in the path of every call, whose own failure mode is
the one you least want during an incident.

## Configuration

Every knob is an environment variable with a documented default, listed in
`.env.example` under *Outbound HTTP*, and every one is overridable per client
and per call. Three combinations are refused at boot rather than at the
incident:

- `HTTP_CLIENT_RETRY_MAX_DELAY_MS` below `HTTP_CLIENT_RETRY_BASE_DELAY_MS` — not
  a slow ladder but one that never widens, since every attempt would draw from
  the same window.
- `HTTP_CLIENT_BREAKER_WINDOW_MS` below `HTTP_CLIENT_BREAKER_BUCKETS` — a bucket
  spanning less than a millisecond cannot advance, so the window never slides.
- `HTTP_CLIENT_BREAKER_MIN_THROUGHPUT` below `HTTP_CLIENT_RETRY_ATTEMPTS` — one
  call's own retries could fill the window and open the circuit alone.

One client per dependency, always. A single client in front of two upstreams
opens on the failures of the sick one and refuses calls to the healthy one,
which is a worse outage than the one it was containing.
