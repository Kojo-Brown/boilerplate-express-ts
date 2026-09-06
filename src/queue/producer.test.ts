import type { JobsOptions } from 'bullmq';
import { createJobProducer, DEFAULT_JOB_RETENTION } from '@/queue/producer';
import type { JobQueueWriter } from '@/queue/producer';
import type { JobEnvelope } from '@/queue/queue.types';
import type { RetryPolicy } from '@/queue/retry';

type TestJobs = {
  'email.send': { to: string; subject: string };
  'report.export': { reportId: string };
};

const RETRY: RetryPolicy = { attempts: 4, baseDelayMs: 250, maxDelayMs: 10_000 };

interface Written {
  readonly jobName: string;
  readonly data: JobEnvelope;
  readonly options: JobsOptions;
}

/** A queue that records rather than connects. */
function recordingWriter(name = 'jobs'): JobQueueWriter & { readonly writes: Written[] } {
  const writes: Written[] = [];

  return {
    name,
    writes,
    add(jobName: string, data: JobEnvelope, options: JobsOptions): Promise<string> {
      writes.push({ jobName, data, options });
      return Promise.resolve(options.jobId ?? `auto-${String(writes.length)}`);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

describe('createJobProducer', () => {
  it('nests the payload in an envelope rather than storing it bare', () => {
    const queue = recordingWriter();
    const producer = createJobProducer<TestJobs>({ queue, retry: RETRY });

    return producer
      .enqueue('email.send', { to: 'ada@example.test', subject: 'hello' })
      .then(() => {
        // The nesting is what lets queue-level metadata be added later without
        // colliding with a payload field — and it is why `decodeEnvelope`
        // refuses data that is not this shape.
        expect(queue.writes[0]?.data).toEqual({
          payload: { to: 'ada@example.test', subject: 'hello' },
          correlationId: null,
        });
      });
  });

  it('carries the request correlation id beside the payload, not inside it', async () => {
    const queue = recordingWriter();
    const producer = createJobProducer<TestJobs>({ queue, retry: RETRY });

    await producer.enqueue(
      'report.export',
      { reportId: 'r-1' },
      { correlationId: 'req-abc' },
    );

    expect(queue.writes[0]?.data).toEqual({
      payload: { reportId: 'r-1' },
      correlationId: 'req-abc',
    });
  });

  it('applies the retry ladder to every job', async () => {
    const queue = recordingWriter();
    const producer = createJobProducer<TestJobs>({ queue, retry: RETRY });

    await producer.enqueue('report.export', { reportId: 'r-1' });

    // Attempts are a *job* option, written into Redis here; the delays between
    // them are a worker setting. This is the half that has to be right at
    // enqueue time — a job stored without `attempts` is never retried, whatever
    // the worker is configured to do.
    expect(queue.writes[0]?.options.attempts).toBe(4);
    expect(queue.writes[0]?.options.backoff).toEqual({ type: expect.any(String) });
  });

  it('lets one job override the attempt ceiling without touching the queue default', async () => {
    const queue = recordingWriter();
    const producer = createJobProducer<TestJobs>({ queue, retry: RETRY });

    await producer.enqueue('report.export', { reportId: 'urgent' }, { attempts: 1 });
    await producer.enqueue('report.export', { reportId: 'normal' });

    expect(queue.writes[0]?.options.attempts).toBe(1);
    expect(queue.writes[1]?.options.attempts).toBe(4);
  });

  it('keeps failed jobs, because the dead-letter transfer reads them from there', async () => {
    const queue = recordingWriter();
    const producer = createJobProducer<TestJobs>({ queue, retry: RETRY });

    await producer.enqueue('report.export', { reportId: 'r-1' });

    expect(queue.writes[0]?.options.removeOnFail).toEqual({
      count: DEFAULT_JOB_RETENTION.failed,
    });
    expect(queue.writes[0]?.options.removeOnComplete).toEqual({
      count: DEFAULT_JOB_RETENTION.completed,
    });
  });

  it('refuses a retention that would delete a job as it fails', () => {
    const queue = recordingWriter();

    // `removeOnFail: 0` and `removeOnFail: true` are the same thing to BullMQ,
    // and both take the failed set away — which is the only durable record if a
    // worker dies between failing a job and writing the dead-letter entry.
    expect(() =>
      createJobProducer<TestJobs>({
        queue,
        retry: RETRY,
        retention: { completed: 100, failed: 0 },
      }),
    ).toThrow(RangeError);
  });

  it('accepts a completed retention of zero, which loses nothing', () => {
    const queue = recordingWriter();

    expect(() =>
      createJobProducer<TestJobs>({
        queue,
        retry: RETRY,
        retention: { completed: 0, failed: 10 },
      }),
    ).not.toThrow();
  });

  it('passes through the scheduling options a caller may set', async () => {
    const queue = recordingWriter();
    const producer = createJobProducer<TestJobs>({ queue, retry: RETRY });

    await producer.enqueue(
      'email.send',
      { to: 'ada@example.test', subject: 'hi' },
      { jobId: 'send-1', delayMs: 5_000, priority: 3 },
    );

    expect(queue.writes[0]?.options).toMatchObject({
      jobId: 'send-1',
      delay: 5_000,
      priority: 3,
    });
  });

  it('omits scheduling keys entirely when they are not given', async () => {
    const queue = recordingWriter();
    const producer = createJobProducer<TestJobs>({ queue, retry: RETRY });

    await producer.enqueue('email.send', { to: 'ada@example.test', subject: 'hi' });

    // `{ jobId: undefined }` is not the same as an absent key to BullMQ's
    // option merging, and an explicit `undefined` delay would be coerced.
    expect(queue.writes[0]?.options).not.toHaveProperty('jobId');
    expect(queue.writes[0]?.options).not.toHaveProperty('delay');
    expect(queue.writes[0]?.options).not.toHaveProperty('priority');
  });

  it('returns the id the queue assigned', async () => {
    const queue = recordingWriter();
    const producer = createJobProducer<TestJobs>({ queue, retry: RETRY });

    await expect(
      producer.enqueue('report.export', { reportId: 'r-1' }, { jobId: 'chosen' }),
    ).resolves.toBe('chosen');
  });

  it('exposes the queue name it writes to', () => {
    const producer = createJobProducer<TestJobs>({ queue: recordingWriter('orders'), retry: RETRY });
    expect(producer.queueName).toBe('orders');
  });
});
