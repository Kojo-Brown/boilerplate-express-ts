import { Bulkhead, withBulkhead } from '@/resilience/bulkhead';

/** Lets every already-resolvable promise settle without advancing the clock. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Whether a promise has settled, without settling it.
 *
 * Every claim in this file is about a caller that is *still waiting*, and
 * `await`ing to find out would deadlock the assertion it was making.
 */
function tracked<T>(promise: Promise<T>): {
  readonly promise: Promise<T>;
  readonly done: () => boolean;
} {
  let done = false;
  const settle = (): void => {
    done = true;
  };
  promise.then(settle, settle);
  return { promise, done: () => done };
}

describe('Bulkhead', () => {
  describe('construction', () => {
    // At construction and not at first call: a bulkhead with a concurrency of
    // zero refuses every call to a perfectly healthy dependency, and the moment
    // to discover that is the boot that wired it.
    it.each([
      ['maxConcurrent below 1', { maxConcurrent: 0, maxQueue: 1, queueTimeoutMs: 1 }],
      ['a fractional maxConcurrent', { maxConcurrent: 1.5, maxQueue: 1, queueTimeoutMs: 1 }],
      ['a negative maxQueue', { maxConcurrent: 1, maxQueue: -1, queueTimeoutMs: 1 }],
      ['queueTimeoutMs below 1', { maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 0 }],
    ])('refuses %s', (_case, options) => {
      expect(() => new Bulkhead({ name: 'payments', ...options })).toThrow(RangeError);
    });

    it('accepts a queue of zero, which is pure load-shedding', () => {
      const bulkhead = new Bulkhead({
        name: 'payments',
        maxConcurrent: 1,
        maxQueue: 0,
        queueTimeoutMs: 10,
      });

      expect(bulkhead.stats()).toEqual({
        inFlight: 0,
        queued: 0,
        maxConcurrent: 1,
        maxQueue: 0,
      });
    });
  });

  it('admits up to the cap without anybody waiting', async () => {
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 3,
      maxQueue: 0,
      queueTimeoutMs: 10,
    });

    await Promise.all([bulkhead.acquire(), bulkhead.acquire(), bulkhead.acquire()]);

    expect(bulkhead.stats()).toMatchObject({ inFlight: 3, queued: 0 });
  });

  it('queues the caller past the cap rather than admitting it', async () => {
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 2,
      queueTimeoutMs: 5_000,
    });

    await bulkhead.acquire();
    const waiting = tracked(bulkhead.acquire());
    await flush();

    expect(waiting.done()).toBe(false);
    expect(bulkhead.stats()).toMatchObject({ inFlight: 1, queued: 1 });
  });

  it('refuses immediately once the queue is also full', async () => {
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 5_000,
    });

    await bulkhead.acquire();
    const queued = tracked(bulkhead.acquire());

    // Not "eventually rejects" but "rejects now": shedding load late is the
    // same as not shedding it, because the cost being avoided is the wait.
    await expect(bulkhead.acquire()).rejects.toMatchObject({
      name: 'BulkheadFullError',
      reason: 'queue-full',
      statusCode: 503,
      code: 'BULKHEAD_FULL',
      headers: { 'Retry-After': '1' },
    });
    expect(queued.done()).toBe(false);
  });

  it('hands a released slot to the head of the queue, in order', async () => {
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 3,
      queueTimeoutMs: 5_000,
    });

    const first = await bulkhead.acquire();
    const order: string[] = [];
    const a = tracked(bulkhead.acquire().then(() => order.push('a')));
    const b = tracked(bulkhead.acquire().then(() => order.push('b')));
    await flush();
    expect([a.done(), b.done()]).toEqual([false, false]);

    first.release();
    await flush();

    expect(order).toEqual(['a']);
    expect(bulkhead.stats()).toMatchObject({ inFlight: 1, queued: 1 });
  });

  it('does not let a fresh caller barge the queue', async () => {
    // The failure a counter-and-wake semaphore has and this one must not:
    // under saturation — the only time any of this runs — barging starves the
    // oldest waiter indefinitely, and the oldest waiter is precisely the caller
    // whose own deadline is closest to expiring.
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 3,
      queueTimeoutMs: 5_000,
    });

    const held = await bulkhead.acquire();
    const early = tracked(bulkhead.acquire());
    await flush();

    const late = tracked(bulkhead.acquire());
    await flush();
    held.release();
    await flush();

    expect(early.done()).toBe(true);
    expect(late.done()).toBe(false);
  });

  it('refuses a caller that has waited longer than the queue deadline', async () => {
    // A bounded queue that never expires is still unbounded in time: the caller
    // reaching the front is handed a slot to make a call whose requester left.
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 20,
    });

    await bulkhead.acquire();

    await expect(bulkhead.acquire()).rejects.toMatchObject({
      name: 'BulkheadFullError',
      reason: 'queue-timeout',
      statusCode: 503,
    });
    // The slot it was holding is gone with it, so the next caller may queue.
    expect(bulkhead.stats()).toMatchObject({ inFlight: 1, queued: 0 });
  });

  it('gives up its place when the caller hangs up', async () => {
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 5_000,
    });

    const held = await bulkhead.acquire();
    const controller = new AbortController();
    const abandoned = bulkhead.acquire(controller.signal);
    await flush();
    expect(bulkhead.stats()).toMatchObject({ queued: 1 });

    controller.abort(new Error('client hung up'));

    await expect(abandoned).rejects.toThrow('client hung up');
    expect(bulkhead.stats()).toMatchObject({ queued: 0 });

    // And the slot it vacated goes to a real caller rather than to a ghost.
    const next = tracked(bulkhead.acquire());
    await flush();
    held.release();
    await flush();
    expect(next.done()).toBe(true);
  });

  it('makes no reservation at all for a signal that is already aborted', async () => {
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 5_000,
    });
    const controller = new AbortController();
    controller.abort(new Error('too late'));

    await expect(bulkhead.acquire(controller.signal)).rejects.toThrow('too late');
    // Checked before the fast path, not after: an already-aborted signal fires
    // no event, so a permit taken here would never be released.
    expect(bulkhead.stats()).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('treats a second release as the programming error it is', async () => {
    // Swallowed instead, the symptom is a cap that silently stops being a cap.
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 0,
      queueTimeoutMs: 10,
    });

    const permit = await bulkhead.acquire();
    permit.release();

    expect(() => permit.release()).toThrow(/released twice/);
    expect(bulkhead.stats()).toMatchObject({ inFlight: 0 });
  });

  it('names the dependency in the error a caller sees', async () => {
    const bulkhead = new Bulkhead({
      name: 'search',
      maxConcurrent: 1,
      maxQueue: 0,
      queueTimeoutMs: 10,
    });
    await bulkhead.acquire();

    await expect(bulkhead.acquire()).rejects.toThrow(/Bulkhead "search" is full/);
  });
});

describe('withBulkhead', () => {
  it('releases the slot when the work throws', async () => {
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 0,
      queueTimeoutMs: 10,
    });

    await expect(
      withBulkhead(bulkhead, () => Promise.reject(new Error('upstream exploded'))),
    ).rejects.toThrow('upstream exploded');

    // The whole reason this helper exists: a hand-rolled acquire/finally is
    // right until somebody adds an early return between the two lines, and a
    // cap that erodes over days is invisible in every test.
    expect(bulkhead.stats()).toMatchObject({ inFlight: 0 });
  });

  it('holds the slot for the whole of the work, not just its start', async () => {
    const bulkhead = new Bulkhead({
      name: 'payments',
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 5_000,
    });

    let finish = (): void => {};
    const running = withBulkhead(bulkhead, () => new Promise<void>((resolve) => (finish = resolve)));
    await flush();

    expect(bulkhead.stats()).toMatchObject({ inFlight: 1 });
    finish();
    await running;
    expect(bulkhead.stats()).toMatchObject({ inFlight: 0 });
  });
});
