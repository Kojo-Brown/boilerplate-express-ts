import {
  createDeadLetterSink,
  deadLetterJobId,
  deadLetterQueueName,
} from '@/queue/dead-letter';
import type {
  DeadLetterRecord,
  DeadLetterStore,
  StoredDeadLetter,
  TerminalJobFailure,
} from '@/queue/dead-letter';
import { DeadLetterWriteError } from '@/queue/queue.errors';

const NOW = new Date('2026-09-06T12:00:00.000Z');

function failure(overrides: Partial<TerminalJobFailure> = {}): TerminalJobFailure {
  return {
    queueName: 'jobs',
    jobId: '42',
    jobName: 'email.send',
    data: { payload: { to: 'ada@example.test' }, correlationId: 'req-1' },
    attemptsMade: 5,
    enqueuedAt: Date.parse('2026-09-06T11:58:00.000Z'),
    failedAt: Date.parse('2026-09-06T11:59:30.000Z'),
    failedReason: 'Error: smtp unavailable',
    ...overrides,
  };
}

interface FakeStore extends DeadLetterStore {
  readonly added: { readonly record: DeadLetterRecord; readonly jobId: string }[];
  readonly evictions: number[];
}

function fakeStore(overrides: Partial<DeadLetterStore> = {}): FakeStore {
  const added: { record: DeadLetterRecord; jobId: string }[] = [];
  const evictions: number[] = [];
  const entries: StoredDeadLetter[] = [];

  return {
    added,
    evictions,
    add(record: DeadLetterRecord, jobId: string): Promise<void> {
      added.push({ record, jobId });
      return Promise.resolve();
    },
    evictOldest(maxSize: number): Promise<number> {
      evictions.push(maxSize);
      return Promise.resolve(0);
    },
    list(): Promise<readonly StoredDeadLetter[]> {
      return Promise.resolve(entries);
    },
    remove(): Promise<void> {
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe('deadLetterQueueName', () => {
  it('derives the companion name from the source queue', () => {
    // Derived rather than configured, so the producer, the worker and whatever
    // a person opens to read the records cannot end up at three different keys.
    expect(deadLetterQueueName('jobs')).toBe('jobs-dead-letter');
  });
});

describe('deadLetterJobId', () => {
  it('is stable for a source job, so a repeated transfer collapses', () => {
    expect(deadLetterJobId('jobs', '42')).toBe(deadLetterJobId('jobs', '42'));
    expect(deadLetterJobId('jobs', '42')).not.toBe(deadLetterJobId('jobs', '43'));
  });

  it('never produces an id BullMQ reserves for its own list markers', () => {
    // BullMQ rejects `0` and anything starting `0:`. A source queue literally
    // named `0` is unlikely and the prefix costs nothing.
    expect(deadLetterJobId('0', '1').startsWith('0:')).toBe(false);
  });
});

describe('createDeadLetterSink', () => {
  it('unwraps the envelope so the record holds the payload, not the wrapper', async () => {
    const store = fakeStore();
    const sink = createDeadLetterSink({ store, now: () => NOW });

    await sink(failure());

    expect(store.added[0]?.record).toEqual<DeadLetterRecord>({
      sourceQueue: 'jobs',
      sourceJobId: '42',
      jobName: 'email.send',
      attemptsMade: 5,
      failedReason: 'Error: smtp unavailable',
      correlationId: 'req-1',
      payload: { to: 'ada@example.test' },
      enqueuedAt: '2026-09-06T11:58:00.000Z',
      failedAt: '2026-09-06T11:59:30.000Z',
      deadLetteredAt: NOW.toISOString(),
    });
  });

  it('stores data that is not an envelope as the payload rather than failing', async () => {
    const store = fakeStore();
    const sink = createDeadLetterSink({ store, now: () => NOW });

    // Tolerant on purpose: this runs on data that has already caused one
    // failure, and "we could not parse the payload, here it is" beats a sink
    // that throws while trying to describe it.
    await sink(failure({ data: 'not-an-envelope' }));

    expect(store.added[0]?.record.payload).toBe('not-an-envelope');
    expect(store.added[0]?.record.correlationId).toBeNull();
  });

  it('applies the redactor before the record is stored', async () => {
    const store = fakeStore();
    const sink = createDeadLetterSink({
      store,
      now: () => NOW,
      redact: (jobName, payload) =>
        jobName === 'email.send' ? { ...(payload as object), to: '[redacted]' } : payload,
    });

    await sink(failure());

    // Redaction has to happen on the way *in*: a dead-letter record is the
    // longest-lived copy of a payload in the system, and nothing reads it again
    // before a person does.
    expect(store.added[0]?.record.payload).toEqual({ to: '[redacted]' });
  });

  it('trims to the bound after adding, not before', async () => {
    const store = fakeStore();
    const sink = createDeadLetterSink({ store, maxSize: 3, now: () => NOW });

    await sink(failure());

    // Before the add, a burst arriving together would be trimmed to one below
    // the bound and then pushed back over it.
    expect(store.evictions).toEqual([3]);
    expect(store.added).toHaveLength(1);
  });

  it('reports a failed write instead of throwing at the worker', async () => {
    const errors: DeadLetterWriteError[] = [];
    const store = fakeStore({
      add: () => Promise.reject(new Error('redis is down')),
    });
    const sink = createDeadLetterSink({ store, onError: (error) => errors.push(error) });

    // The sink is called from an `EventEmitter` callback with nobody to catch
    // it, so a throw here is an unhandled rejection rather than anything an
    // operator can act on. The job is still in the failed set either way.
    await expect(sink(failure())).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(DeadLetterWriteError);
    expect(errors[0]?.cause).toEqual(new Error('redis is down'));
    expect(errors[0]?.jobId).toBe('42');
  });

  it('reports a failed trim the same way', async () => {
    const errors: DeadLetterWriteError[] = [];
    const store = fakeStore({
      evictOldest: () => Promise.reject(new Error('eviction failed')),
    });
    const sink = createDeadLetterSink({ store, onError: (error) => errors.push(error) });

    await expect(sink(failure())).resolves.toBeUndefined();

    // The record was written; only the housekeeping failed.
    expect(store.added).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('rejects a bound it could not honour', () => {
    expect(() => createDeadLetterSink({ store: fakeStore(), maxSize: 0 })).toThrow(RangeError);
  });
});
