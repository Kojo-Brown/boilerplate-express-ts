import { randomUUID } from 'node:crypto';
import { createDeadLetterQueue, createJobQueue, jobQueueConnection } from '@/queue/bull';
import {
  createBullDeadLetterStore,
  createDeadLetterSink,
  deadLetterJobId,
} from '@/queue/dead-letter';
import type { DeadLetterRecord, DeadLetterStore, TerminalJobFailure } from '@/queue/dead-letter';
import { createJobProducer, toJobQueueWriter } from '@/queue/producer';
import type { JobProducer } from '@/queue/producer';
import { UnprocessableJobError } from '@/queue/queue.errors';
import type { JobHandlers } from '@/queue/queue.types';
import { replayDeadLetters } from '@/queue/replay';
import type { RetryPolicy } from '@/queue/retry';
import { createJobQueueWorker } from '@/queue/worker';

/**
 * The claims that are about **BullMQ** rather than about our code.
 *
 * Everything asserted here is behaviour the design leans on and that a fake
 * could only echo back: that a custom backoff strategy registered on the
 * *worker* is the one BullMQ actually calls, that the delay it returns is what
 * lands on the delayed job, that `finishedOn` is set on the last attempt and
 * not on the ones before it, that an `UnrecoverableError` subclass really does
 * skip the ladder, that a duplicate `jobId` is silently not added, and that
 * reading the wait list with `asc` yields the oldest entries — which is what
 * `evictOldest` relies on to drop the right end.
 *
 * Proving any of those against a stub would prove only what its author
 * believed. The unit suites cover the decisions; this covers the assumptions.
 *
 * Skipped without `REDIS_TEST_URL`, so a contributor with no Redis can still
 * run `pnpm test`. `redis.guard.test.ts` is what keeps that convenience from
 * silently applying in CI — it fails the build if `CI` is set and the variable
 * is not.
 */
const url = process.env['REDIS_TEST_URL'] ?? '';
const describeRedis = url === '' ? describe.skip : describe;

type TestJobs = {
  'work.do': { id: string };
};

/** Pinned so a delay this suite asserts on is a number and not a range. */
const ALWAYS_MAX = (): number => 0.999_999;

/** Long enough that a retry never fires mid-assertion; the ladder is asserted, not waited out. */
const SLOW_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 2_000, maxDelayMs: 2_000 };
/** Short enough that three attempts and a dead-letter finish inside a test. */
const FAST_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 20, maxDelayMs: 20 };

