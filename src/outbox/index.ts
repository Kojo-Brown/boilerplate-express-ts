import type { DomainEventPayloads } from '@/events/domain-events';
import type { OutboxStore } from '@/outbox/outbox.types';

export type {
  EnqueueOptions,
  JsonPrimitive,
  JsonSafe,
  OutboxDispatcher,
  OutboxMessage,
  OutboxStore,
} from '@/outbox/outbox.types';

export { OUTBOX_TABLE, PostgresOutboxStore } from '@/outbox/outbox.store';

export {
  describeFailure,
  MAX_LAST_ERROR_LENGTH,
  OutboxDeliveryError,
  OutboxDispatchTimeoutError,
  UnknownOutboxEventError,
} from '@/outbox/outbox.errors';

export { createEventBusDispatcher, toEnvelope } from '@/outbox/dispatcher';

export type {
  OutboxRelayJob,
  OutboxRelayJobOptions,
  OutboxRelayOptions,
  OutboxRelayOutcome,
} from '@/outbox/relay';
export { runOutboxBatch, runOutboxRelay, startOutboxRelay } from '@/outbox/relay';

/**
 * The outbox this service's publishers write to, bound to the same event map as
 * the bus.
 *
 * Named separately from `OutboxStore` so a call site depends on "the outbox of
 * this application" rather than on the generic, which is what keeps the event
 * map from having to be spelled at every injection point.
 */
export type DomainOutbox = OutboxStore<DomainEventPayloads>;
