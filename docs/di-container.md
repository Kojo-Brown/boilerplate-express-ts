# Dependency injection container

A hand-rolled container with three lifetimes — `singleton`, `scoped`,
`transient` — and no decorators, no `reflect-metadata`, and no ambient registry.

- `src/lib/container/` — the mechanism (`createContainer`, `createToken`)
- `src/container/tokens.ts` — every token this service resolves
- `src/container/app-container.ts` — the composition root
- `src/middleware/container.middleware.ts` — one scope per HTTP request

## What this replaces

Before this, a shared collaborator was a module-level `new`:

```ts
// users.repository.ts
export const userRepository = new UserRepository();
```

That is a singleton. It is one instance, created on first import, shared by
everyone — the exact lifetime the container now gives it. So the container buys
nothing in *instance count*. What it buys is that the lifetime became a
decision:

- The module version cannot say whether that instance may hold per-request
  state. Nothing complains when it starts to, and the bug — request ten reading
  request one's data — appears under concurrency, in production, months later.
- The module version has no other lifetime available. Something that genuinely
  is per-request has to be threaded through as an argument or stashed on `req`,
  and the two conventions coexist forever.
- The module version is created by whoever imports it first. `dispose()` has
  nowhere to live, and there is no seam for a test to substitute a fake without
  `jest.mock`.

The container makes the choice explicit, gives the other two lifetimes a name,
and — the part that matters — makes the *wrong combination* a loud error.

## The three lifetimes

| lifetime    | instances                | disposed by  | may depend on            |
| ----------- | ------------------------ | ------------ | ------------------------ |
| `singleton` | one per container        | the container| singletons only          |
| `scoped`    | one per scope            | the scope    | singletons, scoped       |
| `transient` | one per `resolve`        | the caller   | singletons, scoped\*     |

\* a transient resolved inside a scope resolves its dependencies in that scope;
one resolved from the root resolves at the root, where scoped tokens do not
exist.

```ts
const USER_REPOSITORY = createToken<UserRepository>('UserRepository');

container
  .registerSingleton(USER_REPOSITORY, () => new UserRepository())
  .registerValue(EVENT_BUS, domainEventBus)
  .registerSeed(REQUEST)
  .registerScoped(REQUEST_CONTEXT, (resolve) => createRequestContext(resolve.resolve(REQUEST)));
```

`registerValue` is a singleton the container did not build and therefore never
closes. `registerSeed` declares a token with no factory at all, filled per scope
by `scope.seed(...)` — the only way something like the live HTTP request can
enter the graph.

## The captive dependency

This is the bug the lifetimes exist to prevent, and the reason the container is
worth its weight:

```ts
container
  .registerScoped(REQUEST_CONTEXT, …)
  .registerSingleton(AUDIT_SERVICE, (resolve) => new AuditService(resolve.resolve(REQUEST_CONTEXT)));
```

`AuditService` is built once. It captures the first request's context and holds
it for the life of the process, so every audit line for the next month is
attributed to whoever happened to hit the service at boot. Every test passes:
one request in a test never reveals it.

Singleton factories therefore resolve against the **root**, where scoped tokens
are not available, and the resolution fails immediately with
`CaptiveDependencyError` naming the path (`AuditService → RequestContext`). The
error message says what the fix is not: widening `REQUEST_CONTEXT` to a
singleton makes the error go away and keeps the bug. Either the consumer becomes
scoped, or the per-request value is passed to the method that needs it.

The same check catches it through an intermediate transient, because the path is
carried through the whole resolution rather than checked one edge at a time.

## Scopes are requests

`containerMiddleware` opens a scope, seeds the request into it, and disposes it
when the response closes:

```ts
app.use(correlationIdMiddleware);
app.use(requestLogger);
app.use(containerMiddleware);
```

Handlers reach it through `scopeOf(req)`, which turns a missing scope into one
500 rather than a null check per call site. It is installed after the
correlation-id middleware so scopes are named `request:<correlation-id>` in
error messages, and ahead of every router so no handler has to ask whether it
has one.

Disposal hangs off `close`, not `finish`. `finish` fires only when a response
was actually sent, so a client that hangs up mid-request would leave its scope —
and anything the scope had opened — alive until the process restarted. Disposal
is not awaited: nothing downstream waits on it, and holding the socket open
while a scope drains would make a slow disposer look like a slow endpoint.

A scoped instance is created at the **first resolve**, which is not the moment
the request arrived. `RequestContext` therefore exposes accessors over the
request rather than a snapshot of it — a context resolved before `requireAuth`
runs would otherwise freeze `actorId: null` and quietly anonymise the audit
trail.

## Decisions worth knowing

**Factories are synchronous.** An async factory makes `resolve` return a
promise, which means every consumer awaits its collaborators, and two concurrent
resolutions of the same singleton can both enter the factory before either
stores a result — "singleton" quietly becomes "usually one". Anything needing
I/O to construct is registered already-built with `registerValue`, or exposes an
`init()` the composition root awaits once at boot.

**Transients cannot declare a disposer.** The option does not exist on
`registerTransient`. The container hands a transient over and forgets it;
keeping a reference so it could be closed later would make every resolve a leak
for as long as the owner lives. If a transient owns a resource, the caller owns
closing it, and the missing option is what says so at the registration site.

**Re-registering a token throws.** Last-write-wins is how a test harness's stub
ends up serving production traffic. Tests build their own container from
`registerAppDependencies` instead of mutating the process-wide one.

**Tokens are invariant in their type.** The phantom field is typed
`(value: T) => T` rather than `T`, so `InjectionToken<AdminUser>` is neither
assignable to nor from `InjectionToken<User>`. A covariant phantom would let
`registerValue<User>(adminUserToken, someUser)` typecheck — registering the
wider value under the narrower token.

**Disposal runs in reverse creation order and continues past failures.**
Creation order is dependency order, so the last thing built lets go first; and a
scope that stopped disposing at the first failure would leak everything it had
not reached yet. Failures go to the container's `onDisposeError` reporter.

**`container.dispose()` does not dispose live scopes.** A container holding
every scope it ever handed out would be a per-request leak. Scopes are disposed
by whoever created them — which is the middleware.

## What is not registered

Nothing in this service is `transient`, and that is a finding rather than an
omission. A transient earns its keep when instances accumulate per-use state
that must not be shared — a query builder, a retry budget. Every collaborator
here is either stateless, where a singleton is strictly cheaper, or per-request,
which is what `scoped` means.

`appContainer.dispose()` is not wired to a signal handler. Draining the server
and closing the pool is its own spec item, and a container that closed the pool
while requests were still in flight would be the bug that item exists to
prevent.
