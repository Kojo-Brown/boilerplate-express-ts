# OWASP API Security Top 10 (2023): what this service does, and what it does not

One row per risk. Each names the control, the file it lives in, and the test
that proves it still works — `src/tests/e2e/owasp-api-top-10.e2e.test.ts`, one
`describe` per risk, everything driven through the real `createApp()`.

Rows that say **none** say it plainly and are not softened. A checklist whose
every line reads "mitigated" is a checklist that was written rather than run,
and the two vulnerabilities this document's own first pass turned up were both
in areas anyone would have marked green: a password digest in every user
response, and an authorisation model that checked what *kind* of caller you
were and never which *row* you asked for. Both were shipped by people who
would have said, correctly, that this API authenticates every request and
hashes every password with argon2id.

| # | Risk | Control | Where |
|---|------|---------|-------|
| API1 | Broken Object Level Authorization | `requireSelfOrRoles` on `GET`/`PUT /v1/users/:id` | `src/middleware/auth.middleware.ts` |
| API2 | Broken Authentication | argon2id, split access/refresh secrets, rotation with reuse detection, login throttle | `src/auth/`, `src/lib/jwt.ts`, `src/middleware/rate-limit.middleware.ts` |
| API3 | Broken Object Property Level Authorization | `toPublicUser` projection; `requireAdminToAssignRoles`; Zod strips unknown keys | `src/users/user-view.ts`, `src/users/users.authorization.ts` |
| API4 | Unrestricted Resource Consumption | body-size caps, per-endpoint rate limits, per-query deadlines, bulkheads | `src/app.ts`, `src/middleware/rate-limit.middleware.ts`, `src/resilience/` |
| API5 | Broken Function Level Authorization | `requireRoles('admin')` on the collection, the writes and the import | `src/users/users.router.ts` |
| API6 | Unrestricted Access to Sensitive Business Flows | tighter budget on magic-link; single-use nonce on webhook deliveries; idempotency keys | `src/middleware/rate-limit.middleware.ts`, `src/webhooks/replay-guard.ts`, `src/idempotency/` |
| API7 | Server Side Request Forgery | outbound requests confined to their client's base URL | `src/resilience/http-client.ts` |
| API8 | Security Misconfiguration | helmet policy above every route, CORS allowlist, no framework banner, errors that quote nothing | `src/security/`, `src/middleware/error.middleware.ts`, `src/middleware/body-parser.errors.ts` |
| API9 | Improper Inventory Management | URI versioning on every route, operational surface off `/v1`, failure detail off by default | `src/routes/v1/index.ts`, `src/config/env.ts` |
| API10 | Unsafe Consumption of APIs | HMAC signature over raw bytes, freshness window, size cap ahead of both | `src/webhooks/` |

---

## API1:2023 — Broken Object Level Authorization

**Control.** `requireSelfOrRoles('admin')`, a pipeline step, on `GET
/v1/users/:id` and `PUT /v1/users/:id`. The principal passes if it is the
subject of the row (`req.auth.userId === req.params.id`) or holds `admin`.

**What it replaced.** Both routes were guarded by `authenticate` alone. Any
valid token could read any user record by id, and `PUT` was worse than `GET`:
`updateUserBodySchema` accepts `roles`, so any authenticated caller could send
`PUT /v1/users/<themselves>` with `{"roles":["admin"]}`. That is a privilege
escalation reachable from a fresh signup, through a route nobody would have
described as unprotected — it had authentication, validation, a precondition
and a role-aware pipeline sitting right next to it on the sibling routes.

**Why it is a step and not a check inside the handler.** The refusal has to
happen before the row is read. A check that runs after the lookup has spent the
query and — through the timing difference between a hit and a miss — has
already leaked the answer it is declining to give. Declaring the step over
`Authenticated<Request<{ id: string }>>` makes both of its prerequisites
(`authenticate`, `validateParams`) compile-time requirements rather than
conventions.

**403, not 404.** Hiding existence behind a 404 is the stronger posture in
general and is not worth it here: ids are already handed out in the admin list
and in every `user.*` event payload, so a 404 conceals nothing from anyone who
can enumerate, while costing the lookup this refusal exists to avoid.

