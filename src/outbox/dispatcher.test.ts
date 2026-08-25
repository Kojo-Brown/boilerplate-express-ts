import { createEventBus } from '@/events/event-bus';
import type { DomainEventBus, DomainEventPayloads } from '@/events/domain-events';
import { createEventBusDispatcher, toEnvelope } from '@/outbox/dispatcher';
import { OutboxDeliveryError, UnknownOutboxEventError } from '@/outbox/outbox.errors';
import type { OutboxMessage } from '@/outbox/outbox.types';

function newBus(): DomainEventBus {
  return createEventBus<DomainEventPayloads>({
    // Nothing in this suite wants a handler failure on stdout: every one of
    // them is deliberate, and the point is that the dispatcher sees it.
    onHandlerError: () => undefined,
  });
}

function message(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    id: 'message-uuid',
    name: 'user.created',
    payload: {
      userId: 'user-uuid-1',
      email: 'alice@example.com',
      roles: ['user'],
      actorId: null,
    },
    correlationId: 'correlation-abc',
    occurredAt: new Date('2026-08-25T10:00:00Z'),
    attempts: 0,
    ...overrides,
  };
}

describe('createEventBusDispatcher', () => {
  it('publishes the stored payload and carries the message id as the event id', async () => {
    const bus = newBus();
    const seen: { id: string; correlationId: string | null; userId: string }[] = [];

    bus.on('user.created', (event) => {
      seen.push({
        id: event.id,
        correlationId: event.correlationId,
        userId: event.payload.userId,
      });
    });

    await createEventBusDispatcher(bus)(message());

    // The id is the outbox row's primary key, which is what makes a
    // redelivery recognisable as one rather than as a second event.
    expect(seen).toEqual([
      { id: 'message-uuid', correlationId: 'correlation-abc', userId: 'user-uuid-1' },
    ]);
  });

  it('resolves when every subscriber succeeded', async () => {
    const bus = newBus();
    bus.on('user.created', async () => undefined);

    await expect(createEventBusDispatcher(bus)(message())).resolves.toBeUndefined();
  });

  it('resolves when nobody is listening', async () => {
    // An event with no subscriber in this build is delivered, not owed. The
    // alternative — retrying until a subscriber appears — would dead-letter
    // every event a deployment does not consume.
    await expect(createEventBusDispatcher(newBus())(message())).resolves.toBeUndefined();
  });

  it('throws when a subscriber fails, so the row survives to be retried', async () => {
    const bus = newBus();
    bus.on('user.created', async function auditLine() {
      throw new Error('sink unreachable');
    });

    // The bus isolates handler failures and `publish` resolves regardless, so
    // a dispatcher that merely awaited it would delete a durable row for an
    // event nothing processed. This is the assertion that the outbox is worth
    // more than the bus it publishes on.
    const error = await createEventBusDispatcher(bus)(message()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OutboxDeliveryError);
    expect(String(error)).toContain('auditLine');
    expect(String(error)).toContain('sink unreachable');
  });

  it('still runs every subscriber when one of them fails', async () => {
    const bus = newBus();
    const healthy = jest.fn();

    bus.on('user.created', async function failing() {
      throw new Error('nope');
    });
    bus.on('user.created', healthy);

    await expect(createEventBusDispatcher(bus)(message())).rejects.toBeInstanceOf(
      OutboxDeliveryError,
    );
    // Isolation is unchanged; what changed is that the publisher finds out.
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('reports every failed subscriber, not just the first', async () => {
    const bus = newBus();
    bus.on('user.created', async function first() {
      throw new Error('one');
    });
    bus.on('user.created', async function second() {
      throw new Error('two');
    });

    const error = (await createEventBusDispatcher(bus)(message()).catch(
      (err: unknown) => err,
    )) as OutboxDeliveryError;

    expect(error.failures.map((failure) => failure.handlerName)).toEqual(['first', 'second']);
  });

  it('does not report failures to the bus default when it is collecting them', async () => {
    const onHandlerError = jest.fn();
    const bus = createEventBus<DomainEventPayloads>({ onHandlerError });
    bus.on('user.created', async () => {
      throw new Error('boom');
    });

    await expect(createEventBusDispatcher(bus)(message())).rejects.toBeInstanceOf(
      OutboxDeliveryError,
    );
    // One incident, reported once, by the party that knows what it means.
    expect(onHandlerError).not.toHaveBeenCalled();
  });

  it('throws on an event name this build has no contract for', async () => {
    // The ordinary case is a rolling deploy: a newer replica enqueued an event
    // this one does not know. Throwing means the ladder retries it, and the
    // deploy finishing is what makes the retry succeed.
    await expect(
      createEventBusDispatcher(newBus())(message({ name: 'user.suspended' })),
    ).rejects.toBeInstanceOf(UnknownOutboxEventError);
  });
});

describe('toEnvelope', () => {
  it('renders the wire shape a broker adapter would send', () => {
    expect(toEnvelope(message())).toEqual({
      id: 'message-uuid',
      name: 'user.created',
      occurredAt: '2026-08-25T10:00:00.000Z',
      correlationId: 'correlation-abc',
      payload: {
        userId: 'user-uuid-1',
        email: 'alice@example.com',
        roles: ['user'],
        actorId: null,
      },
    });
  });
});
