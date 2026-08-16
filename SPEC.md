# Spec: boilerplate-express-ts

> Spec-driven. Mark `[x]` only after pushing.

## Phase 0 — Green Baseline (blocks all feature work)
- [x] Verify every dependency version actually exists on the registry and fix the ones that do not, then commit a lockfile
- [x] Get `install`, `typecheck`, `lint`, `test`, and `build` all passing locally from a clean clone
- [x] Promote `workflow-templates/ci.yml` to `.github/workflows/ci.yml` and confirm it runs green on a PR
- [x] Add a CI job matrix covering the supported Node version and fail the build on any warning — `engines.node` narrowed to `^22.12.0 || ^24.0.0`; lint, typecheck, test, and build run on both majors with `--strict-peer-dependencies`, `--max-warnings=0`, and `NODE_OPTIONS=--throw-deprecation` (PR #22)

## Phase 1 — Foundation
- [x] Express 5 + TypeScript 6 scaffold with strict tsconfig and `@/` path alias
- [x] Zod-validated env vars + config module
- [x] Router factory pattern: versioned `/v1/` routes via `express.Router()`
- [x] Global error handler middleware with typed `AppError` class
- [x] Request logger middleware (Morgan + correlation ID)

## Phase 2 — Auth
- [x] JWT access + refresh token flow (jsonwebtoken)
- [x] OAuth 2.0 PKCE flow with Google (passport + passport-google-oauth20)
- [x] Argon2 password hashing
- [x] Rate limiter middleware (`express-rate-limit`) on auth routes
- [x] Auth middleware factory: `requireAuth`, `requireRole`

## Phase 3 — Database
- [x] PostgreSQL connection pool via `pg` with typed query helper
- [x] SQL migration runner (node-pg-migrate)
- [x] Repository pattern: typed CRUD base class
- [x] Transaction helper with automatic rollback

## Phase 4 — API Patterns
- [x] Zod request validation middleware (body, query, params)
- [x] Cursor-based pagination helper
- [x] File upload (Multer + S3 presigned URLs)
- [x] Response envelope: `{ data, meta, error }`

## Phase 5 — Testing & DevOps
- [x] Jest + Supertest E2E tests for auth + CRUD
- [x] GitHub Actions: lint → typecheck → test → build → Docker push
- [x] Multi-stage Dockerfile + docker-compose with postgres

## Phase 6 — SOLID & Design Patterns
- [x] SOLID audit with before/after refactors documented in `docs/solid.md` — three of the five findings were live defects, not style: a duplicate email returned 500 because the error middleware was a closed `instanceof` ladder (and `upload.router.ts` had already grown a parallel Multer handler to work around that closure), `findByRole` cast an array through the base class's equality `WHERE` so the seeded admin never matched, and the controllers' hand-rolled 422 discarded Zod's `issues` while `validate.middleware.ts` sat unused (PR #23)
- [x] Factory + Registry: `ProviderRegistry` resolving adapters by key with compile-time exhaustiveness — `TKey` pinned to a union rather than inferred, so the table is checked both ways: a key with no factory fails the `Record`, a factory outside the union is an excess property, and both errors land at the registration site (PR #24)
- [x] Strategy pattern: swappable `AuthStrategy` (password, magic link, API key) — every strategy resolves an `AuthenticatedPrincipal` and `AuthService` mints the pair from it, so nothing after login branches on how the caller authenticated. The credential type is erased in exactly one place (`defineAuthStrategy`), because a heterogeneous registry of `AuthStrategy<TCredentials>` collapses to a union whose `authenticate` takes the *intersection* of three unrelated shapes; `/login/:strategy` therefore validates inside the strategy rather than at the router, which is a deliberate departure from the edge-validation convention. Tokens and API keys are stored as SHA-256 digests, not argon2 — a KDF buys nothing against 256 bits of CSPRNG entropy. Both env-dependent defaults fail closed: magic-link delivery refuses to send in production until a transport is wired, and the published `mock-api-key-*` dev keys seed only outside production (PR #25)
- [x] Decorator pattern: higher-order route handlers `withRetry`, `withTimeout`, `withCache` — they wrap a `RouteOperation` (request in, value out), not `(req, res, next)`: once a handler has called `res.json()` a retry has nothing to retry into and a cache has no return value to store, so the naive signature can only support one of the three. `toRequestHandler` is the single file that touches `Response`. What each one *refuses* to do carries the design — `withRetry` runs POST/PATCH exactly once and backs off with full jitter; `withTimeout` aborts the operation's signal with the `TimeoutError` as the reason rather than merely ceasing to wait, so the pooled connection is actually released; `withCache` keys on the principal (omitting it is a cross-account leak on `GET /v1/users`), never caches failures, coalesces concurrent misses, and stores into a bounded LRU because URL-derived keys make an unbounded map a memory-exhaustion primitive. Wired into the users routes for real — reads run cache → retry → per-attempt timeout, writes clear the store and deliberately get no retry, since a delete that commits and then loses the connection would answer 404 on the replay (PR #26)
- [x] Observer pattern: typed `EventBus` on Node `EventEmitter` with domain events — the emitter is the right primitive and the wrong interface, and each gap is a production failure rather than a style complaint: `emit('user.delted', …)` typechecks and silently never fires, `emit` discards an async listener's promise so a rejection takes the process down, and a listener that throws throws *out of `emit`* into whoever published. Dispatch still goes through `emitter.emit` — `publish` passes a collector alongside the envelope and each wrapper pushes its isolated promise into it — because snapshotting `listeners()` and calling them by hand loses `once` removal, listener counts and leak warnings. `error`/`newListener`/`removeListener` are refused outright, since emitting `error` with no listener throws into the publisher, the exact coupling this breaks. Wired for real: `DELETE /v1/users/:id` publishes `user.deleted` and a subscriber revokes that user's refresh tokens, which previously stayed valid for a week after the account was gone — and the users module still imports nothing from auth. The audit subscriber's descriptor table is exhaustive over the event union, so a new event fails to compile until someone decides what it means for the audit trail. Two omissions carry the design: cache invalidation stays inline in the controller (isolating a failed invalidation means serving the row you just changed for the rest of the TTL — events carry the consequences a publisher can afford to lose), and rotation publishes nothing, because the signal worth having from that path is a *reused* refresh token, which is Phase 10's event, not this one (PR #27)
- [x] Singleton lifecycle: a hand-rolled DI container with singleton/scoped/transient registration — the module-level `export const userRepository = new UserRepository()` it replaces was *already* a singleton, so the instance count is unchanged; what changes is that the lifetime became a decision and the wrong combination became a loud error. The captive dependency is that error: a singleton holding a per-request object serves the first request's principal to every later one, and no single-request test can see it. Singleton factories therefore resolve against the root, where scoped tokens do not exist, so the failure lands at the first resolution with the whole path named — including through an intermediate transient, since the path is carried through the entire resolution rather than checked one edge at a time. Three decisions live in the API rather than the docs: factories are synchronous (an async one lets two concurrent resolutions both enter a singleton's factory, making it "usually one"), `registerTransient` has no `dispose` option at all (holding a reference so it could be closed later makes every resolve a leak), and re-registering a token throws (last-write-wins is how a test stub reaches production). Wired in for real — one scope per request, disposed on `close` rather than `finish` so a client that hangs up does not strand it, and `users.controller.ts` resolves its repository, the bus and a scoped `RequestContext` from that scope. `RequestContext` reads the request through accessors, not a snapshot, because a scoped instance is built at first *resolve*, possibly before `requireAuth` has run. Nothing is registered transient and that is a finding, not a gap: every collaborator here is stateless or per-request (PR #28)
- [x] Middleware composition: a typed `compose()` pipeline replacing ad-hoc `next()` chains — a middleware array is an ordered list matched against a path, and the three things it cannot express had all become comments in this repo. Ordering ("auth stays ahead of validation so an unauthenticated caller learns nothing about the accepted request shape") was enforced by nothing; `req.auth` stayed `JwtPayload | undefined` inside handlers unreachable without a token, because the global augmentation describes every request in the process; and `toRequestHandler`'s cast to the operation's own `TReq` was justified by a `validate()` call in a different file. A step takes the request and returns it refined, so `TIn` sits in a parameter position and `strictFunctionTypes` makes `compose().use(requireRoles('admin'))` a compile error rather than a 401 that answers admins and impostors alike. There is no `next` — it overloads continue, fail and skip-this-route onto one callback that Express can neither disambiguate nor call once. What it refuses carries the rest: `fromRequestHandler` exists because `express-rate-limit`, `multer` and `passport` never will be steps and its type says it proves nothing, but it ignores a second `next()`, resolves when middleware answers without calling `next` at all, forwards a rejected promise Express 5 would have caught, and rejects `next('route')` outright since a composed pipeline has no remaining stack to abandon. Two defects surfaced on the way: `req.query = parsed` throws on a real Express 5 request (a getter with no setter), which the unit tests had hidden by building `req` as an object literal, and `createUser` declared params as `Record<string, string>` where Express 5 types a parameter as `string | string[]` (PR #29)

## Phase 7 — Concurrency & Data Integrity
- [x] Idempotency middleware: `Idempotency-Key` + Postgres dedupe table with response replay — the record is taken at the *response* boundary rather than around the handler, because a decorator in the `withCache` family sees `TResult` and what has to be replayed is the serialised response: `created_at` is a `Date` going out and a string coming back, so a store typed by the operation's return value would claim a shape it cannot produce, and nothing on the value side would catch it. It wraps `res.json`/`res.end` and persists *before* flushing — `res.on('finish')` never fires for a client that disconnects mid-flush, which is exactly the client about to retry. It is a pipeline step, not a `(req, res, next)` middleware, because keys are client-generated strings and the table is therefore scoped by principal: mounted ahead of `authenticate` every caller shares the `anonymous` scope and replays someone else's body, so the ordering is a compile error instead of a comment. `INSERT ... ON CONFLICT DO NOTHING` is the claim — one round trip, and unlike SELECT-then-INSERT it cannot succeed for two callers at once — with every timestamp compared by Postgres and `claim_id` fencing `complete`/`release` so a superseded request cannot overwrite its successor's record. 4xx is recorded (a deterministic rejection is the answer), 5xx releases the claim, and 408/425/429 are never recorded, since freezing "not now" into a day-long window keeps answering 429 from a limiter that has relented. `POST /v1/users` now requires the header — a deliberate breaking change; the existing e2e cases gained a key and lost no assertion. What is *not* claimed: the claim row and the work commit separately, so a crash between them costs one re-execution — closing that needs the record inside the write's own transaction, which is the outbox item below. Verified beyond the suite against a real PostgreSQL 16: migration applied, rolled back and re-applied, and 20 concurrent claims on one key producing exactly one winner (PR #30)
- [x] Optimistic concurrency with a `version` column + `If-Match`/ETag, 412 on mismatch — the version is bumped by a `BEFORE UPDATE` trigger rather than by the repository's own `SET` clause, because a validator that only holds when the writer remembers to opt in is not a validator: `BaseRepository.update`, a backfill and a `psql` session are all writers, and any of them moving the row without moving the version leaves an already-issued `ETag` comparing equal to a state it no longer describes. That is also what keeps the inherited unconditional writes safe to expose. The check is in the `WHERE` clause, not in a read before it — read-then-write reintroduces the race at the point of fixing it — and it is one statement, not two, because an `UPDATE` affecting no rows cannot say whether the row is gone (404) or at another version (412), and asking afterwards lets a concurrent delete turn a genuine conflict into the one answer that tells a client to stop retrying; both branches share a snapshot via a data-modifying CTE. `If-Match` is required rather than optional (428 without it), since a route that protects only the careful clients offers a guarantee no client can detect — and the usual cost is not charged, because `If-Match: *` is a first-class answer, so what is required is that the expectation be *stated*, not that it be narrow. The parser rejects what a client must change (a non-list header, a weak tag — `If-Match` is strong comparison, so `W/"7"` could never match and a 412 would loop forever) and merely drops what simply does not match (`"abc"`, `"007"`, anything past `integer` range), which becomes a 412; the list is scanned rather than `split(',')`, since a comma is a legal `etagc`. `requireIfMatch` refines the request type, so a router that drops it does not compile. Two things fell out: `AppError` can now carry response headers — a `RouteOperation` never sees a `Response`, and the `ETag` on a 412 is the half of that answer a client acts on — and a conflict clears this replica's cached reads, or the client's recovery `GET` returns the same stale validator and its retry conflicts again for the length of the TTL. Verified beyond the suite against a real PostgreSQL 16: the migration applied, rolled back and re-applied; the trigger bumped the version for a hand-written `UPDATE` and overrode one that tried to set `version` itself; and 20 concurrent writers naming the same version produced exactly one winner, 19 conflicts, and a row that advanced by exactly one (PR #31)
- [ ] Pessimistic locking with `SELECT ... FOR UPDATE` and a deadlock-retry wrapper
- [ ] Distributed lock via Postgres advisory locks with automatic release
- [ ] `worker_threads` pool for CPU-bound work with a bounded queue and graceful drain
- [ ] Immutability: `readonly` types, `Object.freeze` in dev, pure update helpers
- [ ] Transactional outbox table + relay worker with at-least-once delivery

## Phase 8 — Streaming & Messaging
- [ ] Node streams done right: backpressure-aware CSV ingest with `pipeline()`
- [ ] Large file streaming download with range requests + `ETag`
- [ ] Server-Sent Events endpoint with heartbeat and `Last-Event-ID` resume
- [ ] WebSocket server (`ws`) with JWT handshake auth and per-connection rate limits
- [ ] Redis Streams consumer group worker with claim-on-stall recovery
- [ ] BullMQ job queue with retries, backoff, and a dead-letter queue

## Phase 9 — Resilience & Observability
- [ ] Circuit breaker + retry with full jitter on outbound HTTP
- [ ] Per-dependency bulkheads and hard socket/request timeouts
- [ ] Graceful shutdown: drain the server, finish in-flight requests, close the pool
- [ ] OpenTelemetry auto-instrumentation with W3C trace context propagation
- [ ] Prometheus RED metrics + a checked-in Grafana dashboard
- [ ] Health endpoints split into liveness vs readiness with dependency checks

## Phase 10 — Security Hardening
- [ ] Helmet, strict CSP, HSTS, and an env-driven CORS allowlist
- [ ] Refresh-token reuse detection with family revocation
- [ ] Field-level encryption at rest (AES-256-GCM) with envelope keys
- [ ] PII redaction in structured logs
- [ ] Request signing (HMAC) for webhooks with constant-time verification and replay windows
- [ ] OWASP API Top 10 checklist with a test per mitigation
- [ ] mTLS termination notes + client-cert verification middleware

## Phase 11 — TDD & Advanced Testing
- [ ] TDD kata: one feature built red→green→refactor, one commit per step
- [ ] Mutation testing with Stryker + CI threshold
- [ ] Property-based tests with fast-check
- [ ] Testcontainers integration tests against real Postgres
- [ ] Load test with k6 and a latency budget asserted in CI
