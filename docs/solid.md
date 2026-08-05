# SOLID audit

An audit of this codebase against the five SOLID principles, with the refactor
each finding produced. Every "before" below is code that was actually in the
repository at the time of the audit, not an invented example.

Three of the five findings were also behavioural defects: a duplicate email
returned `500`, `findByRole` returned the wrong rows, and a `422` told the
client nothing about which field was wrong. That is the useful part of a SOLID
audit — the principles are a way of finding bugs, not a style guide.

| Principle | Finding | Where |
|---|---|---|
| [SRP](#single-responsibility) | Controllers did transport, validation and error mapping | `auth.controller.ts`, `users.controller.ts` |
| [OCP](#openclosed) | Error middleware closed to extension, so modules grew parallel handlers | `error.middleware.ts`, `upload.router.ts` |
| [LSP](#liskov-substitution) | Subclass cast past the base class's contract and got the wrong semantics | `users.repository.ts` |
| [ISP](#interface-segregation) | A test-only method on the interface every consumer depends on | `token-store.ts` |
| [DIP](#dependency-inversion) | Service imported the concrete store and a hardcoded user array | `auth.service.ts` |

---

## Single Responsibility

**Finding.** `authController` and `usersController` each held three
responsibilities: HTTP transport, request validation, and mapping validation
failure onto a response. Every handler repeated the same six-line
`safeParse` / `throw AppError(422)` preamble.

This also contradicted the repo's own stated convention — *"Validation is Zod
middleware at the edge; handlers assume parsed input"* — while
`validate.middleware.ts`, which does exactly that, sat unused by these routers.

**Why it mattered beyond tidiness.** The hand-rolled `AppError(422, 'Validation
failed')` discards Zod's `issues`. `ValidationError` — the type `validate()`
throws — carries them. So a client posting a bad email got:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Validation failed" } }
```

with no indication of *which* field failed, while every route that already used
the middleware returned the field paths. Two different `422` contracts in one API.

**Before** — `src/users/users.controller.ts`:

```ts
const createUserSchema = z.object({ /* ... */ });

async create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, 'Validation failed', 'VALIDATION_ERROR');
    const user = await userRepository.create(parsed.data);
    sendCreated(res, user);
  } catch (err) {
    next(err);
  }
}
```

**After** — schemas move to `users.schemas.ts`, the router applies them, and the
controller is transport only:

```ts
// users.router.ts
router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validate({ body: createUserBodySchema }),
  usersController.create,
);

// users.controller.ts
async create(req: WithBody<CreateUserBody>, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await userRepository.create(req.body);
    sendCreated(res, user);
  } catch (err) {
    next(err);
  }
}
```

Middleware order matters and was preserved: `requireAuth`/`requireRole` stay
ahead of `validate`, so an unauthenticated caller still gets `401`/`403` without
learning the accepted request shape; the auth rate limiters stay ahead of
validation so malformed floods are still throttled.

`req.params.id` is now validated too, which removes the
`req.params['id'] as string` cast the controller needed to convince the compiler
a path parameter existed.

**Verified by** `users.e2e.test.ts` → *"returns the failed field in the 422
issues array"*, plus the pre-existing `422`/`403`/`401` e2e cases, which pin the
ordering.

---

## Open/Closed

**Finding.** `errorMiddleware` was a fixed `instanceof` ladder. Teaching the API
that some new error family means something specific required editing the
middleware — the definition of closed to extension.

The evidence this was already hurting: `upload.router.ts` carried its own
error-handling middleware whose entire job was translating `MulterError` into an
`AppError`, because there was no way to contribute that knowledge to the central
handler:

```ts
// src/upload/upload.router.ts — before
function multerErrorHandler(err: unknown, _req, _res, next: NextFunction): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(new AppError(413, 'File exceeds the 10 MB size limit', 'FILE_TOO_LARGE'));
    } else {
      next(new AppError(400, err.message, 'UPLOAD_ERROR'));
    }
    return;
  }
  next(err);
}
```

One module worked around the closure. The module that did not work around it
paid for it: **a Postgres integrity violation had no translation at all**, so
`POST /v1/users` with an email that already exists raised SQLSTATE `23505`, fell
past every `instanceof` branch, and returned `500 INTERNAL_ERROR`. A conflict the
client caused and can fix was reported as a server fault.

**After.** A translator registry. Each translator claims one error family or
returns `null`:

```ts
// src/lib/error-translators.ts
export type ErrorTranslator = (err: unknown) => TranslatedError | null;

