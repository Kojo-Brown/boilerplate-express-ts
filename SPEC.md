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
- [ ] Singleton lifecycle: a hand-rolled DI container with singleton/scoped/transient registration
- [ ] Middleware composition: a typed `compose()` pipeline replacing ad-hoc `next()` chains

## Phase 7 — Concurrency & Data Integrity
- [ ] Idempotency middleware: `Idempotency-Key` + Postgres dedupe table with response replay
- [ ] Optimistic concurrency with a `version` column + `If-Match`/ETag, 412 on mismatch
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
