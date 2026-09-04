import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createStreamConnections } from '@/redis/ioredis.adapter';
import { parkedStreamKey, createParkingLot, PARK_FIELDS } from '@/redis/parking-lot';
import { isNoGroupError } from '@/redis/redis.errors';
import { decodeEnvelope, encodeEnvelope } from '@/redis/stream.envelope';
import type { StreamEventEnvelope } from '@/redis/stream.envelope';
import { createStreamPublisher } from '@/redis/stream.publisher';
import type { StreamConnections } from '@/redis/stream.types';
import { createStreamWorker } from '@/redis/stream.worker';
import type { ParkedEntry, StreamEntryContext } from '@/redis/stream.worker';

/**
 * The claims that are about **Redis** rather than about the worker.
 *
 * Everything asserted here is server behaviour the design leans on and that a
 * fake could only echo back: that `XCLAIM` refuses an entry whose idle time is
 * below the floor (which is the only thing stopping two workers from reclaiming
 * the same entry), that `XPENDING` reports the delivery count the poison
 * ceiling reads, that a pending reference to a trimmed entry is dropped rather
 * than returned, that `XGROUP DELCONSUMER` destroys pending entries instead of
 * reassigning them, and that `XREADGROUP >` never redelivers. Proving those
 * against `MemoryStreamCommands` would prove only what its author believed.
 *
 * It also exercises the adapter's reply parsing against replies an actual
 * server produced, which is the other half of what a fake cannot do.
 *
 * Skipped without `REDIS_TEST_URL`, so a contributor with no Redis can still
 * run the suite. `redis.guard.test.ts` is what keeps that from silently
 * applying in CI.
 */
const url = process.env['REDIS_TEST_URL'] ?? '';
const describeRedis = url === '' ? describe.skip : describe;

/** Idle floors have to be waited out for real here; these keep that cheap. */
const HANDLER_TIMEOUT_MS = 40;
const MIN_IDLE_MS = 120;
const IDLE_WAIT_MS = 200;

