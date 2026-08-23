import { freezeInDev } from '@/lib/immutable';

/**
 * A hit, boxed.
 *
 * `undefined` alone cannot signal "miss": an operation is allowed to resolve
 * to `undefined`, and an unboxed `get` would re-run it on every request while
 * reporting a hit rate of zero. The box makes absence and a cached absence
 * distinguishable.
 */
export interface CacheHit<T> {
  value: T;
}

/**
 * Deliberately async and deliberately small. Async so a Redis or Memcached
 * implementation is a drop-in rather than a refactor; small because every
 * method here has to be implementable over a network without a footgun —
 * which is why there is no prefix scan. Scope an invalidation by giving that
 * resource its own store and calling `clear()`.
 */
export interface CacheStore {
  get<T>(key: string): Promise<CacheHit<T> | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

interface StoredEntry {
  value: unknown;
  expiresAt: number;
}

export interface MemoryCacheStoreOptions {
  /**
   * Hard ceiling on entries. A cache keyed by request URL is reachable by
   * anyone who can vary a query string, so an unbounded map is a memory
   * exhaustion primitive, not an optimisation.
   */
  maxEntries?: number;
  /** Injected so TTL expiry is testable without waiting. */
  now?: () => number;
}

/**
 * In-process LRU with per-entry TTL.
 *
 * In-process means per-replica: with N instances behind a load balancer a
 * write invalidates one cache and the other N-1 serve stale data until their
 * entries expire. That is a property of the deployment, not a bug here — it is
 * the reason `CacheStore` is an interface, and the reason TTLs on this
 * implementation should stay short.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheStoreOptions = {}) {
    const { maxEntries = 500, now = Date.now } = options;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(
        `MemoryCacheStore: maxEntries must be an integer >= 1, received ${maxEntries}`,
      );
    }
    this.maxEntries = maxEntries;
    this.now = now;
  }

  /** Live entries. Expired-but-not-yet-evicted keys are not counted. */
  get size(): number {
    let live = 0;
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.expiresAt > now) live += 1;
    }
    return live;
  }

  get<T>(key: string): Promise<CacheHit<T> | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }

    // Re-insert to move the key to the tail: `Map` iterates in insertion order,
    // which is what makes the eviction below least-recently-*used* rather than
    // least-recently-written.
    this.entries.delete(key);
    this.entries.set(key, entry);

    // The store is untyped by nature — one map holds values of every shape a
    // caller ever put in it. `T` is the caller's assertion about what they
    // stored under this key, exactly as it would be against Redis.
    return Promise.resolve({ value: entry.value as T });
  }

  /**
   * Stores the value by reference — and freezes it, in dev and test.
   *
   * Storing by reference is what separates this from a Redis store, and it is
   * not an implementation detail a caller can ignore: every later hit returns
   * the *same object*, so a handler that sorts the array it was given, or a
   * serialiser that strips a field before responding, has edited the cache. The
   * next hundred requests are answered from the edited copy and the entry heals
   * itself at the TTL, which is what makes it so hard to catch — the report is
   * "the list is sometimes in the wrong order" and the code that reordered it is
   * three modules away and correct-looking.
   *
   * The freeze is here rather than in `withCache` because this is where the
   * sharing happens. A store that serialises has no such hazard and should not
   * pay for a walk of the value.
   *
   * It also freezes the object the *current* caller is about to return, which
   * is the point: the first request is the one that mutates, so waiting until a
   * second request could observe it would report the bug to the wrong test.
   */
  set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(`MemoryCacheStore: ttlMs must be a finite positive number, got ${ttlMs}`);
    }

    freezeInDev(value);

    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    this.evictIfNeeded();

    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }

  /** Expired entries go first; only then does a live entry get sacrificed. */
  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;

    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry.expiresAt <= now) this.entries.delete(key);
    }

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }
}
