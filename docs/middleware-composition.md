# Middleware composition

`compose()` — an ordered, immutable, *typed* chain of steps that ends in a route
operation. It replaces the array of middleware Express matches against a path:

```ts
router.get('/:id', requireAuth, validate({ params: userIdParamsSchema }), usersController.getById);
```

with a value that carries what those middleware established:

```ts
const authenticated = compose().use(authenticate);

router.get(
  '/:id',
  authenticated.use(validateParams(userIdParamsSchema)).handle(usersOperations.getById),
);
```

Source: `src/lib/pipeline/`. Live example: `src/users/users.router.ts`.

## What was wrong with the array

Not the ergonomics. Three things it cannot express, each of which had already
turned into a comment somewhere in this repo:

**Ordering.** `users.router.ts` carried the line _"auth stays ahead of
validation so an unauthenticated caller gets 401/403 without learning anything
about the accepted request shape."_ True, load-bearing, and enforced by nothing.
Swapping two arguments compiled, passed every test that did not send an
anonymous request with a malformed body, and leaked the schema.

**What a middleware proved.** `requireAuth` assigns `req.auth`, but `auth` is
declared on the global `Express.Request` augmentation, which describes every
request in the process — including the ones that never reach an auth middleware.
So it is `JwtPayload | undefined` forever, and every handler behind a token
answers that with `!` or a check that cannot fail. Same for `req.params` after a
Zod schema parsed it: still `Record<string, string>`.

**The gap between the two.** `toRequestHandler` casts the incoming `Request` to
the operation's own `TReq` — `Request<UserIdParams, unknown, UpdateUserBody>` —
and its comment justified the cast by saying `validate()` had run upstream. That
was a statement about a different file, checked by nobody.

`compose()` closes all three with the same mechanism: a step declares what it
needs and returns what it established, and the pipeline carries the accumulated
type to the operation at the end.

## A step

```ts
type PipelineStep<TIn extends Request, TOut extends Request = TIn> = (
  req: TIn,
  res: Response,
) => TOut | Promise<TOut>;
```

There is no `next`. `next()` overloads three unrelated signals onto one callback
— continue, fail, skip the rest of this route — and Express can neither tell you
which one a middleware meant nor stop it sending two. A step continues by
returning the request, fails by throwing, and says what it proved in its return
type:

```ts
export function authenticate<TReq extends Request>(req: TReq): Authenticated<TReq> {
  const principal = authenticateRequest(req);
  req.auth = principal;
  return req as Authenticated<TReq>;
}
```

The refinement is an assertion the step is trusted to make good on, exactly as
an assertion function is. What the type buys is that every *consumer* of the
claim is checked.

## How ordering becomes a compile error

`TIn` sits in a parameter position, so `strictFunctionTypes` checks it
contravariantly. `requireRoles` is declared over an authenticated request, so it
is assignable to `PipelineStep<TReq, …>` only when `TReq` already has `auth`:

```ts
compose().use(requireRoles('admin'));
//            ^ Types of parameters are incompatible
```

`compose.test.ts` asserts this with `@ts-expect-error`, paired with the response
the misordering actually produces — a 401 for admins and impostors alike. Same
for the operation at the end: `handle` takes a `RouteOperation<TResult, TReq>`,
so an operation written against a parsed body will not typecheck onto a pipeline
that never parsed one.

## Refinements

| Alias                     | Effect                                     |
| ------------------------- | ------------------------------------------ |
| `Authenticated<TReq>`     | `req.auth` becomes a required `JwtPayload` |
| `WithParams<TReq, T>`     | narrows `req.params`                       |
| `WithBody<TReq, T>`       | narrows `req.body`                         |
| `WithQuery<TReq, T>`      | narrows `req.query`                        |

All four are intersections, which is why a pipeline starts from `BaseRequest`
rather than Express's `Request`: `BaseRequest` types `body` and `query` as
`unknown` instead of `any`. `any & CreateUserBody` is `any`, so the body type a
step just proved would vanish — and `any` is why `req.body.email` typechecks on
a route with no validation at all, which is the defect being aimed at.

## Middleware that is not ours

`express-rate-limit`, `multer`, `passport`, `helmet`, `cors`. A composition
story that only works for handwritten steps is not one, so the adapter is part
of the design:

```ts
compose().use(fromRequestHandler(fileUpload.single('file')));
```

The price is stated in its type: it returns `PipelineStep<TReq, TReq>`, proving
nothing. Anything the middleware attached to `req` is reachable only through the
global augmentation, exactly as before. Three things it fixes on the way
through:

- **A second `next()`** is ignored. Express runs the remainder of the chain once
  per call, so a middleware whose callback both errors and succeeds answers
  twice — and on a real route writes twice.
- **Responding without calling `next`** — every rate limiter — would otherwise
  leave the promise waiting for a signal that is not coming.
- **A rejected promise** from an `async` middleware. Express 5 forwards one from
  a handler it invoked itself; the adapter invokes it directly, so it forwards
  it here or loses it.

It refuses `next('route')` and `next('router')` with a 500 rather than guessing.
A composed pipeline is a single handler as far as Express is concerned, so there
is no remaining stack to abandon: treating it as `next()` would run the
operation the middleware asked to skip, and treating it as an error would report
a 500 for a routing decision. Middleware that wants that behaviour belongs on
the router, ahead of the pipeline, where Express can still act on it.

## Stopping early

A pipeline stops when the response has been written — `res.headersSent ||
res.writableEnded` — rather than on a sentinel a step returns. The steps that
end an exchange early are mostly not ours: a 429, a redirect to a consent
screen, a 304. None can be taught a new protocol, and all announce themselves
the same way.

## What it is not

- **Not a `next()` replacement app-wide.** `app.use()` middleware — the session,
  passport's initialiser, the correlation id, the container scope — stays as it
  is. A pipeline is per route, and it starts where the route does.
- **Not cancellation-aware.** `AbortSignal` is built by `toRequestHandler` at
  the end of the chain, so a client that disconnects during a slow step is
  noticed only once the operation starts. Steps are expected to be short; the
  work with a deadline on it belongs in the operation, where `withTimeout` can
  reach it.
- **Not a router.** No branching, no `next('route')`, no mounting. One ordered
  chain per route.

## The tradeoff worth naming

`requireRoles('admin')` used to be visible in the route table. It still is —
`adminOnly.handle(...)` — but the roles are named where the pipeline is built,
one file away, rather than inline on every line. That is a real loss of
greppability at the route table, bought for a real gain: the check can no longer
be in the wrong place, and the route table now says *which* named policy a route
is under rather than repeating its parts.

## Composing with the route decorators

`handle` takes the same `RouteOperation` the decorators wrap, so a decorated
stack drops in unchanged, and `toRequestHandler` is built once per route rather
than once per request — a `withCache` in that stack keeps one store and one
in-flight map for the life of the route.

```ts
router.get('/:id', authenticated.use(validateParams(userIdParamsSchema)).handle(cachedRead(getUser)));
```

See [Route decorators](./route-decorators.md).
