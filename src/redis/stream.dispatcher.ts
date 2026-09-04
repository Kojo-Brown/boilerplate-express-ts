import type { OutboxDispatcher, OutboxMessage } from '@/outbox/outbox.types';
import { toEnvelope } from '@/outbox/dispatcher';
import type { StreamPublisher } from '@/redis/stream.publisher';

/**
 * An `OutboxDispatcher` that writes to a Redis stream instead of to the local
 * event bus.
 *
 * ## What changes when this is the dispatcher
 *
 * With `createEventBusDispatcher`, a claimed row is published to the bus **of
 * the replica that claimed it**, so a subscriber runs on one arbitrary replica
 * — the one whose relay won the row. That is at-least-once and effectively
 * once-per-event, and it is correct for the subscribers this service has.
 *
 * With this one, the row becomes an entry on a stream and the consumer group
 * decides who runs it. The count is unchanged — a consumer group hands each
 * entry to exactly one consumer — but *where* moves: to a worker process rather
 * than to an API replica. Which is the point. A subscriber that takes 400ms is
 * then 400ms of a worker rather than 400ms of a pooled connection held open
 * inside a relay transaction on a machine serving requests.
 *
 * ## Why it uses `toEnvelope`
 *
 * The wire shape is the outbox's, not one invented here, so `envelope.id` is
 * the outbox row's primary key on both sides of the transport. A redelivery
 * from the relay and a redelivery from the consumer group are then the same
 * event arriving twice, recognisable by the same id — which is the only thing
 * that makes at-least-once workable end to end. An id minted per `XADD` would
 * make the relay's own retry indistinguishable from a new event.
 *
 * ## Duplicates, stated plainly
 *
 * There are now two at-least-once hops rather than one. The relay deletes its
 * row after this resolves, so a crash between the `XADD` and the delete
 * republishes the entry; the consumer group redelivers an entry whose handler
 * did not acknowledge. Both are answered the same way and by the same field:
 * subscribers must be idempotent on `envelope.id`.
 */
export function createStreamOutboxDispatcher(publisher: StreamPublisher): OutboxDispatcher {
  return async function dispatchToStream(message: OutboxMessage): Promise<void> {
    const envelope = toEnvelope(message);

    // No name check here, deliberately, and it is the difference between this
    // dispatcher and the bus one. `createEventBusDispatcher` rejects a name
    // this build has no subscriber contract for, because publishing it locally
    // could not do anything. Writing it to a stream can: the consumer is a
    // different process on a possibly different version, and during a rolling
    // deploy it is frequently the newer one. Filtering here would drop events
    // that the thing meant to handle them understands perfectly.
    await publisher.publish({
      id: envelope.id,
      name: envelope.name,
      occurredAt: message.occurredAt,
      correlationId: envelope.correlationId,
      payload: envelope.payload,
    });
  };
}