**Not covered.** Only the `users` resource has object-level authorization,
because it is the only resource whose rows have a subject. `GET
/v1/uploads/:objectId` is behind `requireAuth` and nothing else: any
authenticated caller may download any object whose id it knows. The ids are
server-generated UUIDs (`src/upload/object-key.ts`), so in practice this rests
on unguessability rather than on authorization — which is not the same thing,
and stops being true the moment an id is shared, logged or enumerated. Closing
it needs an owner recorded alongside the object, which is a schema change and
its own item; the guard is the easy half.

**Tests.** `API1:2023` — self-read allowed; another subject's record refused;
*refused before the query runs*; the same on the write path; an administrator
reaches any record.

## API2:2023 — Broken Authentication

**Controls.** argon2id for password verification (`src/lib/password.ts`).
Access and refresh tokens signed under different secrets, so a refresh token
presented as a bearer credential fails verification rather than buying a
seven-day session. Refresh rotation with reuse detection and family revocation
(`src/auth/token-store.ts`, `docs/refresh-token-reuse.md`). A five-per-15-minute
budget on `POST /v1/auth/login`, counted per endpoint rather than per failure —
a limiter reset by a successful login is one valid account away from being no
limiter at all. PKCE on the OAuth flow (`src/auth/oauth/pkce.ts`). Login
answers `AUTH_INVALID_CREDENTIALS` identically for an unknown address and a
wrong password.

**Not covered.** The rate limiter's store is in-memory and per replica, so
behind N replicas the effective budget is N × 5. `MemoryStore` is the seam;
`express-rate-limit` has Redis stores that drop in. There is no account
lockout, no MFA, and no credential-breach check.

**Tests.** `API2:2023` — forged token refused; refresh token refused as an
access token; unknown address and wrong password indistinguishable; the sixth
attempt throttled; the budget not reset by a success.

## API3:2023 — Broken Object Property Level Authorization

**Controls.** Three, at three different layers:

- **Reads.** `toPublicUser` (`src/users/user-view.ts`) projects `UserRow` onto
  the fields the API may describe. Applied inside the caching decorator, so
  `usersCache` holds the projection rather than the row.
- **Writes, field level.** `requireAdminToAssignRoles`
  (`src/users/users.authorization.ts`) refuses a `PUT` carrying `roles` from a
  non-administrator. Without it the API1 control above is the escalation.
- **Writes, unknown keys.** Zod strips what the schema does not name, so a
  smuggled `password_hash` never reaches a statement.

**What it replaced.** Every users route answered with the row the repository
returned, `password_hash` included — in `GET /v1/users/:id`, in the admin list,
in both write responses, and in the cached copy of each. A password digest is
the one value whose whole purpose is that the server is the only party holding
it, and it was being served to every authenticated caller and written into
every client's logs.

**Why the projection lists what to keep.** `delete row.password_hash` is the
same length and fails in the opposite direction: subtracting one known name
leaves every future column exposed by default, silently, shipped with a
migration nobody reviewed for this. Naming the keepers means a new column is
invisible to clients until someone comes to `user-view.ts` and says it may be
seen. `user-view.test.ts` pins that with a row carrying a column the module has
never heard of.

**Deliberately present in the response.** `version`, because a client that
cannot read it has nothing to put in the `If-Match` the writes require.

**Tests.** `API3:2023` — digest absent from the single read and from the
collection, asserted against the serialised body as well as the parsed one;
self-update assigning roles refused; the same caller's email change allowed;
an administrator may assign roles; an unknown property never reaches a
statement.

## API4:2023 — Unrestricted Resource Consumption

**Controls.** `express.json()`'s 100 kB default on the general API and a
tighter 1 MB cap on the webhook subtree (`WEBHOOK_MAX_BODY_BYTES` — that body
must be buffered in full before anything about the caller is known, so the cap
is the only thing between an unauthenticated request and that much heap).
10 MB per uploaded file (`MAX_FILE_SIZE_BYTES`). Per-endpoint rate limits.
Two-second per-attempt deadlines on every user query, with `lock_timeout` set
below them so a contended write answers 409 rather than holding a pooled
connection past its own deadline. Bulkheads, breakers and three deadlines on
every outbound call (`docs/outbound-http.md`). Backpressure rather than
buffering on the CSV import (`docs/csv-ingest.md`).