function envelopeOf(overrides: Partial<StreamEventEnvelope> = {}): StreamEventEnvelope {
  return {
    id: `event-${randomUUID()}`,
    name: 'user.created',
    occurredAt: new Date('2026-09-04T10:00:00.000Z'),
    correlationId: null,
    payload: { userId: 'user-1', roles: ['admin'], actorId: null },
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeRedis('Redis Streams against a real server', () => {
  const GROUP = 'test-group';
  let connections: StreamConnections & { close(): Promise<void> };
  let admin: Redis;
  const keys: string[] = [];

  /** A fresh key per test, so nothing inherits another test's pending list. */
  function freshKey(): string {
    const key = `test:stream:${randomUUID()}`;
    keys.push(key, parkedStreamKey(key));
    return key;
  }

  beforeAll(() => {
    connections = createStreamConnections(url);
    admin = new Redis(url);
  });

  afterAll(async () => {
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
    await connections.close();
  });

  describe('group creation', () => {
    it('creates the group, then reports it already exists', async () => {
      const key = freshKey();

      expect(await connections.commands.createGroup(key, GROUP)).toBe('created');
      // BUSYGROUP is the reply on every boot after the first. Treating it as
      // the idempotence is what makes "create if missing" safe to run from
      // every replica at once.
      expect(await connections.commands.createGroup(key, GROUP)).toBe('exists');
    });

    it('surfaces NOGROUP for a group that was never created', async () => {
      const key = freshKey();
      await admin.xadd(key, '*', 'name', 'x', 'data', 'null');

      const error = await connections.commands
        .readGroup({ key, group: 'absent', consumer: 'c1', count: 1, blockMs: 10 })
        .catch((caught: unknown) => caught);

      expect(isNoGroupError(error)).toBe(true);
    });
  });

  describe('reading and acknowledging', () => {
    it('round-trips a published envelope', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);

      const envelope = envelopeOf();
      await createStreamPublisher({ commands: connections.commands, key, maxLen: 100 }).publish(envelope);

      const entries = await connections.commands.readGroup({
        key,
        group: GROUP,
        consumer: 'c1',
        count: 10,
        blockMs: 50,
      });

      expect(entries).toHaveLength(1);
      expect(decodeEnvelope(entries[0]!)).toEqual(envelope);
    });

    it('returns nothing when the block expires', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);

      // A real server answers a timed-out block with a null reply, which the
      // parser has to read as "nothing", not as a malformed array.
      const started = Date.now();
      const entries = await connections.blocking.readGroup({
        key,
        group: GROUP,
        consumer: 'c1',
        count: 10,
        blockMs: 60,
      });

      expect(entries).toEqual([]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    });

    it('does not redeliver an unacknowledged entry to the same consumer', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      await admin.xadd(key, '*', ...Object.entries(encodeEnvelope(envelopeOf())).flat());

      const read = (): Promise<readonly unknown[]> =>
        connections.commands.readGroup({ key, group: GROUP, consumer: 'c1', count: 10, blockMs: 20 });

      expect(await read()).toHaveLength(1);
      // The misconception this rules out: `>` means "never delivered to anyone",
      // so an entry this consumer failed on does not come back on the next read.
      // Recovering it is `XPENDING` + `XCLAIM`, which is why the worker has a
      // reclaim path at all.
      expect(await read()).toHaveLength(0);
    });

    it('clears the pending entry on acknowledgement', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      await admin.xadd(key, '*', ...Object.entries(encodeEnvelope(envelopeOf())).flat());

      const [entry] = await connections.commands.readGroup({
        key,
        group: GROUP,
        consumer: 'c1',
        count: 1,
        blockMs: 20,
      });

      expect(await connections.commands.ack(key, GROUP, [entry!.id])).toBe(1);
      expect(await connections.commands.consumerPendingCount(key, GROUP, 'c1')).toBe(0);
      // A second ack is a no-op rather than an error — which is what makes an
      // ack that was retried after a dropped connection safe.
      expect(await connections.commands.ack(key, GROUP, [entry!.id])).toBe(0);
    });
  });

  describe('the pending list', () => {
    it('reports delivery counts, and increments them on a claim', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      await admin.xadd(key, '*', ...Object.entries(encodeEnvelope(envelopeOf())).flat());
      await connections.commands.readGroup({ key, group: GROUP, consumer: 'c1', count: 1, blockMs: 20 });

      const [first] = await connections.commands.pendingEntries({
        key,
        group: GROUP,
        minIdleMs: 0,
        count: 10,
      });
      expect(first).toMatchObject({ consumer: 'c1', deliveryCount: 1 });

      await connections.commands.claim({
        key,
        group: GROUP,
        consumer: 'c2',
        minIdleMs: 0,
        ids: [first!.id],
      });

      const [second] = await connections.commands.pendingEntries({
        key,
        group: GROUP,
        minIdleMs: 0,
        count: 10,
      });
      // The field the poison ceiling is read from. Without it there is no way
      // to tell a dead consumer's good work from an entry that kills consumers.
      expect(second).toMatchObject({ consumer: 'c2', deliveryCount: 2 });
    });

    it('filters by idle time on the server', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      await admin.xadd(key, '*', ...Object.entries(encodeEnvelope(envelopeOf())).flat());
      await connections.commands.readGroup({ key, group: GROUP, consumer: 'c1', count: 1, blockMs: 20 });

      expect(
        await connections.commands.pendingEntries({ key, group: GROUP, minIdleMs: 60_000, count: 10 }),
      ).toEqual([]);
      expect(
        await connections.commands.pendingEntries({ key, group: GROUP, minIdleMs: 0, count: 10 }),
      ).toHaveLength(1);
    });

    it('refuses a claim on an entry that is not idle enough', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      await admin.xadd(key, '*', ...Object.entries(encodeEnvelope(envelopeOf())).flat());
      const [entry] = await connections.commands.readGroup({
        key,
        group: GROUP,
        consumer: 'c1',
        count: 1,
        blockMs: 20,
      });

      // This refusal, applied per entry inside the server, is the whole
      // concurrency control for claim-on-stall: between the XPENDING that
      // selected an id and the XCLAIM that takes it, another worker may have
      // claimed it and reset the clock.
      const claimed = await connections.commands.claim({
        key,
        group: GROUP,
        consumer: 'c2',
        minIdleMs: 60_000,
        ids: [entry!.id],
      });

      expect(claimed).toEqual([]);
      expect(
        await connections.commands.pendingEntries({ key, group: GROUP, minIdleMs: 0, count: 10 }),
      ).toMatchObject([{ consumer: 'c1' }]);
    });

    it('drops a pending reference to an entry that was trimmed away', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      await admin.xadd(key, '*', ...Object.entries(encodeEnvelope(envelopeOf())).flat());
      const [entry] = await connections.commands.readGroup({
        key,
        group: GROUP,
        consumer: 'c1',
        count: 1,
        blockMs: 20,
      });

      // What a MAXLEN cap does to an entry that is still pending. `XDEL` is the
      // deterministic version of the same eviction.
      await admin.xdel(key, entry!.id);

      const claimed = await connections.commands.claim({
        key,
        group: GROUP,
        consumer: 'c2',
        minIdleMs: 0,
        ids: [entry!.id],
      });

      expect(claimed).toEqual([]);
      // The reference is gone rather than being retried forever — and with it
      // the work, which is why the producer's cap is a safety margin.
      expect(
        await connections.commands.pendingEntries({ key, group: GROUP, minIdleMs: 0, count: 10 }),
      ).toEqual([]);
    });

    it('destroys a consumer’s pending entries when it is deleted', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      await admin.xadd(key, '*', ...Object.entries(encodeEnvelope(envelopeOf())).flat());
      await connections.commands.readGroup({ key, group: GROUP, consumer: 'c1', count: 1, blockMs: 20 });

      // The reason `stop()` refuses to retire a consumer that still holds
      // entries: DELCONSUMER does not hand them to anybody, it deletes them.
      expect(await connections.commands.deleteConsumer(key, GROUP, 'c1')).toBe(1);
      expect(
        await connections.commands.pendingEntries({ key, group: GROUP, minIdleMs: 0, count: 10 }),
      ).toEqual([]);
    });
  });

  describe('the worker end to end', () => {
    it('reclaims an entry a dead consumer left behind', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      const envelope = envelopeOf();
      await createStreamPublisher({ commands: connections.commands, key, maxLen: 100 }).publish(envelope);

      // A replica read it and died: delivered, owned by a name that will never
      // acknowledge it.
      await connections.commands.readGroup({ key, group: GROUP, consumer: 'dead', count: 10, blockMs: 20 });

      const contexts: StreamEntryContext[] = [];
      const worker = createStreamWorker({
        connections,
        key,
        group: GROUP,
        consumer: 'survivor',
        handler: (_envelope, context) => {
          contexts.push(context);
          return Promise.resolve();
        },
        handlerTimeoutMs: HANDLER_TIMEOUT_MS,
        minIdleMs: MIN_IDLE_MS,
        blockMs: 20,
        onError: () => {},
        onOutcome: () => {},
      });

      // Before the floor, it is somebody else's in-flight work.
      expect(await worker.runOnce()).toMatchObject({ reclaimed: 0 });

      await wait(IDLE_WAIT_MS);

      expect(await worker.runOnce()).toMatchObject({ reclaimed: 1, handled: 1 });
      expect(contexts[0]).toMatchObject({ deliveryCount: 2, reclaimed: true });
      expect(await connections.commands.consumerPendingCount(key, GROUP, 'survivor')).toBe(0);
    });

    it('parks an undecodable entry on the companion stream', async () => {
      const key = freshKey();
      await connections.commands.createGroup(key, GROUP);
      await admin.xadd(key, '*', 'name', 'user.created', 'data', '{oops');

      const parked: ParkedEntry[] = [];
      const worker = createStreamWorker({
        connections,
        key,
        group: GROUP,
        consumer: 'c1',
        handler: () => Promise.reject(new Error('should not be called')),
        onPark: async (entry) => {
          parked.push(entry);
          await createParkingLot({ commands: connections.commands, key })(entry);
        },
        handlerTimeoutMs: HANDLER_TIMEOUT_MS,
        minIdleMs: MIN_IDLE_MS,
        blockMs: 20,
        onError: () => {},
        onOutcome: () => {},
      });

      expect(await worker.runOnce()).toMatchObject({ parked: 1, handled: 0, failed: 0 });
      expect(parked[0]?.reason).toBe('undecodable');

      const stored = await admin.xrange(parkedStreamKey(key), '-', '+');
      expect(stored).toHaveLength(1);
      expect(stored[0]?.[1]).toContain(PARK_FIELDS.reason);
      // Acknowledged, so it does not come back — the durable copy on the parked
      // stream is what replaces the retry.
      expect(await connections.commands.consumerPendingCount(key, GROUP, 'c1')).toBe(0);
    });

    it('runs a loop and drains it on stop', async () => {
      const key = freshKey();
      const handled: string[] = [];
      const worker = createStreamWorker({
        connections,
        key,
        group: GROUP,
        consumer: 'looping',
        handler: (envelope) => {
          handled.push(envelope.id);
          return Promise.resolve();
        },
        handlerTimeoutMs: HANDLER_TIMEOUT_MS,
        minIdleMs: MIN_IDLE_MS,
        blockMs: 20,
        onError: () => {},
        onOutcome: () => {},
      });

      await worker.start();

      const envelope = envelopeOf();
      await createStreamPublisher({ commands: connections.commands, key, maxLen: 100 }).publish(envelope);

      await wait(150);
      await worker.stop();

      expect(handled).toEqual([envelope.id]);
      // Retired, because it was holding nothing — which is what keeps
      // XINFO CONSUMERS from growing a row per replica that ever ran.
      const consumers = await admin.xinfo('CONSUMERS', key, GROUP);
      expect(JSON.stringify(consumers)).not.toContain('looping');
    });
  });
});
