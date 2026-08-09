# Route decorators

`withRetry`, `withTimeout` and `withCache` — the decorator pattern applied to
request handling. Each takes a unit of work and returns the same shape with one
cross-cutting concern added, so they nest in any order and none of them knows
the others exist.

Source: `src/lib/route-decorators/`. Live example: `src/users/users.controller.ts`.

## The unit of work is not an Express handler

The obvious signature — decorate `(req, res, next) => void` — cannot be made to
work for two of the three:

- **Retry.** Once the handler has called `res.json()`, a retry has nothing to
  retry into. The status line is already on the wire. A wrapper can check
  `res.headersSent` and refuse, but then it retries only handlers that failed
  before writing, which is a subset it cannot describe to its caller.
- **Cache.** There is no return value to store. The only thing to memoise is a
  recording of the calls the handler made against `res`, replayed later — which
  is a fragile reimplementation of HTTP caching inside the process.

So the decorators wrap a `RouteOperation` instead:

```ts
type RouteOperation<TResult, TReq extends Request = Request> = (
  req: TReq,
  ctx: OperationContext,
) => Promise<TResult>;
```

Request in, value out. `toRequestHandler` puts the `res` back at the edge, and
it is the only file in the stack that imports `Response`.

```ts
router.get(
  '/:id',
  requireAuth,
  validate({ params: userIdParamsSchema }),
  toRequestHandler(
    withCache(withRetry(withTimeout(getUser, { ms: 2_000 }), { attempts: 3 }), {
      ttlMs: 5_000,
      namespace: 'users',
      store: usersCache,
    }),
  ),
);
```

## `OperationContext`

Threaded through every layer:

| Field     | Purpose                                                                |
| --------- | ---------------------------------------------------------------------- |
| `signal`  | Cancellation. Aborted on client disconnect or an enclosing timeout.    |
| `attempt` | 1 on the first call; `withRetry` increments it.                        |
| `meta`    | Shared by reference; emitted as the response envelope's `meta`.         |

`meta` is how a decorator reports what it did without a return channel:
`withCache` writes `cache: 'hit' | 'miss' | 'coalesced' | 'bypass'`, `withRetry`
writes `attempts: n` when `n > 1`. Both land on the wire:

```json
{ "data": [...], "meta": { "cache": "hit" }, "error": null }
```

## `withTimeout`

Fails the operation if it has not settled within `ms`, as a `TimeoutError`
(a 504-carrying `AppError`, so the existing translator chain handles it with no
new registration).

The timer does not merely stop waiting — it **aborts the signal** with the
`TimeoutError` as the abort reason. An operation that respects its signal stops
immediately rather than running on unobserved, holding the pooled connection
the deadline was supposed to release.

`ms` is validated at wiring time. A route configured with `ms: 0` fails at
import, not by silently never timing out in production.

## `withRetry`

Re-runs the operation while it keeps failing transiently. Two guards keep it
from making an incident worse:

**Non-idempotent methods run exactly once.** `GET`, `HEAD`, `OPTIONS`, `PUT` and
`DELETE` are replayable; `POST` and `PATCH` are not, because a retry after an
ambiguous failure — the write committed, the response was lost — creates a
second resource or applies a delta twice. `retryNonIdempotent: true` overrides
this for an operation you know is idempotent in fact whatever its method says.

**An aborted signal ends the loop.** A client that hung up, or an enclosing
deadline that has already blown, stops the remaining attempts instead of
spending them on work nobody will read. The backoff sleep is abortable too.

The default predicate (`isTransientError`) retries a 5xx `AppError` and anything
that is *not* an `AppError`, on the grounds that a raw throw is infrastructure
(socket reset, pool exhausted, DNS). A 4xx is never retried: it is a decision
this service already made, and the second attempt reaches the same one slower.

Backoff is exponential with **full jitter** — `random() * min(max, base * 2^n)`.
A fixed schedule re-synchronises every client that failed together, so the
retries arrive as one spike and the recovery fails the way the outage did.
`sleep` and `random` are injectable, so the schedule is asserted rather than
waited for.

## `withCache`

Memoises the result per key for `ttlMs`.

**The key includes the principal.** `defaultCacheKey` is
`userId:METHOD:originalUrl`. Omitting the caller turns a cache into a
cross-account leak the moment a route's answer depends on who is asking — which
`GET /v1/users` does. Anonymous callers share one bucket because they are
indistinguishable.

**Only `GET` and `HEAD` are cached.** Everything else passes straight through
and records `cache: 'bypass'`, so the decorator is safe on a stack that mixes
methods.

**Failures are never cached.** A rejected attempt leaves no entry, so a
momentary fault does not become a TTL-long outage served from memory.

**Concurrent misses are coalesced.** The in-flight promise is shared, so a
hundred simultaneous requests for a cold key make one call. Without this a cache
amplifies stampedes at exactly the moment it is most needed — expiry under load.

### `CacheStore`

```ts
interface CacheStore {
  get<T>(key: string): Promise<CacheHit<T> | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
```

Async so Redis is a drop-in. `get` returns a **box** rather than the value:
an operation is allowed to resolve to `undefined`, and an unboxed `get` cannot
tell that from a miss. There is deliberately no prefix scan — it is a footgun
over a network. Scope invalidation by giving each resource its own store and
calling `clear()`.

`MemoryCacheStore` is an LRU with per-entry TTL and a hard `maxEntries` ceiling
(default 500). The ceiling is not tuning: a cache keyed by request URL is
reachable by anyone who can vary a query string, so an unbounded map is a memory
exhaustion primitive. `now` is injectable so TTL behaviour is asserted, not
slept through.

**It is per-replica.** With N instances behind a load balancer, a write
invalidates one cache and the other N-1 serve stale data until their entries
expire. That is a property of the deployment, not a bug — and it is why the TTL
on the users routes is five seconds rather than five minutes.

## Composition order

Both directions are meaningful:

| Stack                          | Behaviour                             |
| ------------------------------ | ------------------------------------- |
| `withRetry(withTimeout(op))`   | A deadline **per attempt**.           |
| `withTimeout(withRetry(op))`   | One deadline **across all attempts**. |

`withCache` belongs outermost: a hit should cost nothing below it.

## What the users routes actually do

`src/users/users.controller.ts` wires the full stack on reads —
cache → retry → per-attempt timeout — and every write calls `usersCache.clear()`.

Writes get a **timeout but no retry**, even though `PUT` and `DELETE` are in the
replayable set. That is the trap the default is there to make visible: a delete
whose first attempt commits and then loses the connection would answer 404 on
the retry, reporting failure for work that succeeded. Replaying a write safely
needs a deduplication key, not a retry loop — a separate mechanism, and a
separate spec item.