**Fixed with this checklist.** The body-size limit worked and reported itself
as `500 INTERNAL_ERROR`, because nothing translated body-parser's errors. The
caller was told "An unexpected error occurred" for a request it could have
fixed, and this process wrote a stack trace to the error log for every
oversized body — which let anyone fill that log from an unauthenticated
endpoint, turning a resource-consumption control into a resource-consumption
problem. `src/middleware/body-parser.errors.ts` maps them; `413
PAYLOAD_TOO_LARGE` is what a caller now sees.

**Not covered.** `GET /v1/users` is unpaginated — `findAll` with no limit —
so the response grows with the table. It is admin-only, which bounds who can
ask but not what it costs. Pagination is its own spec item and the helper
already exists (`src/lib/pagination.ts`). There is also no global concurrency
cap on inbound requests, and no per-principal budget: the limits above are
per IP.

**Tests.** `API4:2023` — oversized body refused as 413; the refusal does not
spend the login budget (so nobody can lock a shared IP out by sending large
bodies); the webhook cap is lower than the general one.

## API5:2023 — Broken Function Level Authorization

**Control.** `requireRoles('admin')` on the collection read, the create, the
delete and the bulk import, composed once as `adminOnly` in
`users.router.ts` rather than repeated per route. The step is declared over an
authenticated request, so putting it above `authenticate` does not compile.

**Distinct from API1 and both are needed.** `DELETE /v1/users/:id` is an
administrator's operation whoever the subject is — owning the row does not open
it — while `GET /v1/users/:id` is available to the subject. A design that
answers only "may this kind of caller use this operation" is the BOLA bug; one
that answers only "is this your row" hands out the admin list.

**Tests.** `API5:2023` — collection, delete and import each refused to a
principal without the role, with the delete aimed at the caller's *own*
record; `401` rather than `403` when there is no principal at all.

## API6:2023 — Unrestricted Access to Sensitive Business Flows

**Controls.** `POST /v1/auth/magic-link` carries a three-per-15-minute budget
rather than sharing login's five: every accepted request sends mail to an
address the caller chose, so the ceiling is a statement about third parties
rather than about this service's CPU. Webhook deliveries carry a single-use
nonce (`src/webhooks/replay-guard.ts`) — inside the freshness window every copy
of a captured delivery verifies, because every copy *is* authentic, so the
signature and the window together still permit the same instruction a hundred
times in five minutes and only the nonce does not. `POST /v1/users` takes an
`Idempotency-Key`, so a retried create converges instead of creating a second
user.

**Not covered.** The replay guard is per process, so behind N replicas a
captured delivery gets one chance per replica. There is no CAPTCHA, no device
fingerprinting and no velocity model — the controls here are budgets and
single-use tokens, which stop repetition and not a distributed, patient
attacker.

**Tests.** `API6:2023` — the magic-link budget, that it is tighter than
login's, and a signed delivery accepted once then refused as `WEBHOOK_REPLAYED`.

## API7:2023 — Server Side Request Forgery

**There is no reachable SSRF surface.** No route in this service takes a URL
from a caller and fetches it.

**The control exists anyway,** and that is the point of the row.
`resolveWithinBase` in `src/resilience/http-client.ts` confines every request a
client makes to the base URL that client was configured with: another origin, a
protocol-relative host swap, a `../` climb out of the base path and an absolute
path into a sibling subtree are all refused with `OutboundUrlNotAllowedError`
before the transport is touched.

The line it replaced was `new URL(String(input), baseUrl)`, which confines
nothing — `URL` resolution is specified to let the reference win. A client
named `payments` would have issued a request to whatever the argument said,
with the payments dependency's timeouts, its breaker and any credentials the
caller attached. Nothing could reach that today; it was one plausible feature
away — a callback URL, an avatar to mirror, an OIDC discovery document — and an
SSRF control added at the same commit as the feature that needs it is a control
added afterwards.

Confinement is to the base's *directory*, not merely its origin: origin alone
still lets a path reach an unrelated API behind the same gateway, which is
usually what an SSRF is trying to arrange. A client that needs two subtrees
wants two clients — one per dependency is already this module's rule, and it is
what gives each its own breaker. A client that needs to address anything at all
leaves `baseUrl` unset, which says so.

**Not covered.** No DNS-rebinding defence and no IP allowlist: the resolved
host is checked against the configured one, not against what it resolves to at
connect time. Closing that needs a custom dispatcher, which this module
deliberately leaves to the injected `fetch`.

