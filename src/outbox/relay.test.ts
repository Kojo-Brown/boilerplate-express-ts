const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('@/db/pool', () => ({
  getPool: () => ({ connect: (...args: unknown[]) => mockConnect(...args) }),
}));

import type { DomainEventPayloads } from '@/events/domain-events';
import { OutboxDispatchTimeoutError } from '@/outbox/outbox.errors';
import type { OutboxDispatcher, OutboxMessage, OutboxStore } from '@/outbox/outbox.types';
import { runOutboxBatch, runOutboxRelay, startOutboxRelay } from '@/outbox/relay';

type Store = OutboxStore<DomainEventPayloads>;

interface FakeStore {
  store: Store;
  claimDue: jest.Mock;
  remove: jest.Mock;
  reschedule: jest.Mock;
  deadLetter: jest.Mock;
}

function fakeStore(batches: OutboxMessage[][]): FakeStore {
  const queued = [...batches];
  const claimDue = jest.fn(async () => queued.shift() ?? []);
  const remove = jest.fn(async () => undefined);
  const reschedule = jest.fn(async () => undefined);
  const deadLetter = jest.fn(async () => undefined);

  return {
    claimDue,
    remove,
    reschedule,
    deadLetter,
    store: {
      enqueue: () => {
        throw new Error('the relay does not enqueue');
      },
      claimDue,
      remove,
      reschedule,
      deadLetter,
    } as unknown as Store,
  };
}

function message(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    id: 'message-1',
    name: 'user.created',
    payload: { userId: 'user-uuid-1' },
    correlationId: null,
    occurredAt: new Date('2026-08-25T10:00:00Z'),
    attempts: 0,
    ...overrides,
  };
}

const deliver: OutboxDispatcher = async () => undefined;

function failWith(error: Error): OutboxDispatcher {
  return async () => {
    throw error;
  };
}

/** The jitter, pinned: `fullJitterDelay` draws from `[0, cap)`. */
const noJitter = (): number => 0.999_999;

function sqlSent(): string[] {
  return mockClientQuery.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockConnect.mockReset();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  mockClientQuery.mockResolvedValue({ rows: [] });
});

