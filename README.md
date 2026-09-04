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
