const mockQueryOne = jest.fn();
const mockQueryCount = jest.fn();

jest.mock('@/db/query', () => ({
  query: jest.fn(),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  queryCount: (...args: unknown[]) => mockQueryCount(...args),
}));

import { IdempotencyStoreContentionError } from '@/idempotency/idempotency.errors';
import type { ClaimResult, IdempotencyClaim } from '@/idempotency/idempotency.types';
import { PostgresIdempotencyStore } from '@/idempotency/postgres.store';

const SCOPE = 'user-1:POST:/v1/users';
const KEY = 'key-abc';
const FINGERPRINT = 'fingerprint-1';

const RETENTION_MS = 60_000;
const LEASE_MS = 5_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The three statements `claim` can issue, told apart by what they do rather
 * than by call order — the order is what several of these cases are asserting.
 */
type StatementKind = 'insert' | 'read' | 'takeover' | 'complete' | 'release';

function kindOf(sql: string): StatementKind {
  if (sql.includes('ON CONFLICT')) return 'insert';
  if (sql.trimStart().startsWith('SELECT')) return 'read';
  if (sql.includes('DELETE FROM')) return 'release';
  if (sql.includes("'completed'")) return 'complete';
  return 'takeover';
}

/** Answers each statement kind with a canned result. */
function respondWith(responses: Partial<Record<StatementKind, unknown[]>>): void {
  const queues = new Map<StatementKind, unknown[]>(
    Object.entries(responses) as [StatementKind, unknown[]][],
  );

  mockQueryOne.mockImplementation((sql: string) => {
    const kind = kindOf(sql);
    const queue = queues.get(kind);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`unexpected ${kind} statement: no queued response`);
    }
    return Promise.resolve(queue.length === 1 ? queue[0] : queue.shift());
  });
}

function callsOf(kind: StatementKind): { sql: string; params: unknown[] }[] {
  return mockQueryOne.mock.calls
    .filter((call: unknown[]) => kindOf(String(call[0])) === kind)
    .map((call: unknown[]) => ({ sql: String(call[0]), params: (call[1] ?? []) as unknown[] }));
}

function storeUnderTest(): PostgresIdempotencyStore {
  return new PostgresIdempotencyStore({ retentionMs: RETENTION_MS, leaseMs: LEASE_MS });
}

function expectClaimed(result: ClaimResult): IdempotencyClaim {
  if (result.outcome !== 'claimed') {
    throw new Error(`expected a claim, got "${result.outcome}"`);
  }
  return result.claim;
}

/** A row as the read statement returns it, with the flags Postgres computes. */
function readRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim_id: '11111111-1111-4111-8111-111111111111',
    fingerprint: FINGERPRINT,
    state: 'in_progress',
    response_status: null,
    response_body: null,
    has_response_body: false,
    expired: false,
    stale: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
});

describe('PostgresIdempotencyStore.claim', () => {
  it('takes an unseen key in a single statement', async () => {
    respondWith({ insert: [{ claim_id: 'ignored' }] });

    const claim = expectClaimed(
      await storeUnderTest().claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );

    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(claim).toMatchObject({ scope: SCOPE, key: KEY });
    expect(claim.claimId).toMatch(UUID_PATTERN);
  });

  it('lets Postgres arbitrate the race instead of reading first', () => {
    respondWith({ insert: [{ claim_id: 'x' }] });

    return storeUnderTest()
      .claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT })
      .then(() => {
        const [insert] = callsOf('insert');
        expect(insert?.sql).toContain('ON CONFLICT ("scope", "key") DO NOTHING');
        // Retention is configured in milliseconds and Postgres wants seconds.
        expect(insert?.params).toEqual([SCOPE, KEY, expect.any(String), FINGERPRINT, 60]);
      });
  });

  it('replays a completed record for the same fingerprint', async () => {
    respondWith({
      insert: [null],
      read: [
        readRow({
          state: 'completed',
          response_status: 201,
          response_body: { data: { id: 'u1' } },
          has_response_body: true,
        }),
      ],
    });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result).toEqual({
      outcome: 'replay',
      response: { status: 201, hasBody: true, body: { data: { id: 'u1' } } },
    });
  });

  it('replays a body-less record as body-less rather than as a null body', async () => {
    respondWith({
      insert: [null],
      read: [readRow({ state: 'completed', response_status: 204, has_response_body: false })],
    });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result).toEqual({ outcome: 'replay', response: { status: 204, hasBody: false } });
  });

  it('distinguishes a recorded JSON null from a body-less record', async () => {
    respondWith({
      insert: [null],
      read: [
        readRow({
          state: 'completed',
          response_status: 200,
          response_body: null,
          has_response_body: true,
        }),
      ],
    });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result).toEqual({
      outcome: 'replay',
      response: { status: 200, hasBody: true, body: null },
    });
  });

  it('reports a live claim as in progress', async () => {
    respondWith({ insert: [null], read: [readRow()] });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result.outcome).toBe('in_progress');
  });

  it('reports a different fingerprint under a live key as a mismatch', async () => {
    respondWith({ insert: [null], read: [readRow({ fingerprint: 'other' })] });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result.outcome).toBe('mismatch');
  });

  it('passes the lease to the read so Postgres decides what is stale', async () => {
    respondWith({ insert: [null], read: [readRow()] });

    await storeUnderTest().claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    const [read] = callsOf('read');
    expect(read?.params).toEqual([SCOPE, KEY, 5]);
    expect(read?.sql).toContain('now()');
  });

  it('takes over an expired record, whatever fingerprint it held', async () => {
    respondWith({
      insert: [null],
      read: [readRow({ fingerprint: 'other', expired: true })],
      takeover: [{ claim_id: 'ignored' }],
    });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result.outcome).toBe('claimed');
    const [takeover] = callsOf('takeover');
    expect(takeover?.params).toEqual([SCOPE, KEY, expect.any(String), FINGERPRINT, 60, 5]);
  });

  it('takes over a claim whose holder never finished', async () => {
    respondWith({
      insert: [null],
      read: [readRow({ stale: true })],
      takeover: [{ claim_id: 'ignored' }],
    });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result.outcome).toBe('claimed');
  });

  it('re-reads rather than guessing when another retry takes over first', async () => {
    respondWith({
      insert: [null, null],
      read: [
        readRow({ stale: true }),
        readRow({
          state: 'completed',
          response_status: 201,
          response_body: { data: { id: 'u1' } },
          has_response_body: true,
        }),
      ],
      // The competing request won the takeover, so ours updates nothing.
      takeover: [null],
    });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result.outcome).toBe('replay');
  });

  it('re-inserts when the record disappears between the insert and the read', async () => {
    respondWith({ insert: [null, { claim_id: 'ignored' }], read: [null] });

    const result = await storeUnderTest().claim({
      scope: SCOPE,
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(result.outcome).toBe('claimed');
    expect(callsOf('insert')).toHaveLength(2);
  });

  it('gives up with a 503 rather than spinning when every attempt loses its race', async () => {
    respondWith({ insert: [null], read: [null] });

    await expect(
      storeUnderTest().claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    ).rejects.toBeInstanceOf(IdempotencyStoreContentionError);
    expect(callsOf('insert')).toHaveLength(3);
  });
});

