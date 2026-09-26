/**
 * The second half of replay protection: remembering which nonces have been
 * spent, for exactly as long as the freshness window would still accept them.
 *
 * ## Why the timestamp window is not enough on its own
 *
 * A signature attests that a body came from the holder of a secret. It says
 * nothing about when, or about how many times. The timestamp inside the signed
 * string fixes the "when" — a captured delivery stops verifying once it falls
 * outside the tolerance — and that alone reduces an indefinite replay window to a
 * few minutes.
 *
 * What it cannot do is reduce it to zero, and the remaining few minutes are not
 * a rounding error: they are the window in which someone positioned to capture
 * one delivery can present it again, as many times as they like, and every copy
 * verifies because every copy *is* authentic. For a webhook that moves money or
 * revokes access, "the same instruction, one hundred times, within five minutes"
 * is the whole attack.
 *
 * So the sender includes a single-use nonce in the signed string and the receiver
 * refuses a nonce it has already seen. The two mechanisms are exactly
 * complementary, and the shape of the complement is what bounds this cache: a
 * nonce only has to be remembered until its timestamp leaves the window, because
 * after that the window check refuses the delivery anyway. Retention is therefore
 * the tolerance and not a number anyone has to choose, and the cache's size is
 * bounded by (delivery rate x tolerance) rather than by history.
 *
 * ## What this is not
 *
 * It is not deduplication of *events*. Two honest attempts at delivering one
 * event carry two nonces and both verify; deciding that the second is a duplicate
 * is the idempotency layer's job, keyed on the event id — see
 * `@/idempotency` and `docs/webhook-signing.md`. Collapsing the two ends badly in
 * both directions: keyed on the event id, a receiver accepts a captured
 * credential whenever the event is new, and keyed on the nonce, it rejects an
 * honest retry.
 */

/** What `ReplayGuard.remember` decided about one presented nonce. */
export type ReplayDecision =
  /** Not seen inside the window; now recorded. */
  | 'accepted'
  /** Seen, and its record has not expired. */
  | 'replayed'
  /** Unexpired records already fill the cache; nothing was recorded. */
  | 'cache-full';

export interface ReplayGuard {
  /**
   * Record `key` if it is not already held, and say which of those happened.
   *
   * `expiresAtMs` is when the record may be forgotten, which callers derive from
   * the *signed* timestamp plus the tolerance rather than from arrival: a
   * delivery that spent four of its five permitted minutes in a sender's queue
   * has one minute left in which it could be replayed, and that is how long it
   * needs to be remembered. Deriving it from arrival instead would extend every
   * record past the point the window check still cares, which is a larger cache
   * for no additional guarantee.
   *
   * Async because the only implementation that is useful on more than one replica
   * is networked, and a port that has to change shape to accommodate its real
   * implementation is not a port. The cost on the in-memory path is one resolved
   * promise per delivery.
   */
  remember(key: string, expiresAtMs: number): Promise<ReplayDecision>;
}

/** Defaults are documented in `.env.example` against the env vars that set them. */
export const DEFAULT_REPLAY_CACHE_MAX_ENTRIES = 100_000;

export interface MemoryReplayGuardOptions {
  /** Hard ceiling on unexpired records. See `remember` for what happens at it. */
  maxEntries?: number;
  /** Injected so expiry is testable without waiting. */
  now?: () => number;
}

/**
 * In-process replay protection.
 *
 * Correct, bounded, and — stated as plainly as `MemoryIdempotencyStore` states
 * the same thing — **not sufficient behind more than one replica**. The map is
 * per-process, so with three instances behind a load balancer a captured
 * delivery gets three chances rather than one: each instance refuses the copy it
 * has already seen and accepts the copy its neighbour saw. That is a third of the
 * protection, not none, and it is not the protection the feature claims.
 *
 * Replay protection has to happen where the deliveries are serialised, which for
 * a horizontally scaled receiver means a shared store — `SET <key> 1 NX PX <ttl>`
 * against Redis is the whole implementation, and `ReplayGuard` is the seam it
 * plugs into. The Redis module in this repository is a Streams client and exposes
 * no key-value port, so that adapter is a change to `@/redis` rather than a class
 * here, and it is not in this item. What *is* here is the seam, a tested
 * implementation of the protocol that needs no infrastructure, and this
 * paragraph: a deployment that scales this endpoint past one replica and leaves
 * the default in place has a gap, and it should find that out from a comment
 * rather than from an incident.
 */
export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryReplayGuardOptions = {}) {
    const { maxEntries = DEFAULT_REPLAY_CACHE_MAX_ENTRIES, now = Date.now } = options;

    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError(`maxEntries must be a positive integer, got ${String(maxEntries)}`);
    }

    this.maxEntries = maxEntries;
    this.now = now;
  }

  remember(key: string, expiresAtMs: number): Promise<ReplayDecision> {
    const now = this.now();
    const held = this.seen.get(key);

    if (held !== undefined) {
      if (held > now) return Promise.resolve('replayed');
      // Held but expired. Deleting rather than falling through to the `set`
      // below, so the re-insert lands at the back of the map's iteration order
      // and the sweep's cost stays proportional to what is actually stale.
      this.seen.delete(key);
    }

    if (this.seen.size >= this.maxEntries) {
      this.sweep(now);
      if (this.seen.size >= this.maxEntries) return Promise.resolve('cache-full');
    }

    this.seen.set(key, expiresAtMs);
    return Promise.resolve('accepted');
  }

  /** Unexpired *and* expired-but-not-yet-swept records. For tests and sizing. */
  size(): number {
    return this.seen.size;
  }

  /**
   * Drop every expired record.
   *
   * Only ever called at capacity, which is what makes a full O(n) walk
   * affordable: it happens once per `maxEntries` insertions in the steady state,
   * not once per delivery, and there is no timer to leak into a test or to keep
   * a process alive during shutdown.
   *
   * It is a full walk and not an early exit on the first unexpired entry, which
   * would be the obvious optimisation if insertion order were expiry order. It
   * is not: `expiresAtMs` is derived from the *sender's* timestamp, so a delivery
   * that was queued for four minutes is inserted after, and expires before, one
   * signed a moment ago. An early exit would stop at that entry and leave the
   * stale records behind it in place, which at capacity means reporting
   * `cache-full` with a cache that is mostly garbage.
   */
  private sweep(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }
}
