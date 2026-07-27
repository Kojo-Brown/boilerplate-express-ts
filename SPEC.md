# Spec: boilerplate-express-ts

> Spec-driven. Mark `[x]` only after pushing.

## Phase 0 — Green Baseline (blocks all feature work)
- [ ] Verify every dependency version actually exists on the registry and fix the ones that do not, then commit a lockfile
- [ ] Get `install`, `typecheck`, `lint`, `test`, and `build` all passing locally from a clean clone
- [ ] Promote `workflow-templates/ci.yml` to `.github/workflows/ci.yml` and confirm it runs green on a PR
- [ ] Add a CI job matrix covering the supported Node version and fail the build on any warning

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
- [ ] SOLID audit with before/after refactors documented in `docs/solid.md`
- [ ] Factory + Registry: `ProviderRegistry` resolving adapters by key with compile-time exhaustiveness
- [ ] Strategy pattern: swappable `AuthStrategy` (password, magic link, API key)
- [ ] Decorator pattern: higher-order route handlers `withRetry`, `withTimeout`, `withCache`
- [ ] Observer pattern: typed `EventBus` on Node `EventEmitter` with domain events
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
