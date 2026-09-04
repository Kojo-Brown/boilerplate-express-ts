import { encodeEnvelope } from '@/redis/stream.envelope';
import type { StreamEventEnvelope } from '@/redis/stream.envelope';
import { memoryStreamConnections, MemoryStreamCommands } from '@/redis/stream.memory';
import type { StreamCommands, StreamConnections } from '@/redis/stream.types';
import { createStreamWorker } from '@/redis/stream.worker';
import type { ParkedEntry, StreamEntryContext, StreamWorkerOptions } from '@/redis/stream.worker';

const KEY = 'test-events';
const GROUP = 'test-group';

/** A clock a test moves by hand, so an idle floor costs no wall time. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

function envelopeFields(overrides: Partial<StreamEventEnvelope> = {}): Record<string, string> {
  return encodeEnvelope({
    id: 'event-1',
    name: 'user.created',
    occurredAt: new Date('2026-09-04T00:00:00.000Z'),
    correlationId: null,
    payload: { userId: 'user-1' },
    ...overrides,
  });
}

interface Harness {
  readonly connections: StreamConnections;
  readonly store: MemoryStreamCommands;
  readonly clock: ReturnType<typeof fakeClock>;
}

function harness(): Harness {
  const clock = fakeClock();
  const connections = memoryStreamConnections({ now: clock.now, honourBlock: false });
  return { connections, store: connections.store, clock };
}

function workerOf(
  h: Harness,
  overrides: Partial<StreamWorkerOptions> = {},
): ReturnType<typeof createStreamWorker> {
  return createStreamWorker({
    connections: h.connections,
    key: KEY,
    group: GROUP,
    consumer: 'consumer-a',
    handler: () => Promise.resolve(),
    // Small and far apart: `minIdleMs` must exceed `handlerTimeoutMs`, and the
    // clock is fake, so the numbers only have to be ordered.
    handlerTimeoutMs: 50,
    minIdleMs: 1_000,
    blockMs: 1,
    onError: () => {},
    onOutcome: () => {},
    now: h.clock.now,
    ...overrides,
  });
}

/**
 * A `StreamCommands` that forwards to the in-memory store except where a test
 * replaces a method.
 *
 * Spelled out rather than spread from the instance: the store's methods live on
 * its prototype, so `{ ...store }` copies its private fields and none of its
 * behaviour — a mistake that fails as `commands.readGroup is not a function`
 * inside the loop rather than at the object literal.
 */
function delegating(
  store: MemoryStreamCommands,
  overrides: Partial<StreamCommands>,
): StreamCommands {
  const base: StreamCommands = {
    createGroup: (...args) => store.createGroup(...args),
    append: (...args) => store.append(...args),
    readGroup: (...args) => store.readGroup(...args),
    ack: (...args) => store.ack(...args),
    pendingEntries: (...args) => store.pendingEntries(...args),
    claim: (...args) => store.claim(...args),
    consumerPendingCount: (...args) => store.consumerPendingCount(...args),
    deleteConsumer: (...args) => store.deleteConsumer(...args),
  };
  return { ...base, ...overrides };
}

describe('createStreamWorker — configuration', () => {
  it('refuses a reclaim floor at or below the handler timeout', () => {
    // The invariant with teeth: below it, an entry a healthy but slow consumer
    // is still working on becomes claimable, and the work runs twice
    // concurrently on a system where nothing is wrong.
    const h = harness();

    expect(() => workerOf(h, { handlerTimeoutMs: 1_000, minIdleMs: 1_000 })).toThrow(RangeError);
    expect(() => workerOf(h, { handlerTimeoutMs: 1_000, minIdleMs: 999 })).toThrow(
      /must exceed handlerTimeoutMs/,
    );
  });

  it('accepts a floor above the timeout', () => {
    const h = harness();

    expect(() => workerOf(h, { handlerTimeoutMs: 1_000, minIdleMs: 1_001 })).not.toThrow();
  });

  it.each([
    ['batchSize', { batchSize: 0 }],
    ['blockMs', { blockMs: -1 }],
    ['maxDeliveries', { maxDeliveries: 0 }],
    ['claimBatchSize', { claimBatchSize: 1.5 }],
    ['reclaimIntervalMs', { reclaimIntervalMs: 0 }],
  ])('rejects a non-positive-integer %s', (_name, override) => {
    const h = harness();

    expect(() => workerOf(h, override)).toThrow(RangeError);
  });

  it('rejects an empty consumer name', () => {
    const h = harness();

    expect(() => workerOf(h, { consumer: '' })).toThrow(RangeError);
  });
});