async function until(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for: ${what}`);
}

describeRedis('BullMQ job queue against a real server', () => {
  const connection = jobQueueConnection(url);
  const teardown: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    // Reverse order: workers before the queues they read, queues before the
    // keys are obliterated.
    for (const close of teardown.reverse()) await close();
    teardown.length = 0;
  });

  interface Harness {
    readonly queueName: string;
    readonly producer: JobProducer<TestJobs>;
    readonly store: DeadLetterStore;
    readonly deadLetterCount: () => Promise<number>;
    readonly deadLetters: () => Promise<readonly DeadLetterRecord[]>;
    readonly sourceCounts: () => Promise<Record<string, number>>;
    readonly delayedDelays: () => Promise<readonly (number | undefined)[]>;
    readonly startWorker: (
      handlers: JobHandlers<TestJobs>,
      retry?: RetryPolicy,
    ) => Promise<void>;
  }

  function harness(): Harness {
    const queueName = `test-jobs-${randomUUID()}`;
    const noop = (): void => undefined;

    const queue = createJobQueue({ connection, queueName, onError: noop });
    const deadLetterQueue = createDeadLetterQueue({ connection, queueName, onError: noop });

    teardown.push(async () => {
      await queue.obliterate({ force: true });
      await deadLetterQueue.obliterate({ force: true });
      await queue.close();
      await deadLetterQueue.close();
    });

    const store = createBullDeadLetterStore(deadLetterQueue);
    const producer = createJobProducer<TestJobs>({
      queue: toJobQueueWriter(queue),
      retry: SLOW_RETRY,
    });

    return {
      queueName,
      producer,
      store,
      deadLetterCount: () => deadLetterQueue.getJobCountByTypes('wait'),
      deadLetters: async () =>
        (await deadLetterQueue.getJobs(['wait'], 0, 99, true)).map((job) => job.data),
      sourceCounts: () => queue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed'),
      delayedDelays: async () => (await queue.getJobs(['delayed'], 0, 9)).map((job) => job.delay),
      async startWorker(handlers: JobHandlers<TestJobs>, retry: RetryPolicy = SLOW_RETRY) {
        const worker = createJobQueueWorker<TestJobs>({
          connection,
          queueName,
          handlers,
          retry,
          deadLetter: createDeadLetterSink({ store, onError: noop }),
          lockDurationMs: 5_000,
          random: ALWAYS_MAX,
          onFailedAttempt: noop,
          onError: noop,
        });
        // Unshifted rather than pushed: the reversed teardown then closes the
        // worker before the queues it reads from.
        teardown.unshift(() => worker.close());
        await worker.start();
      },
    };
  }

  it('runs a job once and dead-letters nothing', async () => {
    const h = harness();
    const seen: string[] = [];

    await h.startWorker({
      'work.do': (payload) => {
        seen.push(payload.id);
        return Promise.resolve();
      },
    });

    await h.producer.enqueue('work.do', { id: 'a' });

    await until(async () => (await h.sourceCounts())['completed'] === 1, 'the job to complete');

    expect(seen).toEqual(['a']);
    expect(await h.deadLetterCount()).toBe(0);
  });

  it('delays a retry by exactly what the worker strategy returned', async () => {
    const h = harness();

    await h.startWorker({
      'work.do': () => Promise.reject(new Error('always fails')),
    });

    await h.producer.enqueue('work.do', { id: 'a' });

    await until(async () => (await h.sourceCounts())['delayed'] === 1, 'the first retry to be scheduled');

    // The strategy is registered on the *worker* — `Job#shouldRetryJob` reads
    // it off the options of the queue instance that is processing the job, so a
    // producer registering it registers it on the wrong object. Drawing from a
    // window of `min(2000, 2000 * 2^0)` with the jitter pinned at its top gives
    // 1999 and nothing else does: BullMQ's default with no strategy is an
    // immediate retry, and its own `exponential` would need a `delay` this
    // never sets.
    expect(await h.delayedDelays()).toEqual([1_999]);
  });

  it('dead-letters the job after its last attempt, and not before', async () => {
    const h = harness();
    let runs = 0;

    await h.startWorker(
      {
        'work.do': () => {
          runs += 1;
          return Promise.reject(new Error('smtp unavailable'));
        },
      },
      FAST_RETRY,
    );

    await h.producer.enqueue('work.do', { id: 'a' }, { correlationId: 'req-1' });

    await until(async () => (await h.deadLetterCount()) === 1, 'the job to be dead-lettered');

    // Three runs, one record. The `failed` event fires on each of them, so the
    // count is the assertion that `finishedOn` is telling the last one apart.
    expect(runs).toBe(3);

    const [dead] = await h.deadLetters();
    expect(dead).toMatchObject<Partial<DeadLetterRecord>>({
      sourceQueue: h.queueName,
      jobName: 'work.do',
      attemptsMade: 3,
      failedReason: 'Error: smtp unavailable',
      correlationId: 'req-1',
      payload: { id: 'a' },
    });

    // The source job is still in the failed set: the dead-letter queue is an
    // index over it, not a replacement for it, and that is what makes a missed
    // transfer recoverable rather than data loss.
    expect((await h.sourceCounts())['failed']).toBe(1);
  }, 15_000);

  it('lets an unprocessable failure skip the ladder entirely', async () => {
    const h = harness();
    let runs = 0;

    await h.startWorker({
      'work.do': () => {
        runs += 1;
        return Promise.reject(new UnprocessableJobError('the user no longer exists'));
      },
    });

    await h.producer.enqueue('work.do', { id: 'a' });

    await until(async () => (await h.deadLetterCount()) === 1, 'the job to be dead-lettered');

    // One run out of three allowed. This is the property that makes
    // `UnprocessableJobError` worth subclassing `UnrecoverableError` for:
    // BullMQ's check happens inside its own failure path, where our code does
    // not run, so `instanceof` is the only thing that reaches it.
    expect(runs).toBe(1);

    const [dead] = await h.deadLetters();
    expect(dead?.attemptsMade).toBe(1);
    expect(dead?.failedReason).toBe('UnprocessableJobError: the user no longer exists');
  });

  it('collapses a repeated transfer of the same job onto one record', async () => {
    const h = harness();
    const sink = createDeadLetterSink({ store: h.store, onError: () => undefined });

    const failure: TerminalJobFailure = {
      queueName: h.queueName,
      jobId: '7',
      jobName: 'work.do',
      data: { payload: { id: 'a' }, correlationId: null },
      attemptsMade: 3,
      enqueuedAt: Date.now() - 1_000,
      failedAt: Date.now(),
      failedReason: 'Error: nope',
    };

    await sink(failure);
    await sink(failure);

    // BullMQ silently does not add a second job under an id already present,
    // which is the whole mechanism behind the transfer being idempotent — a job
    // re-processed after a stall and failed again produces one record.
    expect(await h.deadLetterCount()).toBe(1);
    expect(deadLetterJobId(h.queueName, '7')).toContain('7');
  });

  it('evicts the oldest records, not the newest', async () => {
    const h = harness();
    const sink = createDeadLetterSink({ store: h.store, maxSize: 2, onError: () => undefined });

    for (const id of ['first', 'second', 'third']) {
      await sink({
        queueName: h.queueName,
        jobId: id,
        jobName: 'work.do',
        data: { payload: { id }, correlationId: null },
        attemptsMade: 3,
        enqueuedAt: Date.now(),
        failedAt: Date.now(),
        failedReason: 'Error: nope',
      });
    }

    // `evictOldest` reads the wait list with `asc`, which takes from the end a
    // worker would take from. That the end is the *oldest* is a property of
    // BullMQ's list discipline rather than of its documented API, so it is
    // asserted here rather than assumed in a comment.
    expect(await h.deadLetterCount()).toBe(2);
    expect((await h.deadLetters()).map((record) => record.sourceJobId)).toEqual([
      'second',
      'third',
    ]);
  });

  it('replays a record back onto the source queue, where it runs', async () => {
    const h = harness();
    const outcomes: string[] = [];
    let failNext = true;

    await h.startWorker(
      {
        'work.do': (payload) => {
          if (failNext) return Promise.reject(new Error('dependency down'));
          outcomes.push(payload.id);
          return Promise.resolve();
        },
      },
      FAST_RETRY,
    );

    await h.producer.enqueue('work.do', { id: 'a' });
    await until(async () => (await h.deadLetterCount()) === 1, 'the job to be dead-lettered');

    // The dependency comes back.
    failNext = false;

    const outcome = await replayDeadLetters({ store: h.store, producer: h.producer });

    expect(outcome).toEqual({ examined: 1, replayed: 1, skipped: 0, failed: 0 });
    await until(() => Promise.resolve(outcomes.length === 1), 'the replayed job to run');
    expect(outcomes).toEqual(['a']);
    expect(await h.deadLetterCount()).toBe(0);
  }, 15_000);

  it('does not add a second job under a job id already present', async () => {
    const h = harness();

    await h.producer.enqueue('work.do', { id: 'a' }, { jobId: 'once' });
    await h.producer.enqueue('work.do', { id: 'a' }, { jobId: 'once' });

    // What makes `createQueuedMagicLinkDelivery`'s derived id an idempotency
    // key rather than a label.
    expect((await h.sourceCounts())['wait']).toBe(1);
  });

  it('finishes the job in flight before close resolves', async () => {
    const h = harness();
    let finished = false;

    await h.startWorker({
      'work.do': async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        finished = true;
      },
    });

    await h.producer.enqueue('work.do', { id: 'a' });
    await until(async () => (await h.sourceCounts())['active'] === 1, 'the job to start');

    // The teardown runs `worker.close()`, but the point is worth asserting
    // where it is visible: a handler killed mid-job leaves the job locked until
    // it stalls, at which point another worker runs it again — paying for a
    // second of shutdown in duplicate side effects.
    for (const close of teardown.splice(0, 1)) await close();

    expect(finished).toBe(true);
  }, 15_000);
});
