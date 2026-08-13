import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The dedupe table behind `Idempotency-Key`.
 *
 * The primary key is doing the real work: `(scope, key)` is the only thing
 * making "has this request run before?" a decision Postgres arbitrates rather
 * than one the application races over. A `SELECT` followed by an `INSERT` looks
 * equivalent and is not — two concurrent retries both read nothing and both
 * proceed, which is precisely the double-submit this table exists to stop.
 *
 * `scope` rather than a bare key: a key is a client-generated string, so
 * `key`-only uniqueness lets one tenant's chosen value collide with another's,
 * and a collision here replays *someone else's response body*. The scope is
 * built from the principal and the route (see `scopeFor`), so keys are only
 * ever compared within one caller's own namespace.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.createTable(
    'idempotency_keys',
    {
      scope: { type: 'text', notNull: true },
      key: { type: 'text', notNull: true },
      /**
       * Fences a completed write against the claim it belongs to. A request
       * whose claim was taken over as stale must not later overwrite the
       * record with its own late response — the retry that took it over owns
       * the key now, and `claim_id` is what makes that check possible.
       */
      claim_id: { type: 'uuid', notNull: true },
      /** SHA-256 over the canonical request body. See `requestFingerprint`. */
      fingerprint: { type: 'text', notNull: true },
      state: { type: 'text', notNull: true },
      response_status: { type: 'integer' },
      response_body: { type: 'jsonb' },
      /**
       * A JSON `null` body and no body at all are both `NULL` in a `jsonb`
       * column, and they replay differently — one is `204 No Content`, the
       * other a 200 whose body is the four bytes `null`. This column is the
       * difference.
       */
      has_response_body: { type: 'boolean', notNull: true, default: false },
      claimed_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
      completed_at: { type: 'timestamptz' },
      /**
       * Retention, not a lock lease. The row has to outlive the request by as
       * long as a client might reasonably retry — a day, by default — because
       * a record deleted an hour after the write turns the retry it was meant
       * to absorb back into a second execution.
       */
      expires_at: { type: 'timestamptz', notNull: true },
    },
    {
      constraints: {
        primaryKey: ['scope', 'key'],
      },
    },
  );

  pgm.addConstraint('idempotency_keys', 'idempotency_keys_state_check', {
    check: "state IN ('in_progress', 'completed')",
  });

  // A completed record without a status is not replayable, and an in-progress
  // one carrying a status means a response was recorded under a claim that
  // never finished. Both are unreachable through the store; the constraint is
  // what keeps them unreachable through psql as well.
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_completed_has_status', {
    check: "(state = 'completed') = (response_status IS NOT NULL)",
  });

  pgm.addConstraint('idempotency_keys', 'idempotency_keys_body_presence', {
    check: 'has_response_body OR response_body IS NULL',
  });

  // Purging is a range scan over expired rows; without this it is a sequential
  // scan of the whole table on every sweep.
  pgm.createIndex('idempotency_keys', 'expires_at');
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('idempotency_keys');
}