describe('PostgresIdempotencyStore.complete', () => {
  const claim: IdempotencyClaim = {
    scope: SCOPE,
    key: KEY,
    claimId: '22222222-2222-4222-8222-222222222222',
  };

  it('records the response against the claim that owns the key', async () => {
    respondWith({ complete: [{ claim_id: claim.claimId }] });

    const stored = await storeUnderTest().complete(claim, {
      status: 201,
      hasBody: true,
      body: { data: { id: 'u1' } },
    });

    expect(stored).toBe(true);
    const [complete] = callsOf('complete');
    expect(complete?.sql).toContain('"claim_id" = $3');
    expect(complete?.params).toEqual([
      SCOPE,
      KEY,
      claim.claimId,
      201,
      JSON.stringify({ data: { id: 'u1' } }),
      true,
      60,
    ]);
  });

  it('writes a SQL NULL body for a body-less response', async () => {
    respondWith({ complete: [{ claim_id: claim.claimId }] });

    await storeUnderTest().complete(claim, { status: 204, hasBody: false });

    const [complete] = callsOf('complete');
    expect(complete?.params).toEqual([SCOPE, KEY, claim.claimId, 204, null, false, 60]);
  });

  it('writes a JSON null body as a present body', async () => {
    respondWith({ complete: [{ claim_id: claim.claimId }] });

    await storeUnderTest().complete(claim, { status: 200, hasBody: true, body: null });

    const [complete] = callsOf('complete');
    expect(complete?.params).toEqual([SCOPE, KEY, claim.claimId, 200, 'null', true, 60]);
  });

  it('reports false when the claim no longer owns the key', async () => {
    respondWith({ complete: [null] });

    await expect(
      storeUnderTest().complete(claim, { status: 201, hasBody: true, body: {} }),
    ).resolves.toBe(false);
  });
});

describe('PostgresIdempotencyStore.release', () => {
  const claim: IdempotencyClaim = {
    scope: SCOPE,
    key: KEY,
    claimId: '33333333-3333-4333-8333-333333333333',
  };

  it('deletes only an in-progress row held by this claim', async () => {
    respondWith({ release: [{ claim_id: claim.claimId }] });

    await expect(storeUnderTest().release(claim)).resolves.toBe(true);
    const [release] = callsOf('release');
    expect(release?.sql).toContain(`"state" = 'in_progress'`);
    expect(release?.params).toEqual([SCOPE, KEY, claim.claimId]);
  });

  it('reports false when there was nothing of ours to release', async () => {
    respondWith({ release: [null] });

    await expect(storeUnderTest().release(claim)).resolves.toBe(false);
  });
});

describe('PostgresIdempotencyStore.purgeExpired', () => {
  it('reports how many records it removed', async () => {
    mockQueryCount.mockResolvedValue(7);

    await expect(storeUnderTest().purgeExpired()).resolves.toBe(7);
    expect(String(mockQueryCount.mock.calls[0]?.[0])).toContain('DELETE FROM "idempotency_keys"');
  });
});

describe('PostgresIdempotencyStore construction', () => {
  it.each([
    ['retentionMs', { retentionMs: 0 }],
    ['leaseMs', { leaseMs: Number.NaN }],
  ])('rejects a non-positive %s', (_name, options) => {
    expect(() => new PostgresIdempotencyStore(options)).toThrow(RangeError);
  });
});
