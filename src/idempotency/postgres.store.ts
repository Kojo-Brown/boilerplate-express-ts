import { randomUUID } from 'crypto';
import type { QueryResultRow } from 'pg';
import { poolQueryable, queryOne } from '@/db/query';
import type { Queryable } from '@/db/queryable';
import { IdempotencyStoreContentionError } from '@/idempotency/idempotency.errors';
import type {
  ClaimRequest,
  ClaimResult,
  IdempotencyClaim,
  IdempotencyState,
  IdempotencyStore,
  RecordedResponse,
} from '@/idempotency/idempotency.types';
import { DEFAULT_LEASE_MS, DEFAULT_RETENTION_MS } from '@/idempotency/memory.store';

/**
 * How many times `claim` re-reads before giving up.
 *
 * Each iteration is a lost race with another request — the row was purged
 * between our insert and our read, or a competing retry took over the stale
 * claim first. Both are self-resolving, and neither can repeat indefinitely
 * without a second party repeating the same work, so a small bound is enough to
 * distinguish "contended" from "spinning".
 */
const CLAIM_ATTEMPTS = 3;

export interface PostgresIdempotencyStoreOptions {
  /** How long a completed record stays replayable. Default 24h. */
  retentionMs?: number;
  /**
   * How long an unfinished claim blocks a retry before a later request may
   * take it over. Default 60s.
   *
   * This is the one number here with a genuinely unpleasant trade-off behind
   * it. A process that dies between committing its work and recording its
   * response leaves the key claimed forever; without a lease, every retry of
   * that request answers 409 until the retention window ends — a day, by
   * default — and a client can neither retry nor learn what happened. With a
   * lease, the retry re-executes, which for a claim that was merely *slow*
   * rather than dead means the work happens twice. The lease is therefore an
   * upper bound on how long a request may legitimately take, and should stay
   * comfortably above the slowest route it guards (the operations here run
   * under a 2s timeout).
   */
  leaseMs?: number;
}

/**
 * The rows we read back. Only the columns the protocol needs — `claimed_at`
 * and `completed_at` exist for operators, not for this code, and the two
 * booleans are computed by Postgres so every time comparison happens against
 * one clock rather than against whatever the application server thinks the
 * time is.
 */
interface IdempotencyReadRow extends QueryResultRow {
  claim_id: string;
  fingerprint: string;
  state: IdempotencyState;
  response_status: number | null;
  response_body: unknown;
  has_response_body: boolean;
  expired: boolean;
  stale: boolean;
}

interface ClaimIdRow extends QueryResultRow {
  claim_id: string;
}

const CLAIM_SQL = `
  INSERT INTO "idempotency_keys"
    ("scope", "key", "claim_id", "fingerprint", "state", "claimed_at", "expires_at")
  VALUES ($1, $2, $3, $4, 'in_progress', now(), now() + make_interval(secs => $5::double precision))
  ON CONFLICT ("scope", "key") DO NOTHING
  RETURNING "claim_id"
`;

const READ_SQL = `
  SELECT
    "claim_id",
    "fingerprint",
    "state",
    "response_status",
    "response_body",
    "has_response_body",
    ("expires_at" <= now()) AS "expired",
    (
      "state" = 'in_progress'
      AND "claimed_at" + make_interval(secs => $3::double precision) <= now()
    ) AS "stale"
  FROM "idempotency_keys"
  WHERE "scope" = $1 AND "key" = $2
`;

const TAKEOVER_SQL = `
  UPDATE "idempotency_keys" SET
    "claim_id" = $3,
    "fingerprint" = $4,
    "state" = 'in_progress',
    "response_status" = NULL,
    "response_body" = NULL,
    "has_response_body" = false,
    "claimed_at" = now(),
    "completed_at" = NULL,
    "expires_at" = now() + make_interval(secs => $5::double precision)
  WHERE "scope" = $1
    AND "key" = $2
    AND (
      "expires_at" <= now()
      OR (
        "state" = 'in_progress'
        AND "claimed_at" + make_interval(secs => $6::double precision) <= now()
      )
    )
  RETURNING "claim_id"
`;

const COMPLETE_SQL = `
  UPDATE "idempotency_keys" SET
    "state" = 'completed',
    "response_status" = $4,
    "response_body" = $5::jsonb,
    "has_response_body" = $6,
    "completed_at" = now(),
    "expires_at" = now() + make_interval(secs => $7::double precision)
  WHERE "scope" = $1 AND "key" = $2 AND "claim_id" = $3 AND "state" = 'in_progress'
  RETURNING "claim_id"
`;

const RELEASE_SQL = `
  DELETE FROM "idempotency_keys"
  WHERE "scope" = $1 AND "key" = $2 AND "claim_id" = $3 AND "state" = 'in_progress'
  RETURNING "claim_id"
`;

const PURGE_SQL = `
  WITH "deleted" AS (
    DELETE FROM "idempotency_keys" WHERE "expires_at" <= now() RETURNING 1
  )
  SELECT COUNT(*) AS count FROM "deleted"
`;

