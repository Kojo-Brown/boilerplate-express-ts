/**
 * Where issued magic links live between the email going out and the link being
 * clicked.
 *
 * Only the *digest* of a token ever reaches this interface — see
 * `secret-hash.ts`. An implementation therefore cannot leak a working link,
 * and does not need to be trusted with one.
 *
 * Async because the Phase 3 DB-backed store will be, for the same reason
 * `RefreshTokenStore` is: a sync signature here would make the interface
 * unimplementable by the thing it exists to allow.
 */
export interface MagicLinkStore {
  /**
   * Records a freshly issued link for `email`.
   *
   * Issuing invalidates every link previously outstanding for that address. A
   * user who clicks "email me a link" twice because the first was slow should
   * not be left with two live credentials, and the second request is the one
   * they are looking at.
   */
  issue(tokenHash: string, email: string): Promise<void>;

  /**
   * Redeems a link, returning the address it was issued to, or `null` if the
   * digest is unknown, already redeemed, or past its expiry.
   *
   * Single-use: a successful consume removes the record before returning, so a
   * replayed link — from a browser prefetch, a mail-scanner following the URL,
   * or an attacker with the user's inbox archive — authenticates nobody.
   */
  consume(tokenHash: string): Promise<string | null>;
}

export interface InspectableMagicLinkStore extends MagicLinkStore {
  /** Outstanding, not-yet-expired links. For tests and diagnostics. */
  readonly size: number;
  /** Drops every outstanding link. */
  clear(): void;
}

export interface MagicLinkStoreOptions {
  /**
   * Injected clock, in epoch milliseconds. Expiry is the only time-dependent
   * behaviour here, and a test that had to sleep through a 15-minute TTL would
   * be the slowest thing in the suite by four orders of magnitude.
   */
  now?: () => number;
  /** Lifetime of an issued link, in seconds. */
  ttlSeconds: number;
}

interface MagicLinkRecord {
  email: string;
  expiresAt: number;
}

/**
 * In-memory magic-link store, replaced by a DB-backed one in Phase 3 by handing
 * a different `MagicLinkStore` to `createAuthStrategyRegistry`.
 *
 * Expired records are dropped lazily, on the next `issue` for the same address
 * or on the `consume` that finds them stale, rather than by a sweep timer. A
 * `setInterval` here would keep the process alive in tests and would be the
 * kind of thing a DB-backed implementation deletes anyway, since Postgres can
 * express the same thing as a `WHERE expires_at > now()`.
 */
export function createInMemoryMagicLinkStore(
  options: MagicLinkStoreOptions,
): InspectableMagicLinkStore {
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlSeconds * 1000;

  const byHash = new Map<string, MagicLinkRecord>();

  function forget(email: string): void {
    for (const [hash, record] of byHash.entries()) {
      if (record.email === email) byHash.delete(hash);
    }
  }

  return {
    issue(tokenHash: string, email: string): Promise<void> {
      forget(email);
      byHash.set(tokenHash, { email, expiresAt: now() + ttlMs });
      return Promise.resolve();
    },

    consume(tokenHash: string): Promise<string | null> {
      const record = byHash.get(tokenHash);
      if (record === undefined) return Promise.resolve(null);

      // Deleted either way: a redeemed link and an expired one are both spent.
      byHash.delete(tokenHash);

      if (now() >= record.expiresAt) return Promise.resolve(null);

      return Promise.resolve(record.email);
    },

    get size(): number {
      return byHash.size;
    },

    clear(): void {
      byHash.clear();
    },
  };
}
