import type {
  DeliverableMagicLink,
  MagicLinkDelivery,
} from '@/auth/strategies/magic-link.delivery';
import type { AppJobPayloads } from '@/queue/jobs/app-jobs';
import { MAGIC_LINK_DELIVERY_JOB } from '@/queue/jobs/app-jobs';
import type { JobProducer } from '@/queue/producer';
import { UnprocessableJobError } from '@/queue/queue.errors';
import type { JobContext, JobHandler } from '@/queue/queue.types';

/**
 * The magic link delivery, taken off the request path.
 *
 * `MagicLinkDelivery` was written as a port because the transport is
 * deployment-specific — "SES here, Postmark there, a queue somewhere else". This
 * is the third one. It is a *decorator* rather than a replacement: the real
 * sender still exists and is what the worker calls, so a deployment chooses
 * between sending inline and sending through the queue by which object the
 * composition root hands to the issuer, and nothing else changes.
 *
 * The queue is what supplies the retries. A magic link that fails to send is
 * the worst kind of failure to swallow — the user is sitting on a "check your
 * inbox" screen with nothing coming, and no way to tell a slow provider from a
 * broken one — and the alternative to retrying is asking them to request a
 * second link, which invalidates the first.
 */

/** The delivery that enqueues instead of sending. Both halves live in this file on purpose. */
export function createQueuedMagicLinkDelivery(
  producer: JobProducer<AppJobPayloads>,
  options: { correlationId?: () => string | undefined } = {},
): MagicLinkDelivery {
  const { correlationId } = options;

  return {
    async send(link: DeliverableMagicLink): Promise<void> {
      const requestId = correlationId?.();

      await producer.enqueue(
        MAGIC_LINK_DELIVERY_JOB,
        { email: link.email, token: link.token, expiresAt: link.expiresAt },
        {
          // The token is the natural identity here and must not be it: a job id
          // is readable from `getJobs`, from BullMQ's UI, and from any log line
          // that renders a job. The address plus the expiry is unique per issued
          // link — the store mints one link per address at a time — and carries
          // nothing secret. It also makes the enqueue idempotent, so an issuer
          // retried by its own caller does not queue two identical sends.
          jobId: `magic-link:${link.email}:${link.expiresAt}`,
          ...(requestId === undefined ? {} : { correlationId: requestId }),
        },
      );
    },
  };
}

/**
 * The worker-side half: run the real delivery, or refuse to.
 *
 * The expiry check is what makes the retry ladder safe to have at all. Without
 * it, a link that spent four minutes climbing the ladder is delivered after it
 * has stopped working, which is a support ticket rather than an error — the
 * user clicks it, gets "this link has expired", and requests another. Failing
 * unprocessably instead ends the job at once and puts a record in front of
 * somebody, which is the honest outcome for work whose deadline has passed.
 *
 * `UnprocessableJobError` and not a plain throw: retrying a link that is already
 * expired cannot make it less expired.
 */
export function createMagicLinkDeliveryHandler(
  delivery: MagicLinkDelivery,
  now: () => number = Date.now,
): JobHandler<AppJobPayloads, typeof MAGIC_LINK_DELIVERY_JOB> {
  return async function deliverMagicLink(
    payload: AppJobPayloads[typeof MAGIC_LINK_DELIVERY_JOB],
    context: JobContext,
  ): Promise<void> {
    if (payload.expiresAt <= now()) {
      // The address is in the message and the token is not. A dead-letter
      // record is read by a person and stored indefinitely; this is the one
      // string from this job that ends up in both.
      throw new UnprocessableJobError(
        `Magic link for ${payload.email} expired at ` +
          `${new Date(payload.expiresAt).toISOString()}, before attempt ${String(context.attempt)} ran`,
      );
    }

    await delivery.send({
      email: payload.email,
      token: payload.token,
      expiresAt: payload.expiresAt,
    });
  };
}
