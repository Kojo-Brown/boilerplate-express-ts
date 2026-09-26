import { MemoryReplayGuard } from '@/webhooks/replay-guard';

/** A clock the test drives, so expiry is exercised without waiting for it. */
function fixedClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (ms: number) => void (current += ms) };
}

const WINDOW_MS = 300_000;

describe('MemoryReplayGuard', () => {
  it('accepts a nonce it has not seen', async () => {
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ now: clock.now });

    await expect(guard.remember('k1:n1', clock.now() + WINDOW_MS)).resolves.toBe('accepted');
  });

  it('refuses the same nonce inside the window', async () => {
    // The attack the cache exists for: one captured delivery, presented twice,
    // both copies authentic.
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ now: clock.now });
    const expiresAt = clock.now() + WINDOW_MS;

    await expect(guard.remember('k1:n1', expiresAt)).resolves.toBe('accepted');
    await expect(guard.remember('k1:n1', expiresAt)).resolves.toBe('replayed');
    clock.advance(WINDOW_MS - 1);
    await expect(guard.remember('k1:n1', expiresAt)).resolves.toBe('replayed');
  });

  it('forgets a nonce once its window has closed', async () => {
    // Retention is the freshness window and not a number anyone chooses: past it,
    // the timestamp check refuses the delivery regardless, so remembering longer
    // buys nothing and costs a record.
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ now: clock.now });

    await guard.remember('k1:n1', clock.now() + WINDOW_MS);
    clock.advance(WINDOW_MS + 1);

    await expect(guard.remember('k1:n1', clock.now() + WINDOW_MS)).resolves.toBe('accepted');
  });

  it('treats an expiry exactly at now as expired', async () => {
    // The boundary stated once so it cannot drift: a record whose expiry has
    // arrived is collectable, which matches the middleware's own `>` window test.
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ now: clock.now });

    await guard.remember('k1:n1', clock.now() + 10);
    clock.advance(10);

    await expect(guard.remember('k1:n1', clock.now() + 10)).resolves.toBe('accepted');
  });

  it('keeps nonces from different key ids apart', async () => {
    // A nonce is chosen by whoever is signing, so two counterparties can pick the
    // same one by chance. Unscoped, the first to arrive would burn it for the
    // other — one sender denying another's deliveries without doing anything wrong.
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ now: clock.now });
    const expiresAt = clock.now() + WINDOW_MS;

    await expect(guard.remember('k1:shared-nonce', expiresAt)).resolves.toBe('accepted');
    await expect(guard.remember('k2:shared-nonce', expiresAt)).resolves.toBe('accepted');
  });

  it('reports cache-full rather than forgetting a nonce it still needs', async () => {
    // Fail closed. The alternative — evicting a live record to make room — keeps
    // the endpoint answering 200 with the guarantee silently gone, which is the
    // failure nobody notices until it is being used.
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ maxEntries: 2, now: clock.now });
    const expiresAt = clock.now() + WINDOW_MS;

    await expect(guard.remember('k1:n1', expiresAt)).resolves.toBe('accepted');
    await expect(guard.remember('k1:n2', expiresAt)).resolves.toBe('accepted');
    await expect(guard.remember('k1:n3', expiresAt)).resolves.toBe('cache-full');

    // And the records it refused to drop are still doing their job.
    await expect(guard.remember('k1:n1', expiresAt)).resolves.toBe('replayed');
  });

  it('sweeps expired records at capacity instead of refusing', async () => {
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ maxEntries: 2, now: clock.now });

    await guard.remember('k1:n1', clock.now() + 1_000);
    await guard.remember('k1:n2', clock.now() + 1_000);
    clock.advance(2_000);

    await expect(guard.remember('k1:n3', clock.now() + WINDOW_MS)).resolves.toBe('accepted');
    expect(guard.size()).toBe(1);
  });

  it('sweeps records whose expiry does not follow insertion order', async () => {
    // Why the sweep is a full walk rather than an early exit on the first
    // unexpired entry: `expiresAtMs` comes from the *sender's* timestamp, so a
    // delivery that sat in a queue for most of its window is inserted last and
    // expires first. An early exit would stop at the long-lived record and report
    // `cache-full` over a cache that is mostly garbage.
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ maxEntries: 2, now: clock.now });

    await guard.remember('k1:long-lived', clock.now() + WINDOW_MS);
    await guard.remember('k1:nearly-stale', clock.now() + 1_000);
    clock.advance(2_000);

    await expect(guard.remember('k1:fresh', clock.now() + WINDOW_MS)).resolves.toBe('accepted');
    await expect(guard.remember('k1:long-lived', clock.now() + WINDOW_MS)).resolves.toBe(
      'replayed',
    );
  });

  it('re-inserts an expired key at the back of the sweep order', async () => {
    const clock = fixedClock(1_000_000);
    const guard = new MemoryReplayGuard({ maxEntries: 4, now: clock.now });

    await guard.remember('k1:n1', clock.now() + 1_000);
    clock.advance(2_000);
    await guard.remember('k1:n1', clock.now() + WINDOW_MS);

    expect(guard.size()).toBe(1);
    await expect(guard.remember('k1:n1', clock.now() + WINDOW_MS)).resolves.toBe('replayed');
  });

  it('rejects a nonsensical bound at construction', () => {
    // A cache of zero entries accepts every replay, and there is no reading of
    // `maxEntries: 0` that anybody meant.
    expect(() => new MemoryReplayGuard({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new MemoryReplayGuard({ maxEntries: -1 })).toThrow(RangeError);
    expect(() => new MemoryReplayGuard({ maxEntries: 1.5 })).toThrow(RangeError);
  });

  it('holds no timer, so it neither leaks into a test nor keeps a process alive', () => {
    // The reason expiry is lazy: a sweeping interval is a handle Jest reports as
    // an open resource and that `appLifecycle` would have to learn to close.
    const guard = new MemoryReplayGuard();
    expect(guard.size()).toBe(0);
  });
});
