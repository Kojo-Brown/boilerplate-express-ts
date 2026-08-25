import { IN_TRANSACTION } from '@/db/queryable';
import type { TransactionClient } from '@/db/transaction';
import type { DomainEventPayloads } from '@/events/domain-events';
import { OUTBOX_TABLE, PostgresOutboxStore } from '@/outbox/outbox.store';
import type { JsonSafe, OutboxStore } from '@/outbox/outbox.types';

const query = jest.fn();

/**
 * A transaction client, for the purposes of this suite: the brand plus a
 * recording `query`.
 *
 * Forging the brand is the point of it being an exported symbol — see
 * `IN_TRANSACTION`. A test is exactly the caller that has a connection this
 * module did not hand out.
 */
function fakeTx(): TransactionClient {
  return {
    [IN_TRANSACTION]: true,
    query: (...args: unknown[]) => query(...args),
    queryOne: () => {
      throw new Error('outbox store used queryOne');
    },
    queryCount: () => {
      throw new Error('outbox store used queryCount');
    },
  } as unknown as TransactionClient;
}

function lastSql(): string {
  const call = query.mock.calls.at(-1);
  return String(call?.[0]).replace(/\s+/g, ' ').trim();
}

function lastParams(): unknown[] {
  const call = query.mock.calls.at(-1);
  return call?.[1] as unknown[];
}

function newStore(): OutboxStore<DomainEventPayloads> {
  return new PostgresOutboxStore<DomainEventPayloads>(() => 'generated-message-id');
}

const CREATED_PAYLOAD: DomainEventPayloads['user.created'] = {
  userId: 'user-uuid-1',
  email: 'alice@example.com',
  roles: ['user'],
  actorId: 'admin-uuid',
};

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue([]);
});

describe('enqueue', () => {
  it('writes the event on the caller’s transaction and returns the message id', async () => {
    const id = await newStore().enqueue(fakeTx(), 'user.created', CREATED_PAYLOAD, {
      correlationId: 'correlation-abc',
    });

    expect(id).toBe('generated-message-id');
    expect(lastSql()).toBe(
      `INSERT INTO ${OUTBOX_TABLE} (id, event_name, payload, correlation_id) ` +
        'VALUES ($1, $2, $3::jsonb, $4)',
    );
    expect(lastParams()).toEqual([
      'generated-message-id',
      'user.created',
      JSON.stringify(CREATED_PAYLOAD),
      'correlation-abc',
    ]);
  });

  it('serialises the payload itself rather than handing the object to the driver', async () => {
    // node-pg renders a JavaScript array as a Postgres array literal (`{a,b}`),
    // which is not JSON and does not survive the `::jsonb` cast. The payload
    // reaching the driver has to already be a string.
    await newStore().enqueue(fakeTx(), 'user.created', CREATED_PAYLOAD);

    const payloadParam = lastParams()[2];
    expect(typeof payloadParam).toBe('string');
    expect(JSON.parse(String(payloadParam))).toEqual(CREATED_PAYLOAD);
  });

  it('stores a null correlation id when the event was published outside a request', async () => {
    await newStore().enqueue(fakeTx(), 'user.deleted', {
      userId: 'user-uuid-2',
      actorId: null,
    });

    expect(lastParams()[3]).toBeNull();
  });

  it('accepts a caller-supplied id so a request can log what it enqueued', async () => {
    const id = await newStore().enqueue(fakeTx(), 'user.deleted', {
      userId: 'user-uuid-2',
      actorId: null,
    }, { id: 'pinned-id' });

    expect(id).toBe('pinned-id');
    expect(lastParams()[0]).toBe('pinned-id');
  });
});

