import type { DomainEventBus } from '@/events/domain-events';
import { createEventBus } from '@/events/event-bus';
import type { DomainEventPayloads } from '@/events/domain-events';
import { createEventBusStreamHandler } from '@/redis/bus-consumer';
import type { StreamEventEnvelope } from '@/redis/stream.envelope';
import type { StreamEntryContext } from '@/redis/stream.worker';

function makeBus(): DomainEventBus {
  // Handler failures are reported per publish by the dispatcher this wraps, so
  // the bus-level reporter is silenced to keep the failure cases quiet.
  return createEventBus<DomainEventPayloads>({ onHandlerError: () => undefined });
}

const envelope: StreamEventEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'user.created',
  occurredAt: new Date('2026-09-04T10:00:00.000Z'),
  correlationId: 'corr-1',
  payload: { userId: 'user-1', email: 'user@example.test', roles: ['user'], actorId: null },
};

const context: StreamEntryContext = {
  entryId: '1788526783579-0',
  deliveryCount: 1,
  reclaimed: false,
};

describe('createEventBusStreamHandler', () => {
  it('publishes the envelope on the local bus with its identity intact', async () => {
    const bus = makeBus();
    const seen: { id: string; occurredAt: Date; correlationId: string | null }[] = [];
    bus.on('user.created', (event) => {
      seen.push({ id: event.id, occurredAt: event.occurredAt, correlationId: event.correlationId });
    });

    await createEventBusStreamHandler(bus)(envelope, context);

    // Identity and time come from the producer, not from this delivery: a
    // redelivery is the same event arriving twice, and it is only recognisable
    // as one if neither moves.
    expect(seen).toEqual([
      { id: envelope.id, occurredAt: envelope.occurredAt, correlationId: 'corr-1' },
    ]);
  });

  it('throws when a subscriber fails, so the entry is not acknowledged', async () => {
    const bus = makeBus();
    bus.on('user.created', () => {
      throw new Error('audit sink down');
    });

    // The bus isolates handler failures and resolves regardless. A handler that
    // merely awaited `publish` would acknowledge an entry nothing processed.
    await expect(createEventBusStreamHandler(bus)(envelope, context)).rejects.toThrow(
      /audit sink down/,
    );
  });

  it('throws on an event name this build has no contract for', async () => {
    const bus = makeBus();

    // The rolling-deploy case: the producer is a version ahead. Retrying is
    // right — the deploy finishes — so this must fail rather than acknowledge.
    await expect(
      createEventBusStreamHandler(bus)({ ...envelope, name: 'user.suspended' }, context),
    ).rejects.toThrow(/No subscriber contract/);
  });

  it('reports a reclaimed delivery as a retry to the dispatcher', async () => {
    const bus = makeBus();
    const handler = createEventBusStreamHandler(bus);

    // `attempts` counts deliveries already made; the group counts the one in
    // progress too. A first delivery must therefore arrive as zero attempts.
    await expect(handler(envelope, { ...context, deliveryCount: 1 })).resolves.toBeUndefined();
    await expect(
      handler(envelope, { ...context, deliveryCount: 3, reclaimed: true }),
    ).resolves.toBeUndefined();
  });
});
