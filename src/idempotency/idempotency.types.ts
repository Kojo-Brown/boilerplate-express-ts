import type { Queryable } from '@/db/queryable';

/**
 * The two states a key can be in. `in_progress` is a claim: someone is running
 * the request right now. `completed` is a recorded response waiting to be
 * replayed.
 */
export const IDEMPOTENCY_STATES = ['in_progress', 'completed'] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];

/**
 * What a replay puts back on the wire.
 *
 * `body` is optional and `hasBody` is not derived from it: `{ hasBody: true,
 * body: null }` replays a JSON `null`, `{ hasBody: false }` replays no body at
 * all. Collapsing the two would turn every `204 No Content` into a 200 with the
 * literal bytes `null` the second time a client retried it.
 */
export interface RecordedResponse {
  status: number;
  hasBody: boolean;
  body?: unknown;
}

/**
 * Proof that this request owns the key, and the only thing `complete` and
 * `release` accept.
 *
 * `claimId` is the fence. A request whose claim expired and was taken over by a
 * retry still holds a `claimId`, and every write is conditioned on it, so the
 * late arrival's response is dropped instead of overwriting the response the
 * current owner is about to record.
 */
export interface IdempotencyClaim {
  readonly scope: string;
  readonly key: string;
  readonly claimId: string;
}

export interface ClaimRequest {
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
}

/**
 * The four things that can be true of a key when a request presents it.
 *
 * A discriminated union rather than a nullable record, because the caller's
 * four responses have nothing in common: run the handler, replay a stored
 * response, answer 409, answer 422. A store returning `IdempotencyRecord | null`
 * would push that decision — the whole protocol — into every caller.
 */
export type ClaimResult =
  /** The key is ours: no prior record, or a dead one we took over. */
  | { readonly outcome: 'claimed'; readonly claim: IdempotencyClaim }
  /** A completed response is on file for exactly this request. */
  | { readonly outcome: 'replay'; readonly response: RecordedResponse }
  /** Another request holds a live claim on this key. */
  | { readonly outcome: 'in_progress' }
  /** The key is live but was first used for a *different* request body. */
  | { readonly outcome: 'mismatch' };

/**
 * Where claims live.
 *
 * An interface, not a class, for the same reason `CacheStore` is one: the
 * Postgres implementation is the right default and the wrong dependency for a
 * unit test. It is deliberately narrow — four methods, no reads that are not
 * part of the protocol — because every one of them has to be implementable as a
 * single atomic statement. Anything requiring a read-then-write round trip in
 * the caller would reintroduce the race the table exists to remove.
 */
export interface IdempotencyStore {
  /**
   * Atomically take the key, or report who already has it.
   *
   * Must be safe under concurrency: of N simultaneous calls for one key,
   * exactly one may come back `claimed`.
   */
  claim(request: ClaimRequest): Promise<ClaimResult>;

  /**
   * Record the response and mark the key replayable.
   *
   * Resolves `false` when the claim no longer owns the key — it was taken over
   * as stale, or already released. The caller has nowhere to put the response
   * in that case, and the honest thing is to say so rather than to write it
   * over the current owner's record.
   */
  complete(claim: IdempotencyClaim, response: RecordedResponse): Promise<boolean>;

  /**
   * Give the key back, unused. Resolves `false` if the claim had already lost
   * it.
   *
   * This is what a 5xx does. Leaving the record in place would answer 409 for
   * the rest of the retention window on a request that produced no response to
   * replay — locking the client out of the retry the failure was asking for.
   */
  release(claim: IdempotencyClaim): Promise<boolean>;

  /**
   * Drop records past their retention window; resolves the number removed.
   *
   * Records are not read after `expires_at` — `claim` treats an expired row as
   * absent — so this is housekeeping for the table's size, not for
   * correctness, and is meant to be run on a schedule rather than per request.
   *
   * Takes the optional executor every database-backed method in this codebase
   * takes, for the reason `Queryable` gives: the scheduled caller runs this
   * under an advisory lock held by an open transaction, and a statement sent to
   * the pool instead would land on a different connection — outside that
   * transaction, and therefore outside the lock that was supposed to be
   * guarding it. Stores that are not backed by the database ignore it.
   */
  purgeExpired(executor?: Queryable): Promise<number>;
}
