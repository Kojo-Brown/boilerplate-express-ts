import { randomUUID } from 'crypto';
import type {
  ClaimRequest,
  ClaimResult,
  IdempotencyClaim,
  IdempotencyState,
  IdempotencyStore,
  RecordedResponse,
} from '@/idempotency/idempotency.types';

/**
 * Defaults shared with the Postgres store, so a suite that swaps one for the
 * other does not silently change the protocol's timing.
 */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LEASE_MS = 60_000;

export interface MemoryIdempotencyStoreOptions {
  /** How long a completed record stays replayable. */
  retentionMs?: number;
  /**
   * How long an unfinished claim blocks a retry before it is considered
   * abandoned. See `PostgresIdempotencyStore` for why this exists at all.
   */
  leaseMs?: number;
  /** Injected so expiry and takeover are testable without waiting. */
  now?: () => number;
}

interface StoredRecord {
  claimId: string;
  fingerprint: string;
  state: IdempotencyState;
  response: RecordedResponse | null;
  claimedAt: number;
  expiresAt: number;
}

/**
 * In-process implementation of the same protocol.
 *
 * Useful for tests and for a single-process development run, and useless in
 * production for a reason worth stating: the map is per-replica, so two
 * instances behind a load balancer each hold their own idea of which keys are
 * taken, and a retry that lands on the other one executes again. Deduplication
 * has to happen where the writes are serialised, which is the database — this
 * class exists to make the *protocol* testable without one, not to be an
 * alternative to it.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly retentionMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    const {
      retentionMs = DEFAULT_RETENTION_MS,
      leaseMs = DEFAULT_LEASE_MS,
      now = Date.now,
    } = options;

    assertPositive('retentionMs', retentionMs);
    assertPositive('leaseMs', leaseMs);

    this.retentionMs = retentionMs;
    this.leaseMs = leaseMs;
    this.now = now;
  }

  /** Live records, expired ones excluded. Reads as documentation in tests. */
  get size(): number {
    const now = this.now();
    let live = 0;
    for (const record of this.records.values()) {
      if (record.expiresAt > now) live += 1;
    }
    return live;
  }

  claim(request: ClaimRequest): Promise<ClaimResult> {
    const { scope, key, fingerprint } = request;
    const id = recordKey(scope, key);
    const now = this.now();
    const existing = this.records.get(id);

    // Same order the Postgres store evaluates in, and the order matters: a
    // dead record is taken over whatever its fingerprint says, because it is
    // no longer anybody's response to conflict with.
    if (existing === undefined || this.isDead(existing, now)) {
      const claimId = randomUUID();
      this.records.set(id, {
        claimId,
        fingerprint,
        state: 'in_progress',
        response: null,
        claimedAt: now,
        expiresAt: now + this.retentionMs,
      });
      return Promise.resolve({ outcome: 'claimed', claim: { scope, key, claimId } });
    }

    if (existing.fingerprint !== fingerprint) {
      return Promise.resolve({ outcome: 'mismatch' });
    }

    if (existing.state === 'completed' && existing.response !== null) {
      return Promise.resolve({ outcome: 'replay', response: existing.response });
    }

    return Promise.resolve({ outcome: 'in_progress' });
  }

  complete(claim: IdempotencyClaim, response: RecordedResponse): Promise<boolean> {
    const record = this.ownedRecord(claim);
    if (record === undefined) return Promise.resolve(false);

    record.state = 'completed';
    record.response = response;
    // The retention window starts when the response exists, not when the claim
    // was taken: a slow request would otherwise be replayable for less time
    // than a fast one for no reason a client could predict.
    record.expiresAt = this.now() + this.retentionMs;
    return Promise.resolve(true);
  }

  release(claim: IdempotencyClaim): Promise<boolean> {
    const record = this.ownedRecord(claim);
    if (record === undefined) return Promise.resolve(false);

    this.records.delete(recordKey(claim.scope, claim.key));
    return Promise.resolve(true);
  }

  purgeExpired(): Promise<number> {
    const now = this.now();
    let purged = 0;
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
        purged += 1;
      }
    }
    return Promise.resolve(purged);
  }

  /** Drops every record. For test setup, mirroring `MemoryCacheStore.clear`. */
  clear(): Promise<void> {
    this.records.clear();
    return Promise.resolve();
  }

  /**
   * Past retention, or an in-progress claim past its lease. Either way the
   * record no longer speaks for a request anyone is waiting on.
   */
  private isDead(record: StoredRecord, now: number): boolean {
    if (record.expiresAt <= now) return true;
    return record.state === 'in_progress' && record.claimedAt + this.leaseMs <= now;
  }

  /**
   * The record this claim still owns, if any.
   *
   * The `claimId` check is the whole point: a request whose claim was taken
   * over as stale must not complete or release the key its successor now
   * holds.
   */
  private ownedRecord(claim: IdempotencyClaim): StoredRecord | undefined {
    const record = this.records.get(recordKey(claim.scope, claim.key));
    if (record === undefined) return undefined;
    if (record.claimId !== claim.claimId) return undefined;
    if (record.state !== 'in_progress') return undefined;
    return record;
  }
}

/**
 * Length-prefixed, not joined by a separator.
 *
 * Both halves are caller-influenced strings, so any character used as a
 * separator can also appear inside them: with `${scope}:${key}`, the pair
 * `("a:b", "c")` and the pair `("a", "b:c")` are one map entry, and one of the
 * two ends up reading a response recorded under a scope that is not theirs.
 * Prefixing the scope's length makes the split unambiguous for every input.
 * The Postgres store has no equivalent hazard: its primary key is two columns,
 * not a concatenation of them.
 */
function recordKey(scope: string, key: string): string {
  return `${scope.length}:${scope}${key}`;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `MemoryIdempotencyStore: ${name} must be a finite positive number, received ${value}`,
    );
  }
}
