import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { TransactionClient } from '@/db/transaction';
import type { EventPayloadMap } from '@/events/event-bus';
import type {
  EnqueueOptions,
  JsonSafe,
  OutboxMessage,
  OutboxStore,
} from '@/outbox/outbox.types';

export const OUTBOX_TABLE = 'outbox_messages';

/** The row shape `claimDue` selects. */
interface OutboxRow extends QueryResultRow {
  id: string;
  event_name: string;
  payload: unknown;
  correlation_id: string | null;
  occurred_at: Date;
  attempts: number;
}

/**
 * `outbox_messages`, as the enqueuing request and the relay each see it.
 *
 * Every method takes a `TransactionClient` rather than the optional `Queryable`
 * the repositories take, and that is the difference between this and a table
 * with an interface in front of it. Both halves of the protocol are meaningless
 * outside a transaction: an `enqueue` on the pool commits independently of the
 * write it describes, and a claim on the pool takes its row locks and drops
 * them at the end of the statement — the same silent no-op `SELECT ... FOR
 * UPDATE` produces there, which is what the brand was introduced to make
 * impossible.
 */
export class PostgresOutboxStore<TEvents extends EventPayloadMap>
  implements OutboxStore<TEvents>
{
  constructor(private readonly newId: () => string = randomUUID) {}

  async enqueue<K extends keyof TEvents & string>(
    tx: TransactionClient,
    name: K,
    payload: TEvents[K] & JsonSafe<TEvents[K]>,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const id = options.id ?? this.newId();

    await tx.query(
      `INSERT INTO ${OUTBOX_TABLE} (id, event_name, payload, correlation_id)
       VALUES ($1, $2, $3::jsonb, $4)`,
      // `JSON.stringify` rather than handing the object to the driver: node-pg
      // renders a JavaScript *array* as a Postgres array literal (`{a,b}`),
      // which is not JSON and fails the `::jsonb` cast. A payload is an object
      // today, so nothing would have caught that until the first event whose
      // payload was a list.
      [id, name, JSON.stringify(payload), options.correlationId ?? null],
    );

    return id;
  }

  async claimDue(tx: TransactionClient, limit: number): Promise<OutboxMessage[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(
        `claimDue: limit must be an integer >= 1, received ${String(limit)}`,
      );
    }

    // `now()` and not a timestamp from the application. Every replica compares
    // `available_at` against the *database's* clock, so a relay whose host has
    // drifted by a minute cannot claim a message a minute early, and a backoff
    // written by one replica means the same instant to all of them.
    //
    // `FOR UPDATE SKIP LOCKED` is the whole concurrency story: relays claim
    // disjoint sets and never wait for each other, which is why this scales
    // with replicas where the purge job's advisory lock deliberately does not.
    // The two are the same question answered differently — a sweep wants
    // exactly one winner, a queue wants every worker busy.
    const rows = await tx.query<OutboxRow>(
      `SELECT id, event_name, payload, correlation_id, occurred_at, attempts
         FROM ${OUTBOX_TABLE}
        WHERE status = 'pending'
          AND available_at <= now()
        ORDER BY available_at, seq
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    return rows.map(toMessage);
  }

  async remove(tx: TransactionClient, id: string): Promise<void> {
    await tx.query(`DELETE FROM ${OUTBOX_TABLE} WHERE id = $1`, [id]);
  }

  async reschedule(
    tx: TransactionClient,
    id: string,
    delayMs: number,
    reason: string,
  ): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError(
        `reschedule: delayMs must be a non-negative number, received ${String(delayMs)}`,
      );
    }

    // The interval is computed from the server's `now()` for the same reason
    // the claim compares against it: two clocks would make "one second from
    // now" mean something different depending on which replica failed.
    await tx.query(
      `UPDATE ${OUTBOX_TABLE}
          SET attempts = attempts + 1,
              available_at = now() + ($2::double precision * interval '1 millisecond'),
              last_error = $3
        WHERE id = $1`,
      [id, delayMs, reason],
    );
  }

  async deadLetter(tx: TransactionClient, id: string, reason: string): Promise<void> {
    await tx.query(
      `UPDATE ${OUTBOX_TABLE}
          SET attempts = attempts + 1,
              status = 'dead',
              last_error = $2
        WHERE id = $1`,
      [id, reason],
    );
  }
}

function toMessage(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    name: row.event_name,
    payload: row.payload,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
  };
}