describe('runOutboxBatch', () => {
  it('claims, delivers and deletes, all inside one transaction', async () => {
    const fake = fakeStore([[message()]]);

    await expect(
      runOutboxBatch({ store: fake.store, dispatcher: deliver }),
    ).resolves.toEqual({ claimed: 1, delivered: 1, rescheduled: 0, deadLettered: 0 });

    // The delete has to run in the transaction that took the row lock: after a
    // commit the lock is gone and another relay may already hold the row.
    const [claimTx] = fake.claimDue.mock.calls[0] as [unknown];
    const [removeTx] = fake.remove.mock.calls[0] as [unknown];
    expect(removeTx).toBe(claimTx);
    expect(sqlSent()).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
  });

  it('bounds how long a statement waits on a lock', async () => {
    await runOutboxBatch({ store: fakeStore([[]]).store, dispatcher: deliver });

    // A blocked statement holds its pooled connection long after the tick that
    // issued it stopped mattering.
    expect(sqlSent()).toContain("SET LOCAL lock_timeout = '5000ms'");
  });

  it('reschedules a failed delivery with a jittered, growing delay', async () => {
    const fake = fakeStore([[message({ attempts: 2 })]]);

    await expect(
      runOutboxBatch({
        store: fake.store,
        dispatcher: failWith(new Error('sink unreachable')),
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        random: noJitter,
      }),
    ).resolves.toEqual({ claimed: 1, delivered: 0, rescheduled: 1, deadLettered: 0 });

    // Third attempt: base * 2^(3-1) = 400ms, and the row keeps the reason.
    const [, id, delayMs, reason] = fake.reschedule.mock.calls[0] as [
      unknown,
      string,
      number,
      string,
    ];
    expect(id).toBe('message-1');
    // `fullJitterDelay` draws from `[0, cap)`, so the pinned draw lands just
    // under the ceiling: floor(0.999999 * 400).
    expect(delayMs).toBe(399);
    expect(reason).toBe('Error: sink unreachable');
    expect(fake.remove).not.toHaveBeenCalled();
  });

  it('caps the delay so a long-failing message is still retried this hour', async () => {
    const fake = fakeStore([[message({ attempts: 20 })]]);

    await runOutboxBatch({
      store: fake.store,
      dispatcher: failWith(new Error('down')),
      maxAttempts: 100,
      baseDelayMs: 500,
      maxDelayMs: 60_000,
      random: noJitter,
    });

    const [, , delayMs] = fake.reschedule.mock.calls[0] as [unknown, string, number];
    // 500 * 2^20 is nine minutes; the ceiling is what keeps a message that has
    // been failing all morning from being retried once an hour.
    expect(delayMs).toBe(59_999);
  });

  it('dead-letters a message that has used its last attempt', async () => {
    const fake = fakeStore([[message({ attempts: 7 })]]);

    await expect(
      runOutboxBatch({
        store: fake.store,
        dispatcher: failWith(new Error('still down')),
        maxAttempts: 8,
      }),
    ).resolves.toEqual({ claimed: 1, delivered: 0, rescheduled: 0, deadLettered: 1 });

    expect(fake.reschedule).not.toHaveBeenCalled();
    expect(fake.deadLetter).toHaveBeenCalledWith(
      expect.anything(),
      'message-1',
      'Error: still down',
    );
  });

  it('keeps going after one message fails — a poison row does not cost the batch', async () => {
    const fake = fakeStore([[message({ id: 'bad' }), message({ id: 'good' })]]);
    const dispatcher: OutboxDispatcher = async (msg) => {
      if (msg.id === 'bad') throw new Error('nope');
    };

    await expect(runOutboxBatch({ store: fake.store, dispatcher })).resolves.toEqual({
      claimed: 2,
      delivered: 1,
      rescheduled: 1,
      deadLettered: 0,
    });
    expect(fake.remove).toHaveBeenCalledWith(expect.anything(), 'good');
  });

  it('gives up waiting on a dispatcher that does not return', async () => {
    const fake = fakeStore([[message()]]);
    // Never settles: the case the timeout exists for. Note what it does *not*
    // do — the work is still running, so a message that eventually lands has
    // been delivered once and will be delivered again. At-least-once, exactly.
    const dispatcher: OutboxDispatcher = () => new Promise<void>(() => undefined);

    await expect(
      runOutboxBatch({ store: fake.store, dispatcher, dispatchTimeoutMs: 20 }),
    ).resolves.toMatchObject({ rescheduled: 1 });

    const [, , , reason] = fake.reschedule.mock.calls[0] as [unknown, string, number, string];
    expect(reason).toContain(new OutboxDispatchTimeoutError('message-1', 'user.created', 20).name);
  });

  it('does not leave a late dispatcher rejection unhandled', async () => {
    const fake = fakeStore([[message()]]);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const dispatcher: OutboxDispatcher = () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error('arrived late')), 10);
        });

      await runOutboxBatch({ store: fake.store, dispatcher, dispatchTimeoutMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('lets a store failure abort the batch rather than swallowing it', async () => {
    const fake = fakeStore([[message()]]);
    fake.remove.mockRejectedValue(new Error('connection lost'));

    // Unlike a dispatcher failure, this leaves the transaction in doubt: every
    // mark in the batch rolls back with it, and the messages are re-claimed.
    await expect(
      runOutboxBatch({ store: fake.store, dispatcher: deliver }),
    ).rejects.toThrow('connection lost');
    expect(sqlSent()).toContain('ROLLBACK');
  });

  it('rejects a maxAttempts that is not a positive integer', async () => {
    await expect(
      runOutboxBatch({ store: fakeStore([]).store, dispatcher: deliver, maxAttempts: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('runOutboxRelay', () => {
  it('keeps claiming while batches come back full', async () => {
    const full = [message({ id: 'a' }), message({ id: 'b' })];
    const fake = fakeStore([full, full, [message({ id: 'c' })]]);

    await expect(
      runOutboxRelay({ store: fake.store, dispatcher: deliver, batchSize: 2 }),
    ).resolves.toEqual({ claimed: 5, delivered: 5, rescheduled: 0, deadLettered: 0 });
    expect(fake.claimDue).toHaveBeenCalledTimes(3);
  });

  it('stops on the first short batch', async () => {
    const fake = fakeStore([[message()], [message()]]);

    await runOutboxRelay({ store: fake.store, dispatcher: deliver, batchSize: 5 });

    // A short batch is either an empty queue or rows another relay is holding.
    // Both mean there is nothing here this tick should still be doing.
    expect(fake.claimDue).toHaveBeenCalledTimes(1);
  });

  it('yields after maxBatchesPerTick however long the backlog is', async () => {
    const full = [message()];
    const fake = fakeStore([full, full, full, full, full, full]);

    await runOutboxRelay({
      store: fake.store,
      dispatcher: deliver,
      batchSize: 1,
      maxBatchesPerTick: 2,
    });

    expect(fake.claimDue).toHaveBeenCalledTimes(2);
  });

  it('rejects a maxBatchesPerTick that is not a positive integer', async () => {
    await expect(
      runOutboxRelay({
        store: fakeStore([]).store,
        dispatcher: deliver,
        maxBatchesPerTick: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('startOutboxRelay', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('polls on the interval and reports each tick', async () => {
    const fake = fakeStore([[message()]]);
    const onOutcome = jest.fn();
    const job = startOutboxRelay({
      store: fake.store,
      dispatcher: deliver,
      intervalMs: 1_000,
      onOutcome,
    });

    await jest.advanceTimersByTimeAsync(1_000);
    jest.useRealTimers();
    await job.stop();

    expect(onOutcome).toHaveBeenCalledWith({
      claimed: 1,
      delivered: 1,
      rescheduled: 0,
      deadLettered: 0,
    });
  });

  it('never overlaps two ticks in one process', async () => {
    const fake = fakeStore([[message()], [message()]]);
    let release: (() => void) | undefined;
    const dispatcher: OutboxDispatcher = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const job = startOutboxRelay({
      store: fake.store,
      dispatcher,
      intervalMs: 1_000,
      onOutcome: () => undefined,
    });

    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(1_000);

    // Two ticks on one replica take two different pooled connections, so
    // `SKIP LOCKED` does not keep them apart — they would both claim, both
    // dispatch, and deliver everything twice for no reason.
    expect(fake.claimDue).toHaveBeenCalledTimes(1);

    release?.();
    jest.useRealTimers();
    await job.stop();
  });

  it('swallows a tick failure rather than taking the process down', async () => {
    const fake = fakeStore([[]]);
    fake.claimDue.mockRejectedValue(new Error('database unreachable'));
    const onError = jest.fn();

    const job = startOutboxRelay({
      store: fake.store,
      dispatcher: deliver,
      intervalMs: 1_000,
      onError,
    });

    await jest.advanceTimersByTimeAsync(1_000);
    jest.useRealTimers();
    await job.stop();

    // An unhandled rejection from a timer callback is attributable to no
    // request and, under Node's default, kills a service that is otherwise
    // answering fine.
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'database unreachable' }));
  });

  it('stop() waits for the tick in flight to commit', async () => {
    const fake = fakeStore([[message()]]);
    let release: (() => void) | undefined;
    const dispatcher: OutboxDispatcher = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const job = startOutboxRelay({
      store: fake.store,
      dispatcher,
      intervalMs: 1_000,
      onOutcome: () => undefined,
    });

    await jest.advanceTimersByTimeAsync(1_000);
    jest.useRealTimers();

    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // A tick killed mid-batch has dispatched messages whose deletes are about
    // to roll back, and every one of them is redelivered by the next replica.
    expect(stopped).toBe(false);

    release?.();
    await stopping;
    expect(stopped).toBe(true);
    expect(fake.remove).toHaveBeenCalled();
  });

  it('does not hold the process open', () => {
    const unref = jest.fn();
    const setIntervalSpy = jest
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    startOutboxRelay({ store: fakeStore([]).store, dispatcher: deliver, intervalMs: 1_000 });

    // A relay is the least important thing in the process to be deciding when
    // it exits.
    expect(unref).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('rejects an interval that is not a positive integer', () => {
    expect(() =>
      startOutboxRelay({ store: fakeStore([]).store, dispatcher: deliver, intervalMs: 0 }),
    ).toThrow(RangeError);
  });
});
