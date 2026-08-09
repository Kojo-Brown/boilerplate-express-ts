import { createInMemoryTokenStore } from '@/auth/token-store';
import type { DomainEventPayloads } from '@/events/domain-events';
import { createEventBus } from '@/events/event-bus';
import type { AuditEntry } from '@/events/subscribers/audit-log.subscriber';
import { registerDomainSubscribers } from '@/events/subscribers';

describe('registerDomainSubscribers', () => {
  it('attaches audit and session revocation to the same bus', async () => {
    const entries: AuditEntry[] = [];
    const tokens = createInMemoryTokenStore();
    await tokens.add('mock-refresh-token-a', 'user-1');

    const bus = createEventBus<DomainEventPayloads>();
    registerDomainSubscribers(bus, {
      audit: { sink: { record: (entry) => void entries.push(entry) } },
      sessionRevocation: { tokens },
    });

    await bus.publish('user.deleted', { userId: 'user-1', actorId: 'admin-9' });

    expect(entries.map((entry) => entry.eventName)).toEqual(['user.deleted']);
    await expect(tokens.has('mock-refresh-token-a')).resolves.toBe(false);
  });

  it('leaves the bus as it found it when unregistered', async () => {
    const bus = createEventBus<DomainEventPayloads>();
    const unregister = registerDomainSubscribers(bus, {
      audit: { sink: { record: () => undefined } },
      sessionRevocation: { tokens: createInMemoryTokenStore() },
    });

    expect(bus.listenerCount('user.deleted')).toBe(2);
    unregister();

    expect(bus.listenerCount('user.deleted')).toBe(0);
    expect(bus.listenerCount('auth.login.succeeded')).toBe(0);
  });

  it('runs one subscriber even when the other is broken', async () => {
    const onHandlerError = jest.fn();
    const tokens = createInMemoryTokenStore();
    await tokens.add('mock-refresh-token-a', 'user-1');

    const bus = createEventBus<DomainEventPayloads>({ onHandlerError });
    registerDomainSubscribers(bus, {
      audit: {
        sink: {
          record(): void {
            throw new Error('audit sink unavailable');
          },
        },
      },
      sessionRevocation: { tokens },
    });

    await bus.publish('user.deleted', { userId: 'user-1', actorId: null });

    expect(onHandlerError).toHaveBeenCalledTimes(1);
    await expect(tokens.has('mock-refresh-token-a')).resolves.toBe(false);
  });
});
