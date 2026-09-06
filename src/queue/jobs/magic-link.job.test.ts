import { createRecordingMagicLinkDelivery } from '@/auth/strategies/magic-link.delivery';
import type { MagicLinkDelivery } from '@/auth/strategies/magic-link.delivery';
import { createAppJobHandlers } from '@/queue/jobs';
import { MAGIC_LINK_DELIVERY_JOB } from '@/queue/jobs/app-jobs';
import type { AppJobPayloads } from '@/queue/jobs/app-jobs';
import {
  createMagicLinkDeliveryHandler,
  createQueuedMagicLinkDelivery,
} from '@/queue/jobs/magic-link.job';
import { createJobProducer } from '@/queue/producer';
import type { JobQueueWriter } from '@/queue/producer';
import type { JobEnvelope } from '@/queue/queue.types';
import { UnprocessableJobError } from '@/queue/queue.errors';
import type { JobContext } from '@/queue/queue.types';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const IN_TEN_MINUTES = NOW + 600_000;

/** Obviously fake: this is never a real token, in a fixture or anywhere else. */
const TOKEN = 'mock-magic-link-token';

interface Written {
  readonly jobName: string;
  readonly data: JobEnvelope;
  readonly jobId: string | undefined;
}

function recordingWriter(): JobQueueWriter & { readonly writes: Written[] } {
  const writes: Written[] = [];

  return {
    name: 'jobs',
    writes,
    add(jobName, data, options): Promise<string> {
      writes.push({ jobName, data, jobId: options.jobId });
      return Promise.resolve(options.jobId ?? 'auto');
    },
    close: () => Promise.resolve(),
  };
}

function producer(queue: JobQueueWriter) {
  return createJobProducer<AppJobPayloads>({
    queue,
    retry: { attempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 },
  });
}

function context(overrides: Partial<JobContext> = {}): JobContext {
  return {
    name: MAGIC_LINK_DELIVERY_JOB,
    id: '1',
    attempt: 1,
    maxAttempts: 5,
    isFinalAttempt: false,
    correlationId: null,
    ...overrides,
  };
}

describe('createQueuedMagicLinkDelivery', () => {
  it('queues the send instead of performing it', async () => {
    const queue = recordingWriter();
    const delivery = createQueuedMagicLinkDelivery(producer(queue));

    await delivery.send({ email: 'ada@example.test', token: TOKEN, expiresAt: IN_TEN_MINUTES });

    expect(queue.writes).toHaveLength(1);
    expect(queue.writes[0]?.jobName).toBe(MAGIC_LINK_DELIVERY_JOB);
    expect(queue.writes[0]?.data.payload).toEqual({
      email: 'ada@example.test',
      token: TOKEN,
      expiresAt: IN_TEN_MINUTES,
    });
  });

  it('keeps the token out of the job id', async () => {
    const queue = recordingWriter();
    const delivery = createQueuedMagicLinkDelivery(producer(queue));

    await delivery.send({ email: 'ada@example.test', token: TOKEN, expiresAt: IN_TEN_MINUTES });

    // A job id is readable from `getJobs`, from a queue UI, and from any log
    // line that renders a job. The token is the one thing in this payload that
    // must not be in all three.
    expect(queue.writes[0]?.jobId).not.toContain(TOKEN);
    expect(queue.writes[0]?.jobId).toBe(`magic-link:ada@example.test:${String(IN_TEN_MINUTES)}`);
  });

  it('gives the same link the same id, so a retried issuer queues one send', async () => {
    const queue = recordingWriter();
    const delivery = createQueuedMagicLinkDelivery(producer(queue));
    const link = { email: 'ada@example.test', token: TOKEN, expiresAt: IN_TEN_MINUTES };

    await delivery.send(link);
    await delivery.send(link);

    // BullMQ does not add a second job under an id already present, so the
    // duplicate collapses there. What this asserts is that the id is derived
    // rather than generated, which is what makes that true.
    expect(queue.writes[0]?.jobId).toBe(queue.writes[1]?.jobId);
  });

  it('attaches the request correlation id when one is available', async () => {
    const queue = recordingWriter();
    const delivery = createQueuedMagicLinkDelivery(producer(queue), {
      correlationId: () => 'req-42',
    });

    await delivery.send({ email: 'ada@example.test', token: TOKEN, expiresAt: IN_TEN_MINUTES });

    expect(queue.writes[0]?.data.correlationId).toBe('req-42');
  });

  it('satisfies the port, so the issuer cannot tell the difference', () => {
    const delivery: MagicLinkDelivery = createQueuedMagicLinkDelivery(producer(recordingWriter()));
    expect(typeof delivery.send).toBe('function');
  });
});

