import type { MagicLinkDelivery } from '@/auth/strategies/magic-link.delivery';
import { MAGIC_LINK_DELIVERY_JOB } from '@/queue/jobs/app-jobs';
import type { AppJobPayloads } from '@/queue/jobs/app-jobs';
import { createMagicLinkDeliveryHandler } from '@/queue/jobs/magic-link.job';
import type { JobHandlers } from '@/queue/queue.types';

export type { AppJobPayloads } from '@/queue/jobs/app-jobs';
export { MAGIC_LINK_DELIVERY_JOB, REDACTED, redactAppJobPayload } from '@/queue/jobs/app-jobs';
export {
  createMagicLinkDeliveryHandler,
  createQueuedMagicLinkDelivery,
} from '@/queue/jobs/magic-link.job';

/** What the handler table needs from the rest of the service. */
export interface AppJobDependencies {
  /**
   * The *real* delivery — never the queued one. Handing the queued delivery to
   * its own handler would make every job enqueue a copy of itself, which is a
   * loop bounded only by Redis's memory.
   */
  readonly magicLinkDelivery: MagicLinkDelivery;
}

/**
 * The handler table, built from the service's own collaborators.
 *
 * A factory rather than a module-level constant for the reason
 * `registerDomainSubscribers` is one: a table assembled on import decides what
 * the worker does before the composition root has had a chance to, and it
 * reaches for a mail client the moment anything imports the module — including
 * a unit test of something else entirely.
 *
 * `JobHandlers<AppJobPayloads>` is exhaustive, so adding a name to
 * `AppJobPayloads` is a compile error here until something handles it.
 */
export function createAppJobHandlers(
  dependencies: AppJobDependencies,
): JobHandlers<AppJobPayloads> {
  return {
    [MAGIC_LINK_DELIVERY_JOB]: createMagicLinkDeliveryHandler(dependencies.magicLinkDelivery),
  };
}
