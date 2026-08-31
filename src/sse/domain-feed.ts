import { DOMAIN_EVENT_NAMES } from '@/events/domain-events';
import type { DomainEventBus, DomainEventName } from '@/events/domain-events';
import type { Unsubscribe } from '@/events/event-bus';
import type { SseHub } from '@/sse/hub';

/**
 * The bridge from the in-process domain bus to whatever streams are open.
 *
 * It is deliberately the thinnest thing that works, and it is a *subscriber* —
 * the same shape as the audit log — rather than a call inside each publisher.
 * Nothing that publishes `user.created` knows this exists, which is what lets a
 * deployment that does not want the endpoint simply not call this function.
 *
 * What it does not do is guarantee delivery. A subscriber on the bus is
 * at-most-once and in-process: an event published while a client is between
 * connections reaches the replay log (so the reconnect gets it) but an event
 * published while the *process* is down is gone, and an event published on
 * another replica never reaches this one's log at all. That is the honest
 * boundary of this design and the reason `stream.open` reports `reset` rather
 * than pretending — a client that needs a complete history reads the REST API,
 * and uses the stream to know when to read it again.
 */

/**
 * What a domain event looks like on the wire.
 *
 * The envelope is flattened rather than passed through: `occurredAt` becomes an
 * ISO string because `JSON.stringify` would do that anyway and a documented
 * field beats an incidental one, and `id` is kept because it is the bus's
 * identity for the event and lets a client deduplicate across a replay that
 * overlaps what it already has. It is *not* the SSE `id` — that one addresses a
 * position in the replay log, and conflating the two would make a cursor
 * meaningless the moment an event is republished by the outbox relay.
 */
export interface DomainEventFrame {
  readonly id: string;
  readonly occurredAt: string;
  readonly correlationId: string | null;
  readonly payload: unknown;
}

function forward<TName extends DomainEventName>(
  bus: DomainEventBus,
  hub: SseHub,
  name: TName,
): Unsubscribe {
  return bus.on(name, (event) => {
    const frame: DomainEventFrame = {
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: event.correlationId,
      payload: event.payload,
    };

    hub.publish(event.name, frame);
  });
}

/**
 * Subscribes the hub to every event this build knows about, and returns the
 * undo.
 *
 * Iterating `DOMAIN_EVENT_NAMES` rather than listing names here is what keeps
 * the endpoint from silently omitting an event added later: that constant is
 * held exhaustive by a compile-time assertion in `domain-events.ts`, so a new
 * member of `DomainEventPayloads` either appears on the stream or fails the
 * build.
 */
export function attachDomainEventFeed(bus: DomainEventBus, hub: SseHub): Unsubscribe {
  const unsubscribes = DOMAIN_EVENT_NAMES.map((name) => forward(bus, hub, name));

  return (): void => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  };
}
