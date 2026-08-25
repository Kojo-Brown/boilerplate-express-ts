import type { DomainEventBus, DomainEventName, DomainEventPayloads } from '@/events/domain-events';
import { isDomainEventName } from '@/events/domain-events';
import { OutboxDeliveryError, UnknownOutboxEventError } from '@/outbox/outbox.errors';
import type { OutboxDispatcher, OutboxMessage } from '@/outbox/outbox.types';

/**
 * The in-process dispatcher: a claimed row becomes a publish on the domain bus.
 *
 * ## Where the delivery boundary actually is
 *
 * The relay deletes a durable row when this resolves, so what "resolved" means
 * is the whole contract. Merely awaiting `bus.publish` would make it mean "the
 * subscribers were called", because the bus isolates handler failures by design
 * — a subscriber that throws is reported and `publish` fulfils regardless. The
 * row would then be deleted for an event nothing processed, and the outbox
 * would have bought a table, a migration and a poller in exchange for exactly
 * the guarantee the bus already gave.
 *
 * So this passes a per-publish reporter (`PublishOptions.onHandlerError`),
 * collects what failed, and throws. A failed subscriber is a failed delivery,
 * the row survives, and the ladder retries it — which is what makes the
 * session-revocation subscriber's "best-effort, at-most-once" limit go away
 * for events routed through here.
 *
 * ## What that costs, stated plainly
 *
 * A retry redelivers to **every** subscriber, not to the one that failed. With
 * three subscribers and one flaky sink, the other two see the event again on
 * every attempt. There is no cheaper truth available: the outbox holds one row
 * per event, not one per subscriber, and splitting it per subscriber is a
 * different data model (and a per-subscriber cursor, and a per-subscriber
 * dead-letter) rather than a tweak. What follows is a rule for subscribers,
 * and it is the same rule any at-least-once consumer lives under: be
 * idempotent, and use `event.id` — stable across redeliveries by construction,
 * because it is the outbox row's primary key — when you need to recognise one.
 */
export function createEventBusDispatcher(bus: DomainEventBus): OutboxDispatcher {
  return async function dispatchToEventBus(message: OutboxMessage): Promise<void> {
    if (!isDomainEventName(message.name)) {
      throw new UnknownOutboxEventError(message.id, message.name);
    }

    const failures: { handlerName: string; error: Error }[] = [];

    await bus.publish(
      message.name,
      // The one place a stored payload is asserted rather than known. What came
      // back out of `jsonb` is whatever some deployment wrote, and no runtime
      // check short of a schema per event would establish more than the name
      // already does — which is why the name is checked and this is not. A
      // subscriber reading a field a since-changed payload no longer carries
      // sees `undefined`, exactly as it would for a message that crossed a
      // broker; that is the version-skew problem every durable queue has, and
      // it is answered by not removing fields from a payload while messages
      // carrying them may still be in the table.
      message.payload as DomainEventPayloads[DomainEventName],
      {
        // Identity and time come from the row, not from this delivery. A
        // redelivery is the same event arriving twice — which is the contract —
        // and it is only recognisable as one if these two do not move.
        eventId: message.id,
        occurredAt: message.occurredAt,
        correlationId: message.correlationId ?? undefined,
        onHandlerError: (error, _event, { handlerName }) => {
          failures.push({ handlerName, error });
        },
      },
    );

    if (failures.length > 0) {
      throw new OutboxDeliveryError(message.id, message.name, failures);
    }
  };
}

/**
 * The message as a `DomainEvent`-shaped envelope, for a dispatcher that is
 * writing to something other than the bus.
 *
 * Broker adapters are Phase 8's; this exists so the first one does not have to
 * invent a wire shape, and so the id a consumer deduplicates on is the same one
 * whether the message went through the bus or a topic.
 */
export function toEnvelope(message: OutboxMessage): {
  id: string;
  name: string;
  occurredAt: string;
  correlationId: string | null;
  payload: unknown;
} {
  return {
    id: message.id,
    name: message.name,
    occurredAt: message.occurredAt.toISOString(),
    correlationId: message.correlationId,
    payload: message.payload,
  };
}
