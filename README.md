# boilerplate-express-ts

> Express 5 · TypeScript 6 · PostgreSQL · JWT · OAuth 2.0 · Argon2 · Zod

Minimal but production-ready REST API starter. No framework magic — just TypeScript, Express, and pg.

## Stack

| Layer | Tech |
|-------|------|
| Framework | Express 5 |
| Language | TypeScript 6 |
| Database | PostgreSQL (node-postgres) |
| Auth | JWT + OAuth 2.0 (Passport) |
| Validation | Zod |
| Testing | Jest + Supertest |

## Quick Start

```bash
git clone https://github.com/Kojo-Brown/boilerplate-express-ts.git
cd boilerplate-express-ts
pnpm install
cp .env.example .env
docker-compose up postgres -d
pnpm db:migrate
pnpm dev  # http://localhost:4000/v1
```

## Supported Node versions

`engines.node` is `^22.12.0 || ^24.0.0` — the two Node release lines still under
LTS. CI runs lint, typecheck, test, and build against **both** majors, so a
change that only works on one of them fails before it reaches `main`.

Warnings are failures in CI, on every major:

| Source of warning | How it fails the build |
|-------------------|------------------------|
| Unmet peer dependency ranges | `pnpm install --strict-peer-dependencies` |
| ESLint rules configured as `warn` | `pnpm lint` runs `eslint --max-warnings=0` |
| Node runtime deprecations (ours or a dependency's) | `NODE_OPTIONS=--throw-deprecation` on every gate step |

To reproduce a CI failure locally, run the gate with the same flags:

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
NODE_OPTIONS=--throw-deprecation pnpm test
```

## Design notes
- [SOLID audit](./docs/solid.md) — the five principles applied to this codebase,
  with the before/after of each refactor they produced.
- [Factory + Registry](./docs/provider-registry.md) — `ProviderRegistry`, the
  compile-time exhaustiveness it buys, and the storage adapters behind
  `STORAGE_DRIVER`.
- [Auth strategies](./docs/auth-strategies.md) — swappable `AuthStrategy`
  (password, magic link, API key), why the credential type is erased at the
  registry, and how secrets are stored.
- [Route decorators](./docs/route-decorators.md) — `withRetry`, `withTimeout`
  and `withCache`, why they wrap a request-to-value operation rather than an
  Express handler, and what each one refuses to do.
- [Domain events](./docs/event-bus.md) — the typed `EventBus` over
  `EventEmitter`, why a raw emitter cannot isolate a failing subscriber, and
  which consequences are deliberately *not* events.
- [DI container](./docs/di-container.md) — singleton/scoped/transient
  lifetimes, one scope per request, and the captive dependency the lifetimes
  exist to make impossible.
- [Middleware composition](./docs/middleware-composition.md) — the typed
  `compose()` pipeline that replaced the ad-hoc `next()` chain, how ordering
  became a compile error, and what the adapter for third-party middleware
  cannot prove.
- [Idempotency](./docs/idempotency.md) — `Idempotency-Key` with a Postgres
  dedupe table and response replay, why the record is taken at the response
  boundary rather than around the handler, and the one duplicate the lease
  cannot rule out.
- [Optimistic concurrency](./docs/optimistic-concurrency.md) — `If-Match` and
  `ETag` over a trigger-maintained `version` column, why the check lives in the
  `WHERE` clause rather than in a read before it, and what the `If-Match` parser
  rejects as opposed to what it merely fails to match.
- [Pessimistic locking](./docs/pessimistic-locking.md) — `SELECT ... FOR UPDATE`
  with deterministic lock ordering and a deadlock-retry wrapper, the cross-row
  invariant a version column cannot express, and why a lock timeout below
  `deadlock_timeout` makes the retry loop unreachable.
- [Advisory locks](./docs/advisory-locks.md) — distributed mutexes over
  Postgres advisory locks, why the transaction-scoped family needs no lease or
  fencing token, and how a session-scoped lock's release is made automatic by
  destroying the connection when the unlock cannot be confirmed.
- [Worker thread pool](./docs/worker-pool.md) — CPU-bound work off the event
  loop with a bounded queue that sheds rather than grows, why a task timeout has
  to destroy the thread, and how the worker entry point is found under
  `tsc`, `tsx` and jest alike.
- [Immutability](./docs/immutability.md) — `DeepReadonly`, a deep freeze outside
  production, and the pure update helpers that are left once the object spread
  has covered the rest; what `Object.freeze` cannot do to a `Date`, a `Map` or a
  `Buffer`, and why the cache and the event bus are where it is wired.
- [Transactional outbox](./docs/outbox.md) — publishing an event in the same
  transaction as the row it describes, and a relay that drains it with
  `FOR UPDATE SKIP LOCKED`; what at-least-once obliges a subscriber to do, why a
  delivered row is deleted rather than marked, and where the delivery boundary
  actually sits when the dispatcher is an in-process bus.
- [CSV ingest](./docs/csv-ingest.md) — a streaming, backpressure-aware bulk
  import built on `pipeline()`; where backpressure actually lives and how it is
  measured rather than asserted, why a CSV record is not a line, what
  `highWaterMark` defaults cost in object mode, and the split between a
  malformed document (4xx) and a malformed row (collected, reported, and
  imported around).
- [Range downloads](./docs/range-downloads.md) — `GET /v1/uploads/:objectId`
  with `Range`, `ETag`, `If-Range` and `If-None-Match`; why an invalid range is
  200 and an unsatisfiable one is 416, why a failed `If-Range` sends everything
  rather than failing, why the read costs two calls to the object store, and
  what a stream that has already started can and cannot do about an error.
- [Server-Sent Events](./docs/server-sent-events.md) — `GET /v1/events/stream`
  with a heartbeat and `Last-Event-ID` resume; why event ids carry a per-run
  prefix, why a cursor that cannot be honoured is answered on an open stream
  rather than with a 4xx, why a slow consumer is dropped rather than buffered,
  and what `no-transform` and the wire format's total lack of an escape
  sequence are each protecting against.
- [WebSockets](./docs/websockets.md) — `ws://…/v1/ws` with JWT handshake auth
  and per-connection rate limits; why the token travels in a subprotocol rather
  than a query string or a cookie, why the handshake is refused before the 101
  and what that requires of `noServer`, why the limiter is a token bucket in two
  dimensions rather than the fixed window the REST routes use, and why a socket
  needs a scheduled close at its own credential's expiry when no route does.
- [Redis Streams](./docs/redis-streams.md) — a consumer group with
  claim-on-stall recovery (`pnpm worker:stream`); why the pending entries list
  is both the delivery record and the retry schedule, why the reclaim floor must
  exceed the handler timeout or healthy work runs twice, why `XAUTOCLAIM` is not
  used, why acknowledging an entry does not remove it from the stream, and why
  retiring a consumer that still holds entries destroys them.
- [Job queue](./docs/job-queue.md) — BullMQ with retries, full-jitter backoff
  and a dead-letter queue (`pnpm worker:queue`); why the attempt count is a
  producer option while the delays are a worker setting and what happens when
  the two disagree, why BullMQ's own `exponential` strategy is not used, why
  `finishedOn` is the only reliable signal that an attempt was the last one, why
  the failed set is the dead-letter queue's backstop rather than a replacement
  for it, and why a redacted record is one that cannot be replayed.
- [Outbound HTTP](./docs/outbound-http.md) — a circuit breaker with a
  full-jitter retry ladder inside it; why the breaker takes a permit per
  *attempt* rather than per call, why a 4xx must not count against a
  dependency's health while a 429 must, why a cancelled request counts as
  neither, why `Retry-After` is jittered rather than honoured exactly, and the
  measurement showing that draining a discarded response body costs two
  connections where `body.cancel()` costs four. Also the two mechanisms a
  breaker cannot stand in for: a per-dependency **bulkhead**, because a
  dependency that slows from 20ms to 5s never *fails* — it succeeds slowly,
  the breaker stays closed, correctly, and 250 calls pile up holding every
  request handler in the process — and **three deadlines** per attempt rather
  than one, because a whole-exchange timeout has to be sized for the largest
  legitimate response and is therefore useless against an origin that sent one
  byte and died.
- [Tracing](./docs/tracing.md) — OpenTelemetry auto-instrumentation with W3C
  trace context: `traceparent` in and out, `baggage` carrying the correlation id
  onward, and `traceresponse` handing the trace id back to the caller. Why the
  bootstrap has to be the *first import* of every entry point rather than a call
  inside it, why the sampler is parent-based (a ratio asked at every hop
  multiplies, and four services at 0.1 keep one trace in ten thousand whole —
  the rest arrive as fragments that look like unexplained gaps), why the `fs`
  instrumentation is off, why the readiness probe is dropped before a span is
  built rather than at the sampler, why the propagator list is pinned in code
  instead of left to `OTEL_PROPAGATORS`, and why an empty carrier is the correct
  output of an injection with no active span. Also the one assertion that cannot
  be made under jest at all, and the version of that test which passed while
  testing nothing.
- [Metrics](./docs/metrics.md) — RED on a Prometheus endpoint, with a Grafana
  dashboard checked in at `grafana/dashboards/red-dashboard.json` and a compose
  profile that will actually show it to you. Why rate and errors are one counter
  and the in-flight gauge is not derivable from either (during a stall the rate
  *falls* and the histogram records nothing, because nothing has finished), why
  `status_code` is on the counter and deliberately not on the histogram, and why
  the duration buckets are round numbers an SLO would use rather than a
  distribution somebody measured once. Also the label reconstruction that every
  naive version of this middleware gets wrong: `req.baseUrl` and `req.params`
  are restored as the router stack unwinds, so a `finish` listener that reads
  them labels `GET /v1/users/:id` as `/:id` for every error and every async
  handler — which is most of them — while passing any test written with a
  synchronous one. Why the readiness probe is not measured (it answers 503 for
  the whole drain window by design, so measuring it paints a 5xx spike on every
  rolling deploy), why an abandoned request is recorded as 499 rather than as
  the 200 `statusCode` still defaults to, and what an exemplar buys once the
  graph and the trace finally share an identifier.
- [Health checks](./docs/health-checks.md) — `GET /v1/health/live` and
  `GET /v1/health/ready`, and why they cannot be one endpoint: the correct
  answer to "alive" and to "send me traffic" is *opposite* during a drain (a
  kubelet that fails liveness restarts the container in the middle of its own
  shutdown) and during a dependency outage (a liveness probe wired to dependency
  checks restarts every replica at once for a database that is down for all of
  them, repeatedly, with the reconnect storm in the way of recovery). Why
  Postgres is `critical` and Redis is `optional` — the test being whether
  routing to a different replica would help, which for a Redis every replica
  shares is no — and why `degraded` has to be a third status at 200 rather than
  a choice between hiding a fault and shedding traffic for one that cannot be
  routed around. Also the deadline enforced twice because a signal only bounds a
  check that reads it, the pool client that arrives after the probe gave up and
  is one slot gone forever if nobody releases it, and why the report cache
  collapses pollers without ever being allowed to answer for the drain.
- [Graceful shutdown](./docs/graceful-shutdown.md) — four phases between
  `SIGTERM` and `exit`, and the two opposite ways `server.close()` on its own
  gets it wrong: it refuses traffic a load balancer is still routing in good
  faith, and then waits forever anyway, because an in-flight request's response
  goes out with `Connection: keep-alive` and the socket it leaves behind never
  ends. Why the phase that does no teardown at all is the one that must not be
  removed, why the drain window is deliberately the one wait the shutdown budget
  cannot cut short, why sockets are `end()`ed rather than destroyed, and why the
  pool closes last.
- [Security headers and CORS](./docs/security-headers.md) — helmet with a
  `default-src 'none'` policy, HSTS, and an exact-match origin allowlist driven
  by `CORS_ORIGIN` — which until now was documented as the API's allowlist and
  read by nothing but the WebSocket gateway. Why the three directives that do
  not fall back to `default-src` are spelled out, why a disallowed *preflight*
  is refused while a disallowed *actual request* is served without the headers,
  why `Vary: Origin` belongs on responses that carried no `Origin`, and why
  `CORS_ORIGIN=*` with credentials fails at boot.
- [Refresh-token reuse detection](./docs/refresh-token-reuse.md) — rotation
  makes a session a chain, so a token presented after it was rotated away is
  the one server-side signal that a refresh token has been copied. Why the
  response has to revoke the whole rotation family rather than the replayed
  token (which changes nothing) or all of the user's sessions (which has no
  evidence behind it), why retiring a token means marking it rather than
  deleting it, why the retention window is the token's own `exp` and not a
  setting, why `consume()` is one call rather than a check and a write, and why
  there is deliberately no grace window and no distinct error code.
