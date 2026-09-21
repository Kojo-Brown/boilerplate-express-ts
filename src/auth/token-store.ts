import type {
  InspectableRefreshTokenStore,
  NewRefreshToken,
  RefreshTokenConsumption,
} from '@/auth/auth.types';

/**
 * In-memory refresh token store with rotation-chain bookkeeping. Replaced with
 * a DB-backed store by handing a different `RefreshTokenStore` to
 * `createAuthService` — no consumer of the service changes.
 *
 * The shape that matters is that a retired token is *kept*, not deleted. A
 * store that deletes on rotation answers "was this ever issued?" with "no" for
 * both a token it has already spent and a string somebody invented, and those
 * two are the entire difference between a theft in progress and a typo. So
 * every record stays until its own `exp`, carrying the state it reached and
 * the family it belongs to.
 *
 * The methods are `async` only to satisfy the interface; the work is
 * synchronous, and in `consume`'s case that is a property rather than an
 * accident — see the note there.
 */

type RefreshTokenState = 'active' | 'rotated' | 'revoked';

interface RefreshTokenRecord {
  userId: string;
  familyId: string;
  state: RefreshTokenState;
  expiresAt: number;
}

/**
 * How often `issue` is willing to sweep the whole map for expired records.
 *
 * Expiry is also checked lazily on the way past each record, but lazily only
 * reaches tokens somebody presents, and the records that pile up are precisely
 * the ones nobody ever comes back for — a client that logs out, or simply
 * stops. Left to lazy pruning alone those sit in the map for the full
 * `JWT_REFRESH_EXPIRES_IN` after their last use.
 *
 * Amortised onto `issue` rather than run from a timer, because a timer is a
 * handle: something has to start it at the composition root and stop it in the
 * `resources` phase of shutdown, or it holds the event loop open and the
 * process that should have exited cleanly gets `SIGKILL` instead. That is real
 * lifecycle surface to maintain, for a `Map` that dies with the process
 * anyway.
 */
const PRUNE_INTERVAL_MS = 60_000;

export function createInMemoryTokenStore(): InspectableRefreshTokenStore {
  const records = new Map<string, RefreshTokenRecord>(); // token → record
  let lastPrunedAt = Date.now();

  /** Expired records are treated as absent everywhere, and dropped on sight. */
  function live(token: string, now: number): RefreshTokenRecord | undefined {
    const record = records.get(token);
    if (!record) return undefined;
    if (record.expiresAt <= now) {
      records.delete(token);
      return undefined;
    }
    return record;
  }

  function prune(now: number = Date.now()): number {
    let dropped = 0;
    for (const [token, record] of records.entries()) {
      if (record.expiresAt <= now) {
        records.delete(token);
        dropped += 1;
      }
    }
    lastPrunedAt = now;
    return dropped;
  }

  return {
    async issue({ token, userId, familyId, expiresAt }: NewRefreshToken): Promise<void> {
      const now = Date.now();
      if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) prune(now);
      records.set(token, { userId, familyId, state: 'active', expiresAt });
    },

    /**
     * Read and state change in one synchronous run, with no `await` between
     * them. Under Node's single-threaded execution that is what makes two
     * concurrent refreshes of the same token resolve to exactly one `rotated`
     * and one `reuse` rather than two winners — the second call cannot begin
     * until the first has finished writing. The `async` is the interface's, not
     * this implementation's, and the absence of a suspension point inside is
     * the invariant a change here must preserve.
     */
    async consume(token: string): Promise<RefreshTokenConsumption> {
      const record = live(token, Date.now());
      if (!record) return { outcome: 'unknown' };

      const { userId, familyId } = record;

      if (record.state === 'rotated') return { outcome: 'reuse', userId, familyId };
      if (record.state === 'revoked') return { outcome: 'revoked', userId, familyId };

      record.state = 'rotated';
      return { outcome: 'rotated', userId, familyId };
    },

    async revoke(token: string): Promise<void> {
      const record = live(token, Date.now());
      if (record) record.state = 'revoked';
    },

    /**
     * Spent tokens are revoked too, not skipped.
     *
     * A family is killed because one of its tokens turned up in two pairs of
     * hands, and which member the attacker holds is exactly what is not known:
     * leaving the already-rotated ones as `rotated` would still report a later
     * presentation as `reuse` and re-fire the alarm for a family that is
     * already dead. `revoked` is the terminal state and every member reaches
     * it.
     */
    async revokeFamily(familyId: string): Promise<number> {
      const now = Date.now();
      let revoked = 0;
      for (const [token, record] of records.entries()) {
        if (record.familyId !== familyId) continue;
        if (record.expiresAt <= now) {
          records.delete(token);
          continue;
        }
        if (record.state !== 'revoked') {
          record.state = 'revoked';
          revoked += 1;
        }
      }
      return revoked;
    },

    async revokeAllForUser(userId: string): Promise<void> {
      const now = Date.now();
      for (const [token, record] of records.entries()) {
        if (record.userId !== userId) continue;
        if (record.expiresAt <= now) {
          records.delete(token);
          continue;
        }
        record.state = 'revoked';
      }
    },

    async isActive(token: string): Promise<boolean> {
      return live(token, Date.now())?.state === 'active';
    },

    size(): number {
      return records.size;
    },

    prune,
  };
}

/** Process-wide default instance, wired up in the composition root. */
export const tokenStore: InspectableRefreshTokenStore = createInMemoryTokenStore();
