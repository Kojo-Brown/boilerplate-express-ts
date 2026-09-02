/**
 * A token bucket, which is the shape a per-connection limit has to be.
 *
 * The rate limiter in front of the REST routes is a fixed window, and that is
 * fine there: it counts requests by IP, over fifteen minutes, to stop credential
 * stuffing. Neither property survives the move to a socket.
 *
 * Fixed windows admit twice the limit across a boundary — 60 messages at
 * 00:00:59 and 60 more at 00:01:00 is 120 in one second under a "60 per minute"
 * rule — and on a request/response API that burst is absorbed by the client
 * waiting for 120 responses. On a socket there is nothing to wait for: a peer
 * can write as fast as the kernel accepts, so the burst *is* the attack. A
 * bucket admits at most `capacity` before it has to wait for refill, and that
 * is a real bound at every instant rather than an average over a window.
 *
 * Refill is lazy — computed from the elapsed time on each call rather than
 * driven by a timer. With one bucket per connection per dimension a timer-based
 * design is thousands of timers whose only job is to increment a number nobody
 * is reading, and the arithmetic is the same either way.
 */

export interface TokenBucketOptions {
  /**
   * The burst: tokens the bucket holds when full, and the most that can be
   * spent at one instant.
   */
  readonly capacity: number;

  /** The sustained rate, in tokens per second. */
  readonly refillPerSecond: number;

  /**
   * Injected so tests advance time instead of sleeping.
   *
   * Must be a monotonic source in production — `Date.now()` moves backwards
   * across an NTP step and a clock that goes backwards hands out negative
   * elapsed time. Defaults to `performance.now()` for that reason.
   */
  readonly now?: () => number;
}

export interface TokenBucket {
  /**
   * Spends `cost` tokens if the bucket has them.
   *
   * Returns `false` and spends nothing when it does not — a partial spend would
   * let a stream of over-budget messages drain the bucket forever and never be
   * admitted, which is starvation rather than throttling.
   */
  tryRemove(cost?: number): boolean;

  /** Tokens available now, after refill. For diagnostics and tests. */
  readonly available: number;

  /**
   * Seconds until `cost` tokens are available, `0` if they already are.
   *
   * This is what a client is told to wait, so it is deliberately not "when the
   * bucket is full" — the client needs one message through, not a full budget.
   */
  retryAfterSeconds(cost?: number): number;
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { capacity, refillPerSecond, now = (): number => performance.now() } = options;

  if (!(capacity > 0) || !Number.isFinite(capacity)) {
    throw new RangeError(`createTokenBucket: capacity must be a positive number, received ${capacity}`);
  }

  if (!(refillPerSecond > 0) || !Number.isFinite(refillPerSecond)) {
    throw new RangeError(
      `createTokenBucket: refillPerSecond must be a positive number, received ${refillPerSecond}`,
    );
  }

  let tokens = capacity;
  let lastRefillMs = now();

  function refill(): void {
    const nowMs = now();
    const elapsedMs = nowMs - lastRefillMs;
    // A non-monotonic clock, or a `now` a test moved backwards. Advancing the
    // timestamp without crediting anything keeps the bucket from being refilled
    // twice for the same interval once time moves forward again.
    if (elapsedMs <= 0) {
      lastRefillMs = nowMs;
      return;
    }

    tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSecond);
    lastRefillMs = nowMs;
  }

  return {
    tryRemove(cost = 1): boolean {
      if (cost <= 0) {
        throw new RangeError(`TokenBucket.tryRemove: cost must be positive, received ${cost}`);
      }

      refill();

      // A single message larger than the whole bucket can never be admitted, at
      // any rate, so treating it as "wait and retry" would be a lie. It is
      // refused here and the caller — which knows the message is over its
      // per-message ceiling — reports it as such.
      if (cost > tokens) return false;

      tokens -= cost;
      return true;
    },

    get available(): number {
      refill();
      return tokens;
    },

    retryAfterSeconds(cost = 1): number {
      refill();
      if (tokens >= cost) return 0;
      // Rounded up: a client told to wait 0 seconds for a deficit that needs
      // 200ms retries immediately and is refused again.
      return Math.ceil((cost - tokens) / refillPerSecond);
    },
  };
}