describe('claimDue', () => {
  it('claims due pending rows with FOR UPDATE SKIP LOCKED, oldest first', async () => {
    await newStore().claimDue(fakeTx(), 20);

    const sql = lastSql();
    // Each clause is load-bearing and each has a distinct failure: without
    // `SKIP LOCKED` a second relay blocks on the first instead of taking other
    // rows; without `available_at <= now()` the backoff ladder does nothing;
    // without `status = 'pending'` dead letters are redelivered forever.
    expect(sql).toContain("WHERE status = 'pending'");
    expect(sql).toContain('AND available_at <= now()');
    expect(sql).toContain('ORDER BY available_at, seq');
    expect(sql).toContain('LIMIT $1');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(lastParams()).toEqual([20]);
  });

  it('compares against the database clock, never the application’s', async () => {
    await newStore().claimDue(fakeTx(), 5);

    // A timestamp computed here would be one clock per replica: a host drifting
    // a minute fast would claim messages a minute before their backoff was up.
    expect(lastSql()).not.toMatch(/\$\d+::timestamptz/);
    expect(lastParams()).toEqual([5]);
  });

  it('maps rows into messages, carrying the id a consumer deduplicates on', async () => {
    const occurredAt = new Date('2026-08-25T10:00:00Z');
    query.mockResolvedValue([
      {
        id: 'message-uuid',
        event_name: 'user.created',
        payload: CREATED_PAYLOAD,
        correlation_id: 'correlation-abc',
        occurred_at: occurredAt,
        attempts: 2,
      },
    ]);

    await expect(newStore().claimDue(fakeTx(), 20)).resolves.toEqual([
      {
        id: 'message-uuid',
        name: 'user.created',
        payload: CREATED_PAYLOAD,
        correlationId: 'correlation-abc',
        occurredAt,
        attempts: 2,
      },
    ]);
  });

  it('rejects a limit that is not a positive integer', async () => {
    await expect(newStore().claimDue(fakeTx(), 0)).rejects.toThrow(RangeError);
    await expect(newStore().claimDue(fakeTx(), 2.5)).rejects.toThrow(RangeError);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('remove', () => {
  it('deletes the delivered row rather than marking it', async () => {
    await newStore().remove(fakeTx(), 'message-uuid');

    // A `published` status would turn a queue into an unbounded log and need a
    // second janitor to keep it from growing — the defect PR #33 found in
    // `idempotency_keys`. Nothing ever reads a delivered outbox row.
    expect(lastSql()).toBe(`DELETE FROM ${OUTBOX_TABLE} WHERE id = $1`);
    expect(lastParams()).toEqual(['message-uuid']);
  });
});

describe('reschedule', () => {
  it('bumps the attempt count and pushes availability out by the delay', async () => {
    await newStore().reschedule(fakeTx(), 'message-uuid', 1_500, 'Error: sink unreachable');

    const sql = lastSql();
    expect(sql).toContain('attempts = attempts + 1');
    expect(sql).toContain(
      "available_at = now() + ($2::double precision * interval '1 millisecond')",
    );
    expect(sql).toContain('last_error = $3');
    expect(lastParams()).toEqual(['message-uuid', 1_500, 'Error: sink unreachable']);
  });

  it('leaves the row claimable — a rescheduled message is still pending', async () => {
    await newStore().reschedule(fakeTx(), 'message-uuid', 100, 'boom');

    expect(lastSql()).not.toContain('status =');
  });

  it('rejects a negative or non-finite delay', async () => {
    await expect(
      newStore().reschedule(fakeTx(), 'message-uuid', -1, 'boom'),
    ).rejects.toThrow(RangeError);
    await expect(
      newStore().reschedule(fakeTx(), 'message-uuid', Number.NaN, 'boom'),
    ).rejects.toThrow(RangeError);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('deadLetter', () => {
  it('parks the row with the reason that stopped it', async () => {
    await newStore().deadLetter(fakeTx(), 'message-uuid', 'Error: still unreachable');

    const sql = lastSql();
    expect(sql).toContain("status = 'dead'");
    expect(sql).toContain('attempts = attempts + 1');
    expect(lastParams()).toEqual(['message-uuid', 'Error: still unreachable']);
  });
});

describe('the payload type', () => {
  it('rejects a value that cannot survive jsonb', () => {
    type Events = {
      'scheduled.at': { when: Date };
      'tagged.with': { tags: Set<string> };
      'plain.fact': { id: string; count: number; extra: null };
    };

    const store = new PostgresOutboxStore<Events>();
    const tx = fakeTx();

    // A `Date` goes in as an ISO string and comes back a string, so a
    // subscriber's `when.getTime()` is a TypeError in the relay rather than at
    // the enqueue that caused it. `JsonSafe` resolves the property to `never`.
    // @ts-expect-error Date does not round-trip through jsonb
    void store.enqueue(tx, 'scheduled.at', { when: new Date() });

    // A Set is worse than a Date: it serialises to `{}` and fails nothing.
    // @ts-expect-error Set does not round-trip through jsonb
    void store.enqueue(tx, 'tagged.with', { tags: new Set(['a']) });

    // The shapes that do round-trip are untouched by the constraint.
    void store.enqueue(tx, 'plain.fact', { id: 'x', count: 1, extra: null });

    // And an unknown event name is still the compile error the map exists for.
    // @ts-expect-error 'plain.fcat' is not an event
    void store.enqueue(tx, 'plain.fcat', { id: 'x', count: 1, extra: null });

    type SafeCreated = JsonSafe<DomainEventPayloads['user.created']>;
    const readable: SafeCreated = CREATED_PAYLOAD;
    expect(readable.userId).toBe('user-uuid-1');
  });
});
