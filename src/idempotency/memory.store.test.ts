import type { ClaimResult, IdempotencyClaim } from '@/idempotency/idempotency.types';
import { MemoryIdempotencyStore } from '@/idempotency/memory.store';

const SCOPE = 'user-1:POST:/v1/users';
const KEY = 'key-abc';
const FINGERPRINT = 'fingerprint-1';

let clock = 1_000_000;
const now = (): number => clock;

function storeWith(options: { retentionMs?: number; leaseMs?: number } = {}): MemoryIdempotencyStore {
  return new MemoryIdempotencyStore({ ...options, now });
}

/** Narrows to the claimed branch, failing the test rather than the type check. */
function expectClaimed(result: ClaimResult): IdempotencyClaim {
  if (result.outcome !== 'claimed') {
    throw new Error(`expected a claim, got "${result.outcome}"`);
  }
  return result.claim;
}

beforeEach(() => {
  clock = 1_000_000;
});

describe('MemoryIdempotencyStore.claim', () => {
  it('claims an unseen key', async () => {
    const store = storeWith();

    const result = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(result.outcome).toBe('claimed');
    expect(store.size).toBe(1);
  });

  it('reports the second claim on a live key as in progress', async () => {
    const store = storeWith();
    await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    const second = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(second.outcome).toBe('in_progress');
  });

  it('reports a different body under the same live key as a mismatch', async () => {
    const store = storeWith();
    await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    const second = await store.claim({ scope: SCOPE, key: KEY, fingerprint: 'fingerprint-2' });

    expect(second.outcome).toBe('mismatch');
  });

  it('does not let one scope see another scope key', async () => {
    const store = storeWith();
    await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    const other = await store.claim({
      scope: 'user-2:POST:/v1/users',
      key: KEY,
      fingerprint: FINGERPRINT,
    });

    expect(other.outcome).toBe('claimed');
  });

  it('cannot be made to collide by choosing a key that looks like a scope', async () => {
    const store = storeWith();
    await store.claim({ scope: 'a:b', key: 'c', fingerprint: FINGERPRINT });

    const overlapping = await store.claim({ scope: 'a', key: 'b:c', fingerprint: FINGERPRINT });

    expect(overlapping.outcome).toBe('claimed');
  });

  it('replays a completed response for the same body', async () => {
    const store = storeWith();
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );
    await store.complete(claim, { status: 201, hasBody: true, body: { id: 'u1' } });

    const replay = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(replay).toEqual({
      outcome: 'replay',
      response: { status: 201, hasBody: true, body: { id: 'u1' } },
    });
  });

  it('preserves a body-less response through a replay', async () => {
    const store = storeWith();
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );
    await store.complete(claim, { status: 204, hasBody: false });

    const replay = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(replay).toEqual({ outcome: 'replay', response: { status: 204, hasBody: false } });
  });

  it('reports a mismatch even once the response is recorded', async () => {
    const store = storeWith();
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );
    await store.complete(claim, { status: 201, hasBody: true, body: { id: 'u1' } });

    const reused = await store.claim({ scope: SCOPE, key: KEY, fingerprint: 'fingerprint-2' });

    expect(reused.outcome).toBe('mismatch');
  });

  it('claims a key again once its record has expired', async () => {
    const store = storeWith({ retentionMs: 1_000 });
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );
    await store.complete(claim, { status: 201, hasBody: true, body: { id: 'u1' } });

    clock += 1_001;
    const afterExpiry = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(afterExpiry.outcome).toBe('claimed');
  });

  it('takes over a claim whose holder never finished', async () => {
    const store = storeWith({ leaseMs: 5_000 });
    await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    clock += 5_000;
    const takenOver = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(takenOver.outcome).toBe('claimed');
  });

  it('takes over a dead claim regardless of the fingerprint it was holding', async () => {
    const store = storeWith({ leaseMs: 5_000 });
    await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    clock += 5_000;
    const takenOver = await store.claim({ scope: SCOPE, key: KEY, fingerprint: 'fingerprint-2' });

    expect(takenOver.outcome).toBe('claimed');
  });

  it('holds the claim for the whole lease', async () => {
    const store = storeWith({ leaseMs: 5_000 });
    await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    clock += 4_999;
    const stillHeld = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(stillHeld.outcome).toBe('in_progress');
  });

  it('does not apply the lease to a completed record', async () => {
    const store = storeWith({ leaseMs: 5_000, retentionMs: 60_000 });
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );
    await store.complete(claim, { status: 201, hasBody: true, body: { id: 'u1' } });

    clock += 10_000;
    const replay = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(replay.outcome).toBe('replay');
  });
});

describe('MemoryIdempotencyStore.complete', () => {
  it('reports false for a claim that was taken over', async () => {
    const store = storeWith({ leaseMs: 5_000 });
    const first = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );

    clock += 5_000;
    expectClaimed(await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }));

    await expect(
      store.complete(first, { status: 201, hasBody: true, body: { id: 'u1' } }),
    ).resolves.toBe(false);
  });

  it('leaves the new owner record intact when a superseded claim completes', async () => {
    const store = storeWith({ leaseMs: 5_000 });
    const first = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );

    clock += 5_000;
    const second = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );
    await store.complete(first, { status: 500, hasBody: true, body: { stale: true } });
    await store.complete(second, { status: 201, hasBody: true, body: { id: 'u1' } });

    const replay = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(replay).toEqual({
      outcome: 'replay',
      response: { status: 201, hasBody: true, body: { id: 'u1' } },
    });
  });

  it('reports false for a key that was already released', async () => {
    const store = storeWith();
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );
    await store.release(claim);

    await expect(
      store.complete(claim, { status: 201, hasBody: true, body: null }),
    ).resolves.toBe(false);
  });

  it('restarts the retention window when the response is recorded', async () => {
    const store = storeWith({ retentionMs: 10_000 });
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );

    clock += 9_000;
    await store.complete(claim, { status: 201, hasBody: true, body: { id: 'u1' } });

    clock += 9_000;
    const replay = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(replay.outcome).toBe('replay');
  });
});

describe('MemoryIdempotencyStore.release', () => {
  it('frees the key for an immediate retry', async () => {
    const store = storeWith();
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );

    await expect(store.release(claim)).resolves.toBe(true);
    const retry = await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT });

    expect(retry.outcome).toBe('claimed');
  });

  it('refuses to release a completed record', async () => {
    const store = storeWith();
    const claim = expectClaimed(
      await store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    );
    await store.complete(claim, { status: 201, hasBody: true, body: { id: 'u1' } });

    await expect(store.release(claim)).resolves.toBe(false);
    await expect(
      store.claim({ scope: SCOPE, key: KEY, fingerprint: FINGERPRINT }),
    ).resolves.toMatchObject({ outcome: 'replay' });
  });
});

describe('MemoryIdempotencyStore.purgeExpired', () => {
  it('removes only records past their retention window', async () => {
    const store = storeWith({ retentionMs: 1_000 });
    await store.claim({ scope: SCOPE, key: 'old', fingerprint: FINGERPRINT });

    clock += 1_001;
    await store.claim({ scope: SCOPE, key: 'new', fingerprint: FINGERPRINT });

    await expect(store.purgeExpired()).resolves.toBe(1);
    expect(store.size).toBe(1);
  });
});

describe('MemoryIdempotencyStore construction', () => {
  it.each([
    ['retentionMs', { retentionMs: 0 }],
    ['leaseMs', { leaseMs: -1 }],
  ])('rejects a non-positive %s', (_name, options) => {
    expect(() => new MemoryIdempotencyStore(options)).toThrow(RangeError);
  });
});