/**
 * The production store: claims arbitrated by the `(scope, key)` primary key.
 *
 * It does not extend `BaseRepository`, and that is deliberate rather than an
 * oversight. Every method the base class offers is keyed by an `id` column this
 * table does not have, and — more to the point — each is a plain read or a
 * plain write. The protocol here has neither: `claim` is an insert whose
 * *conflict* is the interesting outcome, and `complete` and `release` are
 * writes conditioned on still owning the row. Expressed with `findOne` +
 * `update`, each one becomes a read-then-write with a window in the middle, and
 * that window is exactly the double-submit the table exists to close.
 *
 * Every statement below is therefore a single atomic one, and every timestamp
 * comparison is evaluated by Postgres. Reading `now()` in Node and passing it
 * down would put the correctness of a lease on the assumption that every
 * application server's clock agrees with the database's.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly retentionSeconds: number;
  private readonly leaseSeconds: number;

  constructor(options: PostgresIdempotencyStoreOptions = {}) {
    const { retentionMs = DEFAULT_RETENTION_MS, leaseMs = DEFAULT_LEASE_MS } = options;

    assertPositive('retentionMs', retentionMs);
    assertPositive('leaseMs', leaseMs);

    this.retentionSeconds = retentionMs / 1000;
    this.leaseSeconds = leaseMs / 1000;
  }

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    const { scope, key, fingerprint } = request;

    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
      const claimId = randomUUID();

      // The happy path is one round trip. `ON CONFLICT DO NOTHING` returns no
      // row when a record already exists, which is the only signal needed to
      // know a first request got here first — and, unlike a preceding
      // `SELECT`, it cannot be true for two callers at once.
      const inserted = await queryOne<ClaimIdRow>(CLAIM_SQL, [
        scope,
        key,
        claimId,
        fingerprint,
        this.retentionSeconds,
      ]);
      if (inserted !== null) {
        return { outcome: 'claimed', claim: { scope, key, claimId } };
      }

      const existing = await queryOne<IdempotencyReadRow>(READ_SQL, [scope, key, this.leaseSeconds]);
      // Gone between the two statements: purged, or released by the request
      // that held it. Nobody owns the key now, so try to take it again.
      if (existing === null) continue;

      if (existing.expired || existing.stale) {
        const takenOver = await queryOne<ClaimIdRow>(TAKEOVER_SQL, [
          scope,
          key,
          claimId,
          fingerprint,
          this.retentionSeconds,
          this.leaseSeconds,
        ]);
        if (takenOver !== null) {
          return { outcome: 'claimed', claim: { scope, key, claimId } };
        }
        // Another retry took over first, or the original finished while we
        // were reading. Either way the record we read is stale in a second
        // sense; re-read rather than guess.
        continue;
      }

      // Checked only against a *live* record. A dead one is taken over above
      // whatever its fingerprint says, because it is no longer a response
      // anybody can conflict with.
      if (existing.fingerprint !== fingerprint) {
        return { outcome: 'mismatch' };
      }

      if (existing.state === 'completed' && existing.response_status !== null) {
        return {
          outcome: 'replay',
          response: toRecordedResponse(existing.response_status, existing),
        };
      }

      return { outcome: 'in_progress' };
    }

    throw new IdempotencyStoreContentionError(CLAIM_ATTEMPTS);
  }

  async complete(claim: IdempotencyClaim, response: RecordedResponse): Promise<boolean> {
    const stored = await queryOne<ClaimIdRow>(COMPLETE_SQL, [
      claim.scope,
      claim.key,
      claim.claimId,
      response.status,
      // `undefined` would be sent as SQL NULL anyway; going through the flag
      // rather than the value is what keeps a recorded JSON `null` from
      // becoming an empty body on replay.
      response.hasBody ? JSON.stringify(response.body ?? null) : null,
      response.hasBody,
      this.retentionSeconds,
    ]);
    return stored !== null;
  }

  async release(claim: IdempotencyClaim): Promise<boolean> {
    const released = await queryOne<ClaimIdRow>(RELEASE_SQL, [
      claim.scope,
      claim.key,
      claim.claimId,
    ]);
    return released !== null;
  }

  async purgeExpired(executor: Queryable = poolQueryable): Promise<number> {
    return executor.queryCount(PURGE_SQL);
  }
}

/**
 * `has_response_body` decides whether there is a body, never the value.
 *
 * `response_body` is `null` for both "no body" and "the JSON value null", and
 * those replay as `204` and as a 200 carrying `null` respectively.
 */
function toRecordedResponse(
  status: number,
  row: Pick<IdempotencyReadRow, 'response_body' | 'has_response_body'>,
): RecordedResponse {
  return row.has_response_body
    ? { status, hasBody: true, body: row.response_body }
    : { status, hasBody: false };
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `PostgresIdempotencyStore: ${name} must be a finite positive number, received ${value}`,
    );
  }
}