export function registerErrorTranslator(translator: ErrorTranslator): void { /* ... */ }
export function translateError(err: unknown): TranslatedError | null { /* ... */ }
```

```ts
// src/middleware/error.middleware.ts — now closed for modification
const translated = translateError(err);
if (translated !== null) {
  sendFail(res, translated.statusCode, translated.code, translated.message, translated.issues);
  return;
}
if (err instanceof Error) console.error('[unhandled error]', err.message, err.stack);
sendFail(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
```

Each module owns its own mapping — `db/db.errors.ts` for SQLSTATE codes,
`upload/upload.errors.ts` for Multer — and `app.ts`, the composition root, wires
them up. The error middleware imports neither `pg` nor `multer`. The route-local
`multerErrorHandler` is deleted; its behaviour is now the registered translator's,
and applies to any future route that accepts a file.

Design decisions worth naming:

- **`null` means "not mine", and only the middleware may produce a 500.** A
  translator cannot invent a fallback, so a genuine bug can never be dressed up
  as a tidy `4xx`.
- **Core translators are registered first.** An explicit `AppError` always beats
  a heuristic match on a library's error shape.
- **`ValidationError` is matched before `AppError`,** its superclass. The reverse
  order silently swallows the subclass and drops `issues`. There is a regression
  test for exactly this ordering.
- **Registration is idempotent by function identity.** `createApp()` runs once
  per test file and more than once in some suites; without the guard the chain
  would grow without bound.
- **Driver messages are never forwarded.** Postgres names the constraint, the
  column and sometimes the offending value. The client gets a fixed message.

Unmapped SQLSTATEs still produce a `500` on purpose: `42P01` (undefined table) is
our bug, not the caller's, and dressing it as a `4xx` would hide it.

**Verified by** `error-translators.test.ts`, `db.errors.test.ts`,
`upload.errors.test.ts`, `error.middleware.test.ts`, and end-to-end in
`users.e2e.test.ts` (*409, not 500, when the email is already taken* — and *still
500 for a genuine server-side SQL fault*) and `upload.e2e.test.ts`.

---

## Liskov Substitution

**Finding.** `UserRepository.findByRole` used a cast to push a value through
`BaseRepository.findWhere` that the base class's contract does not accept:

```ts
// src/users/users.repository.ts — before
async findByRole(role: string): Promise<UserRow[]> {
  return this.findWhere({ roles: [role] as unknown as string[] });
}
```

`findWhere` builds `WHERE "roles" = $1` — equality. The `roles` column is
`text[]`. So this asked *"whose role list is exactly `['admin']`"*, not *"who
holds the role `admin`"*. The seeded admin, whose roles are `['admin', 'user']`,
did not match. The method silently returned the wrong rows.

The `as unknown as string[]` is the tell. The cast is a no-op — `[role]` is
already `string[]` — so it was not fixing a type error; it was there to quiet the
discomfort of using an inherited method for something it does not do. A subclass
that has to cast its way past the base class's contract is not substitutable for
it, and here the compiler was right.

**After.** The subclass needs containment, so the base class gains containment
rather than being subverted:

```ts
// src/db/repository.ts
protected async findWhereArrayContains(
  column: Extract<keyof TRow, string>,
  values: readonly unknown[],
  options: FindAllOptions = {},
): Promise<TRow[]> { /* WHERE "column" @> $1 */ }
```

```ts
// src/users/users.repository.ts
async findByRole(role: string): Promise<UserRow[]> {
  return this.findWhereArrayContains('roles', [role]);
}
```

`column` is constrained to `Extract<keyof TRow, string>`, so a caller cannot
route arbitrary text into the SQL, and the cast is gone.

**Verified by** `users.repository.test.ts` → *"asks for containment, not array
equality"* (asserts the emitted SQL contains `"roles" @> $1` and *not*
`"roles" = $1`) and *"returns users who hold the role alongside others"*.

---

## Interface Segregation

**Finding.** The refresh token store exposed `size()`, used by nothing but
tests. Extracting the interface the auth service depends on would have dragged
`size()` along with it, forcing every future implementation — including a
DB-backed one, where the honest implementation is a `SELECT count(*)` on every
call — to satisfy a method that exists for test convenience.

**After.** Two interfaces, so production consumers depend only on what they call:

```ts
// src/auth/auth.types.ts
export interface RefreshTokenStore {
  add(token: string, userId: string): Promise<void>;
  has(token: string): Promise<boolean>;
  remove(token: string): Promise<void>;
  removeAllForUser(userId: string): Promise<void>;
}

export interface InspectableRefreshTokenStore extends RefreshTokenStore {
  size(): number;
}
```

`authService` is typed against `RefreshTokenStore`. The in-memory implementation
returns `InspectableRefreshTokenStore`, so existing tests keep `size()` without
that being a requirement anyone else has to meet.

`UserDirectory` was drawn the same way: one method, `findByEmail`. The auth
service has no business listing, creating or deleting users, so its view of the
user store does not admit those.

---

## Dependency Inversion

**Finding.** `authService` imported the concrete in-memory token store, and
carried the user "database" inline as a module-level array:

```ts
// src/auth/auth.service.ts — before
import { tokenStore } from '@/auth/token-store';

const MOCK_USERS: MockUser[] = [ /* ... */ ];

export const authService = {
  async login(req: LoginRequest): Promise<LoginResponse> {
    const user = MOCK_USERS.find((u) => u.email === req.email);
    // ...
    tokenStore.add(tokens.refreshToken, user.id);
  },
};
```

The policy (authenticate, rotate, revoke) depended directly on two details.
Phase 3's DB-backed store means editing the service, and the only way to test
against a different set of users was `jest.mock`.

**After.** The service depends on `UserDirectory` and `RefreshTokenStore`, and is
constructed with them:

```ts
export function createAuthService({ users, tokens }: AuthServiceDeps): AuthService {
  return {
    async login(req: LoginRequest): Promise<LoginResponse> {
      const user = await users.findByEmail(req.email);
      // ...
      await tokens.add(pair.refreshToken, user.id);
    },
    // ...
  };
}

/** Composition root for the default wiring used by the HTTP layer. */
export const authService: AuthService = createAuthService({
  users: inMemoryUserDirectory,
  tokens: tokenStore,
});
```

The seeded users moved to `in-memory-user-directory.ts`; the token store became
`createInMemoryTokenStore()` plus a default instance.

**The store interface is async even though the current implementation wraps a
`Map`.** This is the whole point: a synchronous signature would be
unimplementable by the DB-backed store the abstraction exists to allow, so the
seam would be decorative. `oauthService.issueTokens` became `async` to match.

**What was deliberately *not* injected.** `verifyPassword` and the JWT helpers
stay module imports. They are pure functions over their arguments with no
lifecycle, no connection and no substitutable policy; injecting them would add
indirection and buy nothing. DIP is about not depending on volatile details, not
about parameterising everything.

**Verified by** `auth.service.test.ts` → *"createAuthService — injected
collaborators"*: five cases that substitute both dependencies with plain objects,
including one asserting the injected store received the token *and* the default
singleton did not, and one that a store failure propagates rather than being
swallowed.

---

## Considered and not changed

- **Splitting `BaseRepository` into read and write interfaces.** Defensible on
  ISP grounds, but there is no read-only table in the schema and no consumer that
  needs the narrow half. Applying it now would be ceremony justified by a
  hypothetical. Worth revisiting when a view or append-only table lands.
- **Injecting the repository into `usersController`.** The controller reaches for
  the `userRepository` singleton directly. That is a real coupling, but the
  controllers are thin transport with no policy to test in isolation, and the
  e2e suite already substitutes the query layer. Revisit if a controller grows
  logic worth unit-testing.
- **`getPool()` / `getS3()` module-level singletons.** Same reasoning: real
  coupling, but both are already substitutable at the seam the tests use
  (`@/db/query` and `@/upload/s3.service` respectively).

## Verification

All gates pass on this change:

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` (`--max-warnings=0`) | pass |
| `pnpm test` | pass — 258 tests, 23 suites (was 213 / 18) |
| `pnpm build` | pass |

No test was weakened to accommodate a refactor. The assertions that changed
changed because the API did: `tokenStore.has()` and `oauthService.issueTokens()`
return promises now, so their call sites `await`.
