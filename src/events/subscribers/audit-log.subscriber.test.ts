import type { DomainEventBus, DomainEventPayloads } from '@/events/domain-events';
import { createEventBus } from '@/events/event-bus';
import type { AuditEntry, AuditSink } from '@/events/subscribers/audit-log.subscriber';
import {
  consoleAuditSink,
  registerAuditLogSubscriber,
} from '@/events/subscribers/audit-log.subscriber';

function makeSink(): AuditSink & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(entry: AuditEntry): void {
      entries.push(entry);
    },
  };
}

function makeBus(): DomainEventBus {
  let sequence = 0;
  return createEventBus<DomainEventPayloads>({
    now: () => new Date('2024-05-01T12:00:00.000Z'),
    newId: () => `event-${(sequence += 1)}`,
  });
}

describe('registerAuditLogSubscriber', () => {
  it('records a line for a user creation, naming actor and subject', async () => {
    const bus = makeBus();
    const sink = makeSink();
    registerAuditLogSubscriber(bus, { sink });

    await bus.publish(
      'user.created',
      {
        userId: 'user-1',
        email: 'new@example.com',
        roles: ['user'],
        actorId: 'admin-9',
      },
      { correlationId: 'req-1' },
    );

    expect(sink.entries).toEqual([
      {
        eventId: 'event-1',
        eventName: 'user.created',
        occurredAt: '2024-05-01T12:00:00.000Z',
        correlationId: 'req-1',
        actorId: 'admin-9',
        subject: 'user-1',
        attributes: { email: 'new@example.com', roles: ['user'] },
      },
    ]);
  });

  it('records which fields an update touched, and not their values', async () => {
    const bus = makeBus();
    const sink = makeSink();
    registerAuditLogSubscriber(bus, { sink });

    await bus.publish('user.updated', {
      userId: 'user-1',
      changedFields: ['roles', 'email'],
      actorId: 'admin-9',
    });

    expect(sink.entries[0]?.attributes).toEqual({ changedFields: ['roles', 'email'] });
  });

  it('treats the authenticated user as their own actor on login', async () => {
    const bus = makeBus();
    const sink = makeSink();
    registerAuditLogSubscriber(bus, { sink });

    await bus.publish('auth.login.succeeded', { userId: 'user-1', strategy: 'magic-link' });

    expect(sink.entries[0]).toMatchObject({
      actorId: 'user-1',
      subject: 'user-1',
      attributes: { strategy: 'magic-link' },
    });
  });

  it('records a line for every domain event, none excepted', async () => {
    const bus = makeBus();
    const sink = makeSink();
    registerAuditLogSubscriber(bus, { sink });

    await bus.publish('user.created', {
      userId: 'u',
      email: 'a@example.com',
      roles: [],
      actorId: null,
    });
    await bus.publish('user.updated', { userId: 'u', changedFields: ['email'], actorId: null });
    await bus.publish('user.deleted', { userId: 'u', actorId: null });
    await bus.publish('auth.login.succeeded', { userId: 'u', strategy: 'password' });
    await bus.publish('auth.session.revoked', { userId: 'u', scope: 'all' });

    expect(sink.entries.map((entry) => entry.eventName)).toEqual([
      'user.created',
      'user.updated',
      'user.deleted',
      'auth.login.succeeded',
      'auth.session.revoked',
    ]);
  });

  it('copies array attributes rather than aliasing the payload', async () => {
    const bus = makeBus();
    const sink = makeSink();
    registerAuditLogSubscriber(bus, { sink });

    const roles = ['user'];
    await bus.publish('user.created', {
      userId: 'user-1',
      email: 'new@example.com',
      roles,
      actorId: null,
    });
    roles.push('admin');

    // An audit line that changes after it was written is not an audit line.
    expect(sink.entries[0]?.attributes['roles']).toEqual(['user']);
  });

  it('awaits an async sink before the publish resolves', async () => {
    const bus = makeBus();
    let written = false;
    registerAuditLogSubscriber(bus, {
      sink: {
        async record(): Promise<void> {
          await Promise.resolve();
          written = true;
        },
      },
    });

    await bus.publish('user.deleted', { userId: 'user-1', actorId: null });

    expect(written).toBe(true);
  });

  it('detaches every subscription when unregistered', async () => {
    const bus = makeBus();
    const sink = makeSink();
    const unregister = registerAuditLogSubscriber(bus, { sink });

    unregister();
    await bus.publish('user.deleted', { userId: 'user-1', actorId: null });

    expect(sink.entries).toEqual([]);
    expect(bus.listenerCount('user.deleted')).toBe(0);
  });

  it('does not fail the publisher when the sink is down', async () => {
    const onHandlerError = jest.fn();
    const bus = createEventBus<DomainEventPayloads>({ onHandlerError });
    registerAuditLogSubscriber(bus, {
      sink: {
        record(): Promise<void> {
          return Promise.reject(new Error('disk full'));
        },
      },
    });

    await expect(
      bus.publish('user.deleted', { userId: 'user-1', actorId: null }),
    ).resolves.toBeUndefined();
    expect(onHandlerError).toHaveBeenCalledTimes(1);
  });
});

describe('consoleAuditSink', () => {
  it('writes one JSON line tagged as an audit record', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      consoleAuditSink.record({
        eventId: 'event-1',
        eventName: 'user.deleted',
        occurredAt: '2024-05-01T12:00:00.000Z',
        correlationId: 'req-1',
        actorId: 'admin-9',
        subject: 'user-1',
        attributes: {},
      });

      expect(log).toHaveBeenCalledTimes(1);
      const [line] = log.mock.calls[0] as [string];
      expect(JSON.parse(line)).toMatchObject({
        type: 'audit',
        eventName: 'user.deleted',
        subject: 'user-1',
      });
    } finally {
      log.mockRestore();
    }
  });
});