**Tests.** `API7:2023`, through `createDependencyClient` so the confinement is
shown to survive the service-defaults wrapper every real dependency is built
with; plus the unit cases in `http-client.test.ts`, including the ones that
prove it does not over-refuse.

## API8:2023 — Security Misconfiguration

**Controls.** The helmet policy is mounted above everything, including the
metrics exposition and the 404 handler, so no response can escape it —
a security header present on the responses someone remembered is not a policy.
CORS is an allowlist from `CORS_ORIGIN`, and `CORS_ORIGIN=*` with
`CORS_ALLOW_CREDENTIALS=true` is refused at boot. `x-powered-by` is off. The terminal
error handler answers a fixed `INTERNAL_ERROR` and logs the detail rather than
sending it. Body-parser failures now answer a fixed string too, rather than
body-parser's own message, which quotes the offending input — and what a
caller sent is exactly where a mistyped secret ends up. Structured logs are
redacted (`docs/pii-redaction.md`). Configuration is validated by Zod at boot,
with cross-field invariants, so a misconfigured deployment does not start.

**Not covered.** TLS, HTTP methods at the edge, and the container's own
posture are the deployment's, not this service's. `docker-compose.yml` is a
development file and is not hardened.

**Tests.** `API8:2023` — headers on a response no route claimed; no framework
banner; an unconfigured origin gets no `Access-Control-Allow-Origin`; a
malformed body is not quoted back; an unhandled fault carries no stack and no
internal host.

## API9:2023 — Improper Inventory Management

**Controls.** Every route is mounted under `/v1` by a single router, so the
unversioned spelling of an endpoint is a 404 rather than an older, unguarded
copy of it still answering. The metrics exposition is outside `/v1` and
`env.ts` refuses a `METRICS_PATH` that is not. `HEALTH_EXPOSE_ERRORS` is off by
default, because a readiness endpoint is polled from further away than the API
it guards and a failing `pg` check names a host, a port and a database.
`GET /v1/health/ready` reports the API version it belongs to.

**Not covered.** There is no OpenAPI document and no generated route
inventory, so "what does this service expose" is answered by reading
`src/routes/v1/index.ts`. There is no deprecation policy and no mechanism for
retiring a version. Both are worth having and neither is here.

**Tests.** `API9:2023` — four unversioned paths 404; the health report names
`v1`; the metrics path is outside `/v1` and `/v1/metrics` 404s; failure detail
off by default.

## API10:2023 — Unsafe Consumption of APIs

**Controls.** The one place third-party data enters this service is
`POST /v1/webhooks/inbound`, and nothing about a delivery is interpreted before
its HMAC signature verifies over the bytes that actually arrived — which is why
`express.raw()` is mounted ahead of `express.json()` in `createApp` and why the
body stays a `Buffer` until the digest checks out (`JSON.parse` then
`JSON.stringify` is not the identity function, so a verifier working from the
parsed object refuses every sender whose serialiser differs from V8's). Method
and target are in the signed string. A digest mismatch and an unheld key id
answer identically, so nothing can enumerate the ring or measure a rotation's
progress. The size cap runs ahead of all of it. Outbound, every dependency call
is bounded by three deadlines, a breaker and a bulkhead, and a retry's drained
body is capped (`docs/outbound-http.md`).

**Not covered.** A verified payload's *shape* is not schema-validated at the
boundary — the handler acknowledges and enqueues rather than interpreting, so
there is nothing yet to validate, and whatever consumes these events will need
its own Zod schema. Redirects on outbound calls follow `fetch`'s default.

**Tests.** `API10:2023` — an unsigned delivery refused; a body altered after
signing refused; a bad digest and an unheld key id indistinguishable.

---

## Keeping this honest

Three rules for anything added to the test file:

1. **It goes through `createApp()`.** Most of these risks are compositional —
   the middleware that is mounted but too low, the guard that is on four routes
   and not the fifth — and no unit test can see any of it.
2. **It asserts a refusal, not the presence of a mechanism.** "The limiter is
   installed" is satisfied by a limiter with its budget set to infinity.
3. **Where the refusal must happen before something expensive or revealing,
   say so** — that no query ran, that two different failures are
   indistinguishable. That ordering is often the whole mitigation and it is
   invisible in a status code.

And a fourth for this document: a risk with no control gets a row that says
**none**, not a row pointing at something adjacent. There is no `describe`
block for a mitigation that does not exist, because a block containing an
assertion about something else is how a checklist starts lying.
