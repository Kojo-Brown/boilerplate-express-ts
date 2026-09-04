import type { DomainEventBus } from '@/events/domain-events';
import { createEventBusDispatcher } from '@/outbox/dispatcher';
import type { StreamHandler } from '@/redis/stream.worker';

/**
 * The consuming end of the transport: a stream entry becomes a publish on this
 * process's domain bus.
 *
 * It is `createEventBusDispatcher` behind an envelope-shaped adapter rather
 * than a second implementation, and that is the point. The dispatcher already
 * decides everything that matters about the local publish — that an unknown
 * event name is a rolling-deploy condition and must be retried rather than
 * dropped, and that a failing subscriber means the *event* failed and must not
 * be acknowledged. Writing those decisions again here would mean two delivery
 * boundaries that agree today: the day one of them learns something the other
 * does not, an event routed through Redis behaves differently from the same
 * event routed through the relay, for reasons nobody would look for.
 *
 * The mapping is exact because both sides use the outbox's envelope. `attempts`
 * is the only field that has to be derived: the dispatcher counts deliveries
 * already made, while the group counts the one in progress too.
 */
export function createEventBusStreamHandler(bus: DomainEventBus): StreamHandler {
  const dispatch = createEventBusDispatcher(bus);

  return async function publishToBus(envelope, context): Promise<void> {
    await dispatch({
      id: envelope.id,
      name: envelope.name,
      payload: envelope.payload,
      correlationId: envelope.correlationId,
      occurredAt: envelope.occurredAt,
      attempts: context.deliveryCount - 1,
    });
  };
}
