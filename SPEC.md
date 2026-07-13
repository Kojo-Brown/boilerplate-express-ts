# Spec: boilerplate-express-ts

> Spec-driven. Mark `[x]` only after pushing.

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
- [ ] Jest + Supertest E2E tests for auth + CRUD
- [ ] GitHub Actions: lint → typecheck → test → build → Docker push
- [ ] Multi-stage Dockerfile + docker-compose with postgres
