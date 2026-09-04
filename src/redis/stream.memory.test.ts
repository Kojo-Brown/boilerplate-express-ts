import { MemoryStreamCommands, memoryStreamConnections } from '@/redis/stream.memory';

const KEY = 'test-events';
const GROUP = 'test-group';

/**
 * The fake's own semantics.
 *
 * Worth testing because the worker's suite reads its assertions *through* this
 * — "the entry is still pending" is a claim about this class — so a fake that
 * quietly forgot to increment a delivery count would make the ceiling test pass
 * for the wrong reason. It is still not evidence about Redis; the same claims
 * are made against a real server in `redis.integration.test.ts`.
 */
describe('MemoryStreamCommands', () => {
  function clockedStore(): { store: MemoryStreamCommands; advance: (ms: number) => void } {
    let current = 1_000;
    const store = new MemoryStreamCommands({ now: () => current, honourBlock: false });
    return { store, advance: (ms) => (current += ms) };
  }

  it('reports a duplicate group creation rather than throwing', async () => {
    const store = new MemoryStreamCommands();

    expect(await store.createGroup(KEY, GROUP)).toBe('created');
    expect(await store.createGroup(KEY, GROUP)).toBe('exists');
  });

  it('starts a `$` group after what is already there', async () => {
    const store = new MemoryStreamCommands({ honourBlock: false });
    await store.append(KEY, { k: 'before' });
    await store.createGroup(KEY, GROUP, { from: '$' });
    await store.append(KEY, { k: 'after' });

    const read = await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 10, blockMs: 0 });

    expect(read.map((entry) => entry.fields['k'])).toEqual(['after']);
  });

  it('starts a `0` group at the beginning', async () => {
    const store = new MemoryStreamCommands({ honourBlock: false });
    await store.append(KEY, { k: 'before' });
    await store.createGroup(KEY, GROUP, { from: '0' });

    const read = await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 10, blockMs: 0 });

    expect(read.map((entry) => entry.fields['k'])).toEqual(['before']);
  });

  it('throws NOGROUP for a group that does not exist', async () => {
    const store = new MemoryStreamCommands({ honourBlock: false });

    await expect(
      store.readGroup({ key: KEY, group: 'absent', consumer: 'c1', count: 1, blockMs: 0 }),
    ).rejects.toThrow(/NOGROUP/);
  });

  it('does not redeliver an unacknowledged entry to the same consumer', async () => {
    const store = new MemoryStreamCommands({ honourBlock: false });
    await store.createGroup(KEY, GROUP);
    await store.append(KEY, { k: 'v' });

    const read = (): Promise<readonly unknown[]> =>
      store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 10, blockMs: 0 });

    expect(await read()).toHaveLength(1);
    expect(await read()).toHaveLength(0);
  });

  it('keeps the cursor correct across a trim', async () => {
    // The bug this pins: an index-based cursor silently skips every entry that
    // shifted down when the cap evicted the front of the stream.
    const store = new MemoryStreamCommands({ honourBlock: false });
    await store.createGroup(KEY, GROUP);
    await store.append(KEY, { k: 'first' });
    await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 10, blockMs: 0 });

    await store.append(KEY, { k: 'second' }, { maxLen: 1 });

    const read = await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 10, blockMs: 0 });
    expect(read.map((entry) => entry.fields['k'])).toEqual(['second']);
  });

  it('increments the delivery count on a claim', async () => {
    const { store, advance } = clockedStore();
    await store.createGroup(KEY, GROUP);
    await store.append(KEY, { k: 'v' });
    await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 10, blockMs: 0 });

    advance(500);
    const [before] = await store.pendingEntries({ key: KEY, group: GROUP, minIdleMs: 0, count: 10 });
    expect(before).toMatchObject({ consumer: 'c1', deliveryCount: 1, idleMs: 500 });

    await store.claim({ key: KEY, group: GROUP, consumer: 'c2', minIdleMs: 100, ids: [before!.id] });

    const [after] = await store.pendingEntries({ key: KEY, group: GROUP, minIdleMs: 0, count: 10 });
    expect(after).toMatchObject({ consumer: 'c2', deliveryCount: 2, idleMs: 0 });
  });

  it('refuses a claim below the idle floor', async () => {
    const { store, advance } = clockedStore();
    await store.createGroup(KEY, GROUP);
    await store.append(KEY, { k: 'v' });
    const [entry] = await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 1, blockMs: 0 });

    advance(50);
    expect(
      await store.claim({ key: KEY, group: GROUP, consumer: 'c2', minIdleMs: 100, ids: [entry!.id] }),
    ).toEqual([]);
    expect(store.pending(KEY, GROUP)[0]?.consumer).toBe('c1');
  });

  it('drops a pending reference to a trimmed entry when it is claimed', async () => {
    const { store, advance } = clockedStore();
    await store.createGroup(KEY, GROUP);
    await store.append(KEY, { k: 'doomed' });
    const [entry] = await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 1, blockMs: 0 });

    await store.append(KEY, { k: 'survivor' }, { maxLen: 1 });
    advance(500);

    expect(
      await store.claim({ key: KEY, group: GROUP, consumer: 'c2', minIdleMs: 100, ids: [entry!.id] }),
    ).toEqual([]);
    expect(store.pending(KEY, GROUP)).toEqual([]);
  });

  it('destroys a consumer’s pending entries when it is deleted', async () => {
    const store = new MemoryStreamCommands({ honourBlock: false });
    await store.createGroup(KEY, GROUP);
    await store.append(KEY, { k: 'v' });
    await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 1, blockMs: 0 });

    expect(await store.consumerPendingCount(KEY, GROUP, 'c1')).toBe(1);
    expect(await store.deleteConsumer(KEY, GROUP, 'c1')).toBe(1);
    expect(store.pending(KEY, GROUP)).toEqual([]);
  });

  it('orders pending entries by sequence, not lexicographically', async () => {
    // `"1000-9" < "1000-10"` is false as strings and true in a stream, which
    // bites as soon as ten entries land in the same millisecond.
    const store = new MemoryStreamCommands({ now: () => 1_000, honourBlock: false });
    await store.createGroup(KEY, GROUP);
    for (let i = 0; i < 11; i += 1) await store.append(KEY, { k: String(i) });
    await store.readGroup({ key: KEY, group: GROUP, consumer: 'c1', count: 20, blockMs: 0 });

    const pending = await store.pendingEntries({ key: KEY, group: GROUP, minIdleMs: 0, count: 20 });
    const sequences = pending.map((entry) => Number(entry.id.split('-')[1]));

    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });
});

describe('memoryStreamConnections', () => {
  it('backs both connections with one store', async () => {
    const connections = memoryStreamConnections({ honourBlock: false });
    await connections.commands.createGroup(KEY, GROUP);
    await connections.commands.append(KEY, { k: 'v' });

    // Reading on one and acknowledging on the other has to work: the split
    // exists to stop a blocking read from delaying an ack on the same socket,
    // which is a property of connections and not of data.
    const [entry] = await connections.blocking.readGroup({
      key: KEY,
      group: GROUP,
      consumer: 'c1',
      count: 1,
      blockMs: 0,
    });

    expect(await connections.commands.ack(KEY, GROUP, [entry!.id])).toBe(1);
  });
});