- [Field-level encryption at rest](./docs/field-encryption.md) — AES-256-GCM
  under a data key generated per value, wrapped under a key-encryption key from
  a ring. Why two keys rather than one (blast radius, GCM's nonce budget, and a
  key rotation that rewrites 32 bytes per row instead of every value), why every
  ciphertext is bound to its table, column and row so a value copied into
  another user's row stops decrypting, why the key ring is a list and what each
  of the three deployments in a rotation does, and why searching an encrypted
  column is deliberately impossible here.
- [PII redaction in structured logs](./docs/pii-redaction.md) — every value on
  its way to a JSON log line, redacted by key name and by checkable shape. Why a
  key is matched by *word runs* rather than exactly (which misses `userEmail`)
  or by substring (which eats `passengers`), why `name`, `address`, `id` and
  `signature` are deliberately not on the deny list, why every shape detector
  runs a real check — Luhn, mod-97, the JWT's `eyJ` prefix — before it redacts
  anything, why the walk refuses to descend into class instances, why cycles are
  detected against ancestors rather than everything seen, why strings are
  redacted before they are truncated, and why configuration can only ever redact
  more.

## Authentication

Three ways in, one session out. Every strategy resolves an
`AuthenticatedPrincipal` and `AuthService` mints the same token pair from it,
so nothing downstream of login branches on how the caller authenticated.

```bash
# password
curl -X POST localhost:4000/v1/auth/login/password \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"…"}'

# magic link — request, then redeem the token that lands in the dev log
curl -X POST localhost:4000/v1/auth/magic-link \
  -H 'content-type: application/json' -d '{"email":"admin@example.com"}'
curl -X POST localhost:4000/v1/auth/login/magic-link \
  -H 'content-type: application/json' -d '{"token":"…"}'

# api key — mock-api-key-admin / mock-api-key-user are seeded outside production
curl -X POST localhost:4000/v1/auth/login/api-key \
  -H 'content-type: application/json' -d '{"apiKey":"mock-api-key-admin"}'
```

Adding a fourth is a name in `AUTH_STRATEGIES` plus a factory in
`src/auth/strategies/index.ts`; the build fails at the registration site until
both exist. No router, controller or service change.

## Spec Progress
See [SPEC.md](./SPEC.md).
