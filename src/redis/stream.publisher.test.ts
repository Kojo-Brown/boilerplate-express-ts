import { MemoryStreamCommands } from '@/redis/stream.memory';
import { createStreamPublisher } from '@/redis/stream.publisher';
import { decodeEnvelope } from '@/redis/stream.envelope';
import type { StreamEventEnvelope } from '@/redis/stream.envelope';
import type { AppendOptions, StreamCommands } from '@/redis/stream.types';

const KEY = 'test-events';

const envelope: StreamEventEnvelope = {
  id: 'event-1',
  name: 'user.created',
  occurredAt: new Date('2026-09-04T10:00:00.000Z'),
  correlationId: 'corr-1',
  payload: { userId: 'user-1' },
};

describe('createStreamPublisher', () => {
  it('rejects a missing or nonsensical cap at construction', () => {
    const commands = new MemoryStreamCommands();

    // Not merely a validation nicety: an unbounded stream grows for the life of
    // the service, because acknowledging an entry does not remove it.
    expect(() => createStreamPublisher({ commands, key: KEY, maxLen: 0 })).toThrow(RangeError);
    expect(() => createStreamPublisher({ commands, key: KEY, maxLen: -1 })).toThrow(RangeError);
    expect(() => createStreamPublisher({ commands, key: KEY, maxLen: 1.5 })).toThrow(RangeError);
  });

  it('appends an envelope that decodes back to itself', async () => {
    const commands = new MemoryStreamCommands();
    const publisher = createStreamPublisher({ commands, key: KEY, maxLen: 100 });

    const id = await publisher.publish(envelope);
    const [entry] = commands.entries(KEY);

    expect(id).toMatch(/^\d+-\d+$/);
    expect(entry).toBeDefined();
    expect(decodeEnvelope(entry!)).toEqual(envelope);
  });

  it('passes the cap on every append, approximately by default', async () => {
    const seen: (AppendOptions | undefined)[] = [];
    const recording: StreamCommands = {
      append: (_key, _fields, options) => {
        seen.push(options);
        return Promise.resolve('1-1');
      },
      createGroup: () => Promise.resolve('exists'),
      readGroup: () => Promise.resolve([]),
      ack: () => Promise.resolve(0),
      pendingEntries: () => Promise.resolve([]),
      claim: () => Promise.resolve([]),
      consumerPendingCount: () => Promise.resolve(0),
      deleteConsumer: () => Promise.resolve(0),
    };

    await createStreamPublisher({ commands: recording, key: KEY, maxLen: 500 }).publish(envelope);
    await createStreamPublisher({ commands: recording, key: KEY, maxLen: 500, exactTrim: true }).publish(
      envelope,
    );

    // `~` is the default because exact trimming makes every XADD pay for a
    // radix-tree node split.
    expect(seen[0]).toEqual({ maxLen: 500, approximate: true });
    expect(seen[1]).toEqual({ maxLen: 500, approximate: false });
  });

  it('keeps the stream at its cap', async () => {
    const commands = new MemoryStreamCommands();
    const publisher = createStreamPublisher({ commands, key: KEY, maxLen: 3 });

    for (let i = 0; i < 10; i += 1) await publisher.publish({ ...envelope, id: `event-${i}` });

    expect(commands.entries(KEY)).toHaveLength(3);
  });
});
