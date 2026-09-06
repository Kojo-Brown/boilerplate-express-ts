import type { Job } from 'bullmq';
import type { DeadLetterSink, TerminalJobFailure } from '@/queue/dead-letter';
import {
  MalformedJobDataError,
  UnknownJobNameError,
  UnprocessableJobError,
} from '@/queue/queue.errors';
import type { JobContext, JobEnvelope, JobHandlers } from '@/queue/queue.types';
import {
  createFailureListener,
  createJobProcessor,
  createJobQueueWorker,
} from '@/queue/worker';

type TestJobs = {
  'email.send': { to: string };
  'report.export': { reportId: string };
};

/**
 * A `Job` as the processor and the failure listener see one.
 *
 * BullMQ's `Job` is a class with a queue, a backend and thirty methods behind
 * it, none of which either function touches — they read fields. Constructing a
 * real one would mean a Redis, which is exactly the dependency splitting these
 * two functions out of `createJobQueueWorker` was meant to remove, so the shape
 * is asserted once here rather than being faked in every test.
 */
function jobLike(overrides: Partial<Job<JobEnvelope>> = {}): Job<JobEnvelope> {
  const base = {
    id: '42',
    name: 'email.send',
    data: { payload: { to: 'ada@example.test' }, correlationId: null },
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.parse('2026-09-06T11:58:00.000Z'),
    finishedOn: undefined,
    ...overrides,
  };

  return base as unknown as Job<JobEnvelope>;
}

function handlersRecording(): {
  handlers: JobHandlers<TestJobs>;
  calls: { name: string; payload: unknown; context: JobContext }[];
} {
  const calls: { name: string; payload: unknown; context: JobContext }[] = [];

  return {
    calls,
    handlers: {
      'email.send': (payload, context) => {
        calls.push({ name: 'email.send', payload, context });
        return Promise.resolve();
      },
      'report.export': (payload, context) => {
        calls.push({ name: 'report.export', payload, context });
        return Promise.resolve();
      },
    },
  };
}

describe('createJobProcessor', () => {
  it('routes a job to the handler registered under its name', async () => {
    const { handlers, calls } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    await process(jobLike({ name: 'report.export', data: { payload: { reportId: 'r-1' }, correlationId: null } }), 'token');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('report.export');
    expect(calls[0]?.payload).toEqual({ reportId: 'r-1' });
  });

  it('hands the handler the payload, not the envelope', async () => {
    const { handlers, calls } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    await process(jobLike(), 'token');

    expect(calls[0]?.payload).toEqual({ to: 'ada@example.test' });
  });

  it('counts attempts from 1, not from the BullMQ attemptsMade field', async () => {
    const { handlers, calls } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    await process(jobLike({ attemptsMade: 0 }), 'token');
    await process(jobLike({ attemptsMade: 2 }), 'token');

    // `attemptsMade` counts attempts already *finished*, so it reads 0 inside
    // the first one. "attempt 0 of 3" in a log line is the kind of off-by-one
    // that survives for years.
    expect(calls[0]?.context.attempt).toBe(1);
    expect(calls[1]?.context.attempt).toBe(3);
  });

  it('tells the handler when a throw would end the job', async () => {
    const { handlers, calls } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    await process(jobLike({ attemptsMade: 1 }), 'token');
    await process(jobLike({ attemptsMade: 2 }), 'token');

    expect(calls[0]?.context.isFinalAttempt).toBe(false);
    expect(calls[1]?.context.isFinalAttempt).toBe(true);
  });

  it('treats a job with no attempt ceiling as single-shot', async () => {
    const { handlers, calls } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    // BullMQ's own default when `attempts` is absent is 1, and a context that
    // claimed otherwise would be describing a retry that will not happen.
    await process(jobLike({ opts: {} as Job<JobEnvelope>['opts'] }), 'token');

    expect(calls[0]?.context.maxAttempts).toBe(1);
    expect(calls[0]?.context.isFinalAttempt).toBe(true);
  });

  it('carries the correlation id through to the handler', async () => {
    const { handlers, calls } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    await process(
      jobLike({ data: { payload: { to: 'ada@example.test' }, correlationId: 'req-9' } }),
      'token',
    );

    expect(calls[0]?.context.correlationId).toBe('req-9');
  });

  it('throws a retryable error for a name this build does not know', async () => {
    const { handlers } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    // Retryable and not unprocessable: the ordinary cause is a rolling deploy,
    // where the next attempt lands on a replica that does know the name.
    const error = await process(jobLike({ name: 'user.suspend' }), 'token').catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(UnknownJobNameError);
    expect(error).not.toBeInstanceOf(UnprocessableJobError);
    expect((error as UnknownJobNameError).known).toEqual(['email.send', 'report.export']);
  });

  it('does not resolve a job name off Object.prototype', async () => {
    const { handlers } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    // Without `hasOwn`, a job named `constructor` would look up something on
    // the prototype chain and be called as a handler.
    await expect(process(jobLike({ name: 'constructor' }), 'token')).rejects.toBeInstanceOf(
      UnknownJobNameError,
    );
  });

  it('refuses data that is not the envelope this build writes', async () => {
    const { handlers } = handlersRecording();
    const process = createJobProcessor<TestJobs>(handlers);

    // Unprocessable rather than retryable: the bytes in Redis do not change
    // between attempts, so a second read of a malformed payload fails exactly
    // like the first.
    const error = await process(
      jobLike({ data: 'legacy-shape' as unknown as JobEnvelope }),
      'token',
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MalformedJobDataError);
    expect(error).toBeInstanceOf(UnprocessableJobError);
  });

  it('propagates whatever the handler throws, unwrapped', async () => {
    const boom = new Error('smtp unavailable');
    const process = createJobProcessor<TestJobs>({
      'email.send': () => Promise.reject(boom),
      'report.export': () => Promise.resolve(),
    });

    // Unwrapped matters: BullMQ decides whether to retry by testing the thrown
    // value against `UnrecoverableError`, so a wrapper would turn every
    // unprocessable failure back into a retryable one.
    await expect(process(jobLike(), 'token')).rejects.toBe(boom);
  });

  it('refuses an empty handler table', () => {
    expect(() => createJobProcessor({})).toThrow(RangeError);
  });
});

