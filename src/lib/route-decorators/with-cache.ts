import type { Request } from 'express';
import type { CacheStore } from '@/lib/route-decorators/cache-store';
import { MemoryCacheStore } from '@/lib/route-decorators/cache-store';
import type { RouteOperation } from '@/lib/route-decorators/types';

/**
 * Only the methods HTTP defines as safe. Anything else falls through
 * untouched: serving a cached body for a `POST` is wrong, and *storing* one is
 * worse, because the next `GET` would read a write's response.
 */
const CACHEABLE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** What `withCache` records in `ctx.meta.cache`. */
export type CacheOutcome = 'hit' | 'miss' | 'coalesced' | 'bypass';

export interface CacheOptions<TReq extends Request = Request> {
  /** Entry lifetime. Keep it short for `MemoryCacheStore` — see that class. */
  ttlMs: number;
  /**
   * Prefixes every key. Also the unit of invalidation: give a resource its own
   * store, `clear()` it on write.
   */
  namespace: string;
  /** Defaults to a fresh `MemoryCacheStore`. Pass a shared one to invalidate. */
  store?: CacheStore;
  /** Overrides the key derivation. See `defaultCacheKey` for what it must do. */
  key?: (req: TReq) => string;
}

/**
 * Method + URL + principal.
 *
 * The principal is not optional decoration. Two users calling the same
 * authenticated URL get different answers, and a key that omits who is asking
 * turns a cache into a cross-account data leak the moment one of those routes
 * is authorisation-dependent — which `GET /v1/users` is. Anonymous requests
 * share one bucket because they are, by definition, indistinguishable.
 */
export function defaultCacheKey(req: Request): string {
  const principal = req.auth?.userId ?? 'anonymous';
  return `${principal}:${req.method.toUpperCase()}:${req.originalUrl}`;
}

/**
 * Memoises the operation's result per key for `ttlMs`.
 *
 * Three behaviours worth knowing:
 *
 * - **Failures are never cached.** A rejected attempt leaves no entry, so a
 *   momentary upstream fault does not become a TTL-long outage served from
 *   memory.
 * - **Concurrent misses are coalesced.** The in-flight promise is shared, so a
 *   hundred simultaneous requests for a cold key make one call instead of a
 *   hundred. Without this, a cache is a stampede amplifier at exactly the
 *   moment it is most needed — expiry under load.
 * - **Writes bypass it entirely** rather than being rejected, so the decorator
 *   is safe to apply to a router-level stack that mixes methods.
 */
export function withCache<TResult, TReq extends Request = Request>(
  operation: RouteOperation<TResult, TReq>,
  options: CacheOptions<TReq>,
): RouteOperation<TResult, TReq> {
  const { ttlMs, namespace, store = new MemoryCacheStore(), key = defaultCacheKey } = options;

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`withCache: ttlMs must be a finite positive number, received ${ttlMs}`);
  }

  // Per-decorator, not per-store: coalescing is about the calls this route is
  // making right now, and a shared store may be serving several of them.
  const inFlight = new Map<string, Promise<TResult>>();

  return async (req, ctx) => {
    if (!CACHEABLE_METHODS.has(req.method.toUpperCase())) {
      ctx.meta['cache'] = 'bypass' satisfies CacheOutcome;
      return operation(req, ctx);
    }

    const cacheKey = `${namespace}:${key(req)}`;

    const hit = await store.get<TResult>(cacheKey);
    if (hit !== undefined) {
      ctx.meta['cache'] = 'hit' satisfies CacheOutcome;
      return hit.value;
    }

    const pending = inFlight.get(cacheKey);
    if (pending !== undefined) {
      ctx.meta['cache'] = 'coalesced' satisfies CacheOutcome;
      return pending;
    }

    const work = operation(req, ctx)
      .then(async (result) => {
        await store.set(cacheKey, result, ttlMs);
        return result;
      })
      .finally(() => {
        inFlight.delete(cacheKey);
      });

    inFlight.set(cacheKey, work);
    ctx.meta['cache'] = 'miss' satisfies CacheOutcome;

    return work;
  };
}