describe('createStreamWorker — reading', () => {
  it('creates the group and reports whether it had to', async () => {
    const h = harness();
    const worker = workerOf(h);

    expect(await worker.ensureGroup()).toBe('created');
    expect(await worker.ensureGroup()).toBe('exists');
  });

  it('handles an entry and acknowledges it', async () => {
    const h = harness();
    const seen: StreamEventEnvelope[] = [];
    const worker = workerOf(h, {
      handler: (envelope) => {
        seen.push(envelope);
        return Promise.resolve();
      },
    });

    await worker.ensureGroup();
    await h.store.append(KEY, envelopeFields());

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ read: 1, handled: 1, failed: 0, parked: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('user.created');
    // Acknowledged means gone from the pending list — the only durable record
    // that the work was done.
    expect(h.store.pending(KEY, GROUP)).toHaveLength(0);
  });

  it('tells a handler this is a first delivery', async () => {
    const h = harness();
    const contexts: StreamEntryContext[] = [];
    const worker = workerOf(h, {
      handler: (_envelope, context) => {
        contexts.push(context);
        return Promise.resolve();
      },
    });

    await worker.ensureGroup();
    await h.store.append(KEY, envelopeFields());
    await worker.runOnce();

    expect(contexts[0]).toMatchObject({ deliveryCount: 1, reclaimed: false });
  });

  it('reads no more than the batch size in one tick', async () => {
    const h = harness();
    const worker = workerOf(h, { batchSize: 2 });

    await worker.ensureGroup();
    for (let i = 0; i < 5; i += 1) await h.store.append(KEY, envelopeFields({ id: `event-${i}` }));

    expect((await worker.runOnce()).handled).toBe(2);
    expect((await worker.runOnce()).handled).toBe(2);
    expect((await worker.runOnce()).handled).toBe(1);
  });

  it('leaves an entry pending when its handler throws', async () => {
    const h = harness();
    const worker = workerOf(h, { handler: () => Promise.reject(new Error('subscriber down')) });

    await worker.ensureGroup();
    await h.store.append(KEY, envelopeFields());

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ handled: 0, failed: 1, parked: 0 });
    // Not acknowledged: the pending list *is* the retry queue, and idle time is
    // the backoff. Acknowledging a failure would be losing the work.
    expect(h.store.pending(KEY, GROUP)).toHaveLength(1);
  });

  it('does not let one failing entry cost the rest of the batch their acks', async () => {
    const h = harness();
    const worker = workerOf(h, {
      handler: (envelope) =>
        envelope.id === 'event-1' ? Promise.reject(new Error('nope')) : Promise.resolve(),
    });

    await worker.ensureGroup();
    for (const id of ['event-0', 'event-1', 'event-2']) {
      await h.store.append(KEY, envelopeFields({ id }));
    }

    expect(await worker.runOnce()).toMatchObject({ handled: 2, failed: 1 });
    expect(h.store.pending(KEY, GROUP)).toHaveLength(1);
  });

  it('gives up on a handler that does not come back, and does not acknowledge it', async () => {
    jest.useFakeTimers();
    try {
      const h = harness();
      const errors: unknown[] = [];
      const worker = workerOf(h, {
        handler: () => new Promise<void>(() => {}),
        handlerTimeoutMs: 50,
        onError: (error) => errors.push(error),
      });

      await worker.ensureGroup();
      await h.store.append(KEY, envelopeFields());

      const tick = worker.runOnce();
      await jest.advanceTimersByTimeAsync(60);

      expect(await tick).toMatchObject({ failed: 1, handled: 0 });
      expect((errors[0] as Error).name).toBe('StreamHandlerTimeoutError');
      expect(h.store.pending(KEY, GROUP)).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('createStreamWorker — claim-on-stall', () => {
  it('takes over an entry a dead consumer left behind', async () => {
    const h = harness();
    const contexts: StreamEntryContext[] = [];
    const worker = workerOf(h, {
      consumer: 'consumer-b',
      handler: (_envelope, context) => {
        contexts.push(context);
        return Promise.resolve();
      },
    });

    await worker.ensureGroup();
    await h.store.append(KEY, envelopeFields());
    // Another replica read it and then died: the entry is delivered, owned by a
    // name that will never acknowledge it.
    h.store.deliverTo(KEY, GROUP, 'consumer-a', 10);

    // Before the idle floor, it is somebody else's in-flight work.
    expect(await worker.runOnce()).toMatchObject({ reclaimed: 0, handled: 0 });

    h.clock.advance(1_500);

    expect(await worker.runOnce()).toMatchObject({ reclaimed: 1, handled: 1 });
    expect(contexts[0]).toMatchObject({ deliveryCount: 2, reclaimed: true });
    expect(h.store.pending(KEY, GROUP)).toHaveLength(0);
  });

  it('does not scan the pending list more often than the reclaim interval', async () => {
    const h = harness();
    const scans: number[] = [];
    const spying = delegating(h.store, {
      pendingEntries: (options) => {
        scans.push(options.minIdleMs);
        return h.store.pendingEntries(options);
      },
    });

    const worker = createStreamWorker({
      connections: { blocking: spying, commands: spying },
      key: KEY,
      group: GROUP,
      consumer: 'consumer-a',
      handler: () => Promise.resolve(),
      handlerTimeoutMs: 50,
      minIdleMs: 1_000,
      reclaimIntervalMs: 500,
      blockMs: 1,
      onError: () => {},
      onOutcome: () => {},
      now: h.clock.now,
    });

    await worker.ensureGroup();

    // `runOnce` reclaims unconditionally — the interval is the *loop's*
    // business — so drive it explicitly to prove the flag is honoured.
    await worker.runOnce(false);
    expect(scans).toHaveLength(0);

    await worker.runOnce(true);
    expect(scans).toEqual([1_000]);
  });

  it('drops a pending reference to an entry that was trimmed away', async () => {
    const h = harness();
    const handled: string[] = [];
    const worker = workerOf(h, {
      consumer: 'consumer-b',
      handler: (envelope) => {
        handled.push(envelope.id);
        return Promise.resolve();
      },
    });

    await worker.ensureGroup();
    await h.store.append(KEY, envelopeFields({ id: 'event-old' }));
    h.store.deliverTo(KEY, GROUP, 'consumer-a', 10);

    // The cap evicts the entry while it is still pending. This is the one place
    // work is genuinely lost, and the reason the producer's cap is a safety
    // margin rather than a queue depth.
    await h.store.append(KEY, envelopeFields({ id: 'event-new' }), { maxLen: 1 });

    h.clock.advance(1_500);
    const outcome = await worker.runOnce();

    // Nothing was reclaimed — the entry is gone — but the dangling reference is
    // cleaned up rather than being retried forever.
    expect(outcome.reclaimed).toBe(0);
    expect(handled).toEqual(['event-new']);
    expect(h.store.pending(KEY, GROUP)).toHaveLength(0);
  });
});

describe('createStreamWorker — parking', () => {
  it('parks an entry that has exhausted its deliveries, and acknowledges it', async () => {
    const h = harness();
    const parked: ParkedEntry[] = [];
    const worker = workerOf(h, {
      handler: () => Promise.reject(new Error('always fails')),
      maxDeliveries: 3,
      onPark: (entry) => {
        parked.push(entry);
        return Promise.resolve();
      },
    });

    await worker.ensureGroup();
    await h.store.append(KEY, envelopeFields());

    // Delivery 1, then two reclaims: the third failure is the one that hits the
    // ceiling. Without it, claim-on-stall would redeliver this entry for the
    // life of the deployment.
    expect(await worker.runOnce()).toMatchObject({ failed: 1, parked: 0 });
    h.clock.advance(1_500);
    expect(await worker.runOnce()).toMatchObject({ failed: 1, parked: 0 });
    h.clock.advance(1_500);
    expect(await worker.runOnce()).toMatchObject({ failed: 0, parked: 1 });

    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ reason: 'delivery-ceiling', deliveryCount: 3 });
    expect(parked[0]?.lastError).toBe('Error: always fails');
    expect(h.store.pending(KEY, GROUP)).toHaveLength(0);
  });

  it('parks an undecodable entry immediately without calling the handler', async () => {
    const h = harness();
    const parked: ParkedEntry[] = [];
    const handler = jest.fn(() => Promise.resolve());
    const worker = workerOf(h, {
      handler,
      onPark: (entry) => {
        parked.push(entry);
        return Promise.resolve();
      },
    });

    await worker.ensureGroup();
    await h.store.append(KEY, { name: 'user.created', data: '{oops' });

    expect(await worker.runOnce()).toMatchObject({ parked: 1, failed: 0, handled: 0 });
    // Nothing about a second `JSON.parse` on the same bytes goes differently —
    // spending the whole ladder to find that out would be the bug.
    expect(handler).not.toHaveBeenCalled();
    expect(parked[0]?.reason).toBe('undecodable');
    expect(h.store.pending(KEY, GROUP)).toHaveLength(0);
  });

  it('leaves an entry pending when the parking lot itself fails', async () => {
    const h = harness();
    const worker = workerOf(h, {
      handler: () => Promise.resolve(),
      onPark: () => Promise.reject(new Error('parking lot unreachable')),
    });

    await worker.ensureGroup();
    await h.store.append(KEY, { name: 'user.created', data: '{oops' });

    // Park first, acknowledge second: a sink that is down must not turn into a
    // dropped entry. The tick fails, and the next reclaim parks it again.
    await expect(worker.runOnce()).rejects.toThrow('parking lot unreachable');
    expect(h.store.pending(KEY, GROUP)).toHaveLength(1);
  });
});

describe('createStreamWorker — lifecycle', () => {
  it('runs until stopped, then retires a consumer holding nothing', async () => {
    const clock = fakeClock();
    const connections = memoryStreamConnections({ now: clock.now });
    const handled: string[] = [];

    const worker = createStreamWorker({
      connections,
      key: KEY,
      group: GROUP,
      consumer: 'consumer-a',
      handler: (envelope) => {
        handled.push(envelope.id);
        return Promise.resolve();
      },
      handlerTimeoutMs: 20,
      minIdleMs: 1_000,
      blockMs: 5,
      onError: () => {},
      onOutcome: () => {},
      now: clock.now,
    });

    await worker.start();
    await connections.store.append(KEY, envelopeFields({ id: 'event-live' }));

    // Give the loop a few blocks to notice the entry.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await worker.stop();

    expect(handled).toEqual(['event-live']);
    // An empty pending list is what makes retirement safe, so the consumer row
    // is tidied away rather than accumulating one per replica that ever ran.
    expect(connections.store.consumers(KEY, GROUP)).not.toContain('consumer-a');
  });

  it('leaves a consumer in place when it still holds pending entries', async () => {
    const h = harness();
    const worker = workerOf(h, { handler: () => Promise.reject(new Error('nope')) });

    await worker.start();
    await h.store.append(KEY, envelopeFields());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.stop();

    // `XGROUP DELCONSUMER` does not reassign a consumer's pending entries — it
    // deletes them. Retiring here would destroy the work instead of leaving it
    // for another consumer to reclaim.
    expect(h.store.pending(KEY, GROUP)).toHaveLength(1);
    expect(h.store.consumers(KEY, GROUP)).toContain('consumer-a');
  });

  it('is idempotent about stopping', async () => {
    const h = harness();
    const worker = workerOf(h);

    await worker.start();
    await worker.stop();
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('recreates the group when it disappears underneath the loop', async () => {
    const h = harness();
    let readCalls = 0;
    const flaky = delegating(h.store, {
      readGroup: (options) => {
        readCalls += 1;
        if (readCalls === 1) {
          // What a FLUSHDB against a shared instance, or a failover to a replica
          // that never saw the create, looks like from in here.
          return Promise.reject(new Error(`NOGROUP No such key '${KEY}' or consumer group '${GROUP}'`));
        }
        return h.store.readGroup(options);
      },
    });

    const created: string[] = [];
    const worker = createStreamWorker({
      connections: { blocking: flaky, commands: flaky },
      key: KEY,
      group: GROUP,
      consumer: 'consumer-a',
      handler: (envelope) => {
        created.push(envelope.id);
        return Promise.resolve();
      },
      handlerTimeoutMs: 20,
      minIdleMs: 1_000,
      blockMs: 1,
      // The production ladder starts at half a second; here the point is that
      // the loop comes back at all, not how long it waits to.
      errorBackoffMs: 1,
      maxErrorBackoffMs: 2,
      onError: () => {},
      onOutcome: () => {},
      now: h.clock.now,
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.store.append(KEY, envelopeFields({ id: 'event-after-recovery' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await worker.stop();

    // Recovered rather than crashed: the loop kept going and delivered what
    // arrived after the group was rebuilt.
    expect(readCalls).toBeGreaterThan(1);
    expect(created).toContain('event-after-recovery');
  });

  it('reports a tick failure without stopping the loop', async () => {
    const h = harness();
    const errors: unknown[] = [];
    let calls = 0;
    const flaky = delegating(h.store, {
      readGroup: (options) => {
        calls += 1;
        return calls <= 2
          ? Promise.reject(new Error('Connection is closed.'))
          : h.store.readGroup(options);
      },
    });

    const worker = createStreamWorker({
      connections: { blocking: flaky, commands: flaky },
      key: KEY,
      group: GROUP,
      consumer: 'consumer-a',
      handler: () => Promise.resolve(),
      handlerTimeoutMs: 20,
      minIdleMs: 1_000,
      blockMs: 1,
      errorBackoffMs: 1,
      maxErrorBackoffMs: 2,
      onError: (error) => errors.push(error),
      onOutcome: () => {},
      now: h.clock.now,
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await worker.stop();

    // A background loop has no request to fail and nothing to escalate to;
    // exiting would trade a recoverable blip for a container restart.
    expect(errors.length).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(2);
  });
});