describe('createFailureListener', () => {
  function sinkRecording(): { sink: DeadLetterSink; recorded: TerminalJobFailure[] } {
    const recorded: TerminalJobFailure[] = [];
    return {
      recorded,
      sink: (failure) => {
        recorded.push(failure);
        return Promise.resolve();
      },
    };
  }

  it('does not dead-letter an attempt that will be retried', () => {
    const { sink, recorded } = sinkRecording();
    const onFailed = createFailureListener({
      queueName: 'jobs',
      deadLetter: sink,
      onFailedAttempt: () => undefined,
    });

    // BullMQ emits `failed` on *every* failed attempt. `finishedOn` is set by
    // `moveToFailed` only on the branch that did not reschedule, so its absence
    // is exactly "this one is going round again".
    onFailed(jobLike({ attemptsMade: 1, finishedOn: undefined }), new Error('flaky'));

    expect(recorded).toHaveLength(0);
  });

  it('dead-letters the attempt that ended the job', () => {
    const { sink, recorded } = sinkRecording();
    const onFailed = createFailureListener({
      queueName: 'jobs',
      deadLetter: sink,
      onFailedAttempt: () => undefined,
      now: () => Date.parse('2026-09-06T12:00:00.000Z'),
    });

    onFailed(
      jobLike({ attemptsMade: 3, finishedOn: Date.parse('2026-09-06T11:59:30.000Z') }),
      new TypeError('cannot read property of undefined'),
    );

    expect(recorded).toEqual<TerminalJobFailure[]>([
      {
        queueName: 'jobs',
        jobId: '42',
        jobName: 'email.send',
        data: { payload: { to: 'ada@example.test' }, correlationId: null },
        attemptsMade: 3,
        enqueuedAt: Date.parse('2026-09-06T11:58:00.000Z'),
        failedAt: Date.parse('2026-09-06T11:59:30.000Z'),
        failedReason: 'TypeError: cannot read property of undefined',
      },
    ]);
  });

  it('dead-letters a job that skipped the ladder at attempt 1', () => {
    const { sink, recorded } = sinkRecording();
    const onFailed = createFailureListener({
      queueName: 'jobs',
      deadLetter: sink,
      onFailedAttempt: () => undefined,
    });

    // This is the case that makes `finishedOn` the right signal and
    // `attemptsMade >= opts.attempts` the wrong one: an `UnprocessableJobError`
    // is terminal at attempt 1 of 3.
    onFailed(
      jobLike({ attemptsMade: 1, opts: { attempts: 3 } as Job<JobEnvelope>['opts'], finishedOn: 1 }),
      new UnprocessableJobError('user no longer exists'),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.failedReason).toBe('UnprocessableJobError: user no longer exists');
  });

  it('ignores a failure with no job attached', () => {
    const { sink, recorded } = sinkRecording();
    const onFailed = createFailureListener({
      queueName: 'jobs',
      deadLetter: sink,
      onFailedAttempt: () => undefined,
    });

    // BullMQ emits this when it could not load the job — a lock lost to a
    // stall, say. There is nothing to record.
    onFailed(undefined, new Error('missing lock'));

    expect(recorded).toHaveLength(0);
  });

  it('reports every failed attempt, retried or not', () => {
    const seen: number[] = [];
    const onFailed = createFailureListener({
      queueName: 'jobs',
      deadLetter: null,
      onFailedAttempt: (job) => seen.push(job?.attemptsMade ?? -1),
    });

    onFailed(jobLike({ attemptsMade: 0 }), new Error('one'));
    onFailed(jobLike({ attemptsMade: 1, finishedOn: 1 }), new Error('two'));

    expect(seen).toEqual([0, 1]);
  });

  it('is a no-op on the sink when none is configured', () => {
    const onFailed = createFailureListener({
      queueName: 'jobs',
      deadLetter: null,
      onFailedAttempt: () => undefined,
    });

    expect(() => onFailed(jobLike({ finishedOn: 1 }), new Error('boom'))).not.toThrow();
  });
});

describe('createJobQueueWorker', () => {
  const base = {
    connection: { host: '127.0.0.1', port: 6379 },
    queueName: 'jobs',
    handlers: handlersRecording().handlers,
    retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
  };

  // Each of these throws before the `Worker` is constructed, which is the point
  // — a misconfiguration should be a throw at the composition root rather than
  // a connected worker that fails every job it is handed.
  it.each([0, -1, 2.5])('refuses a concurrency of %p', (concurrency) => {
    expect(() => createJobQueueWorker({ ...base, concurrency })).toThrow(RangeError);
  });

  it('refuses a lock duration too short to survive a renewal cycle', () => {
    expect(() => createJobQueueWorker({ ...base, lockDurationMs: 100 })).toThrow(RangeError);
  });

  it('refuses an empty handler table', () => {
    expect(() => createJobQueueWorker({ ...base, handlers: {} })).toThrow(RangeError);
  });

  it('refuses a retry policy whose ceiling is below its first rung', () => {
    expect(() =>
      createJobQueueWorker({
        ...base,
        retry: { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 100 },
      }),
    ).toThrow(RangeError);
  });
});
