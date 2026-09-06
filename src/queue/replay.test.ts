import type {
  DeadLetterRecord,
  DeadLetterStore,
  StoredDeadLetter,
} from '@/queue/dead-letter';
import { createJobProducer } from '@/queue/producer';
import type { JobQueueWriter } from '@/queue/producer';
import type { JobEnvelope } from '@/queue/queue.types';
import { replayDeadLetters } from '@/queue/replay';

type TestJobs = {
  'email.send': { to: string };
  'report.export': { reportId: string };
};

function record(overrides: Partial<DeadLetterRecord> = {}): DeadLetterRecord {
  return {
    sourceQueue: 'jobs',
    sourceJobId: '42',
    jobName: 'email.send',
    attemptsMade: 5,
    failedReason: 'Error: smtp unavailable',
    correlationId: null,
    payload: { to: 'ada@example.test' },
    enqueuedAt: '2026-09-06T11:58:00.000Z',
    failedAt: '2026-09-06T11:59:30.000Z',
    deadLetteredAt: '2026-09-06T12:00:00.000Z',
    ...overrides,
  };
}

interface FakeStore extends DeadLetterStore {
  readonly removed: string[];
}

function fakeStore(entries: StoredDeadLetter[]): FakeStore {
  const removed: string[] = [];

  return {
    removed,
    add: () => Promise.resolve(),
    evictOldest: () => Promise.resolve(0),
    list: (limit: number) => Promise.resolve(entries.slice(0, limit)),
    remove: (entryId: string) => {
      removed.push(entryId);
      return Promise.resolve();
    },
  };
}

interface Written {
  readonly jobName: string;
  readonly data: JobEnvelope;
}

function recordingWriter(
  overrides: Partial<JobQueueWriter> = {},
): JobQueueWriter & { readonly writes: Written[] } {
  const writes: Written[] = [];

  return {
    name: 'jobs',
    writes,
    add(jobName: string, data: JobEnvelope): Promise<string> {
      writes.push({ jobName, data });
      return Promise.resolve(`id-${String(writes.length)}`);
    },
    close: () => Promise.resolve(),
    ...overrides,
  };
}

function producerFor(queue: JobQueueWriter) {
  return createJobProducer<TestJobs>({
    queue,
    retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
  });
}

describe('replayDeadLetters', () => {
  it('puts the stored payload back on the source queue', async () => {
    const queue = recordingWriter();
    const store = fakeStore([{ entryId: 'dlq:jobs:42', record: record() }]);

    const outcome = await replayDeadLetters({ store, producer: producerFor(queue) });

    expect(outcome).toEqual({ examined: 1, replayed: 1, skipped: 0, failed: 0 });
    expect(queue.writes).toEqual([
      { jobName: 'email.send', data: { payload: { to: 'ada@example.test' }, correlationId: null } },
    ]);
  });

  it('carries the original correlation id onto the replayed job', async () => {
    const queue = recordingWriter();
    const store = fakeStore([
      { entryId: 'dlq:jobs:42', record: record({ correlationId: 'req-7' }) },
    ]);

    await replayDeadLetters({ store, producer: producerFor(queue) });

    expect(queue.writes[0]?.data.correlationId).toBe('req-7');
  });

  it('removes the record only after the re-enqueue has resolved', async () => {
    const order: string[] = [];
    const queue = recordingWriter({
      add: () => {
        order.push('enqueue');
        return Promise.resolve('id-1');
      },
    });
    const store = fakeStore([{ entryId: 'dlq:jobs:42', record: record() }]);
    const tracked: DeadLetterStore = {
      ...store,
      remove: (entryId) => {
        order.push('remove');
        return store.remove(entryId);
      },
    };

    await replayDeadLetters({ store: tracked, producer: producerFor(queue) });

    // A crash between them must leave a dead letter that gets replayed twice,
    // not one that is deleted and never run. Handlers are required to be
    // idempotent; nothing recovers a lost record.
    expect(order).toEqual(['enqueue', 'remove']);
  });

  it('leaves the record in place when the re-enqueue fails', async () => {
    const queue = recordingWriter({ add: () => Promise.reject(new Error('redis is down')) });
    const store = fakeStore([{ entryId: 'dlq:jobs:42', record: record() }]);

    const outcome = await replayDeadLetters({
      store,
      producer: producerFor(queue),
      onError: () => undefined,
    });

    expect(outcome).toEqual({ examined: 1, replayed: 0, skipped: 0, failed: 1 });
    expect(store.removed).toEqual([]);
  });

  it('replays only the names asked for', async () => {
    const queue = recordingWriter();
    const store = fakeStore([
      { entryId: 'a', record: record({ jobName: 'email.send' }) },
      { entryId: 'b', record: record({ jobName: 'report.export', payload: { reportId: 'r-1' } }) },
    ]);

    const outcome = await replayDeadLetters({
      store,
      producer: producerFor(queue),
      only: ['report.export'],
    });

    expect(outcome).toEqual({ examined: 2, replayed: 1, skipped: 1, failed: 0 });
    expect(queue.writes.map((write) => write.jobName)).toEqual(['report.export']);
    expect(store.removed).toEqual(['b']);
  });

  it('one failure does not stop the entries behind it', async () => {
    let call = 0;
    const queue = recordingWriter({
      add: () => {
        call += 1;
        return call === 1 ? Promise.reject(new Error('transient')) : Promise.resolve('id');
      },
    });
    const store = fakeStore([
      { entryId: 'a', record: record() },
      { entryId: 'b', record: record({ sourceJobId: '43' }) },
    ]);

    const outcome = await replayDeadLetters({
      store,
      producer: producerFor(queue),
      onError: () => undefined,
    });

    expect(outcome).toEqual({ examined: 2, replayed: 1, skipped: 0, failed: 1 });
    expect(store.removed).toEqual(['b']);
  });

  it('reports each failure with the entry it belonged to', async () => {
    const seen: string[] = [];
    const queue = recordingWriter({ add: () => Promise.reject(new Error('nope')) });
    const store = fakeStore([{ entryId: 'a', record: record() }]);

    await replayDeadLetters({
      store,
      producer: producerFor(queue),
      onError: (_error, entry) => seen.push(entry.entryId),
    });

    expect(seen).toEqual(['a']);
  });

  it('honours the limit it was given', async () => {
    const queue = recordingWriter();
    const store = fakeStore([
      { entryId: 'a', record: record() },
      { entryId: 'b', record: record() },
      { entryId: 'c', record: record() },
    ]);

    const outcome = await replayDeadLetters({ store, producer: producerFor(queue), limit: 2 });

    expect(outcome.examined).toBe(2);
  });

  it.each([0, -1, 1.5])('rejects a limit of %p', async (limit) => {
    await expect(
      replayDeadLetters({ store: fakeStore([]), producer: producerFor(recordingWriter()), limit }),
    ).rejects.toThrow(RangeError);
  });
});