describe('createMagicLinkDeliveryHandler', () => {
  it('sends a link that is still live', async () => {
    const inbox = createRecordingMagicLinkDelivery();
    const handler = createMagicLinkDeliveryHandler(inbox, () => NOW);

    await handler({ email: 'ada@example.test', token: TOKEN, expiresAt: IN_TEN_MINUTES }, context());

    expect(inbox.lastFor('ada@example.test')).toEqual({
      email: 'ada@example.test',
      token: TOKEN,
      expiresAt: IN_TEN_MINUTES,
    });
  });

  it('refuses a link that expired while it was queued, without retrying', async () => {
    const inbox = createRecordingMagicLinkDelivery();
    const handler = createMagicLinkDeliveryHandler(inbox, () => NOW);

    // Retrying cannot make an expired link less expired, and delivering one
    // produces a support ticket rather than an error: the user clicks it, is
    // told it has expired, and asks for another.
    const error = await handler(
      { email: 'ada@example.test', token: TOKEN, expiresAt: NOW - 1 },
      context({ attempt: 3 }),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnprocessableJobError);
    expect(inbox.size).toBe(0);
  });

  it('treats the expiry instant itself as expired', async () => {
    const inbox = createRecordingMagicLinkDelivery();
    const handler = createMagicLinkDeliveryHandler(inbox, () => NOW);

    await expect(
      handler({ email: 'ada@example.test', token: TOKEN, expiresAt: NOW }, context()),
    ).rejects.toBeInstanceOf(UnprocessableJobError);
  });

  it('never puts the token in the message it throws', async () => {
    const handler = createMagicLinkDeliveryHandler(createRecordingMagicLinkDelivery(), () => NOW);

    const error = await handler(
      { email: 'ada@example.test', token: TOKEN, expiresAt: NOW - 1 },
      context(),
    ).catch((thrown: unknown) => thrown);

    // The message becomes `failedReason` on a dead-letter record, which is
    // stored indefinitely and read by a person.
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).toContain('ada@example.test');
  });

  it('lets a transport failure through so the ladder can retry it', async () => {
    const boom = new Error('smtp unavailable');
    const failing: MagicLinkDelivery = { send: () => Promise.reject(boom) };
    const handler = createMagicLinkDeliveryHandler(failing, () => NOW);

    // The opposite case to the expiry: a provider that was down a moment ago
    // may well be up now, and this is the failure the queue exists for.
    await expect(
      handler({ email: 'ada@example.test', token: TOKEN, expiresAt: IN_TEN_MINUTES }, context()),
    ).rejects.toBe(boom);
  });
});

describe('createAppJobHandlers', () => {
  it('covers every name in the payload map', () => {
    const handlers = createAppJobHandlers({
      magicLinkDelivery: createRecordingMagicLinkDelivery(),
    });

    // The type is exhaustive, so this is really a runtime echo of a compile
    // error — but it is the assertion that fails if the map and the table are
    // ever brought back together by a cast.
    expect(Object.keys(handlers)).toEqual([MAGIC_LINK_DELIVERY_JOB]);
  });

  it('builds a fresh table per call rather than one on import', async () => {
    const first = createRecordingMagicLinkDelivery();
    const second = createRecordingMagicLinkDelivery();

    const handlers = createAppJobHandlers({ magicLinkDelivery: first });
    createAppJobHandlers({ magicLinkDelivery: second });

    await handlers[MAGIC_LINK_DELIVERY_JOB](
      { email: 'ada@example.test', token: TOKEN, expiresAt: Date.now() + 600_000 },
      context(),
    );

    // A table assembled on import decides what the worker does before the
    // composition root has had a chance to, and reaches for a mail client the
    // moment anything imports the module.
    expect(first.size).toBe(1);
    expect(second.size).toBe(0);
  });
});
