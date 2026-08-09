import type { RefreshTokenStore } from '@/auth/auth.types';
import { createInMemoryTokenStore } from '@/auth/token-store';
import type { DomainEventPayloads } from '@/events/domain-events';
import { createEventBus } from '@/events/event-bus';
import { registerSessionRevocationSubscriber } from '@/events/subscribers/session-revocation.subscriber';

describe('registerSessionRevocationSubscriber', () => {
  it('drops every refresh token the deleted user held', async () => {
    const tokens = createInMemoryTokenStore();
    await tokens.add('mock-refresh-token-a', 'user-1');
    await tokens.add('mock-refresh-token-b', 'user-1');

    const bus = createEventBus<DomainEventPayloads>();
    registerSessionRevocationSubscriber(bus, { tokens });

    await bus.publish('user.deleted', { userId: 'user-1', actorId: 'admin-9' });

    await expect(tokens.has('mock-refresh-token-a')).resolves.toBe(false);
    await expect(tokens.has('mock-refresh-token-b')).resolves.toBe(false);
  });

  it('leaves other users’ sessions alone', async () => {
    const tokens = createInMemoryTokenStore();
    await tokens.add('mock-refresh-token-a', 'user-1');
    await tokens.add('mock-refresh-token-b', 'user-2');

    const bus = createEventBus<DomainEventPayloads>();
    registerSessionRevocationSubscriber(bus, { tokens });

    await bus.publish('user.deleted', { userId: 'user-1', actorId: null });

    await expect(tokens.has('mock-refresh-token-b')).resolves.toBe(true);
    expect(tokens.size()).toBe(1);
  });

  it('does not revoke on an update — only deletion ends the sessions', async () => {
    const tokens = createInMemoryTokenStore();
    await tokens.add('mock-refresh-token-a', 'user-1');

    const bus = createEventBus<DomainEventPayloads>();
    registerSessionRevocationSubscriber(bus, { tokens });

    await bus.publish('user.updated', {
      userId: 'user-1',
      changedFields: ['email'],
      actorId: null,
    });

    await expect(tokens.has('mock-refresh-token-a')).resolves.toBe(true);
  });

  it('has finished revoking by the time publish resolves', async () => {
    // What lets the controller await the publish before answering 204.
    const order: string[] = [];
    const tokens: RefreshTokenStore = {
      add: () => Promise.resolve(),
      has: () => Promise.resolve(false),
      remove: () => Promise.resolve(),
      async removeAllForUser(): Promise<void> {
        await Promise.resolve();
        order.push('revoked');
      },
    };

    const bus = createEventBus<DomainEventPayloads>();
    registerSessionRevocationSubscriber(bus, { tokens });

    await bus.publish('user.deleted', { userId: 'user-1', actorId: null });
    order.push('publish resolved');

    expect(order).toEqual(['revoked', 'publish resolved']);
  });

  it('reports a failing store instead of failing the delete that published', async () => {
    const onHandlerError = jest.fn();
    const bus = createEventBus<DomainEventPayloads>({ onHandlerError });
    registerSessionRevocationSubscriber(bus, {
      tokens: {
        add: () => Promise.resolve(),
        has: () => Promise.resolve(false),
        remove: () => Promise.resolve(),
        removeAllForUser: () => Promise.reject(new Error('token store unavailable')),
      },
    });

    await expect(
      bus.publish('user.deleted', { userId: 'user-1', actorId: null }),
    ).resolves.toBeUndefined();

    // The documented cost of isolation: the tokens are still live and the log
    // is the only trace. Asserted so the trade-off cannot be silently lost.
    expect(onHandlerError).toHaveBeenCalledTimes(1);
    const [error, event] = onHandlerError.mock.calls[0] as [Error, { name: string }];
    expect(error.message).toBe('token store unavailable');
    expect(event.name).toBe('user.deleted');
  });

  it('stops revoking once unregistered', async () => {
    const tokens = createInMemoryTokenStore();
    await tokens.add('mock-refresh-token-a', 'user-1');

    const bus = createEventBus<DomainEventPayloads>();
    const unregister = registerSessionRevocationSubscriber(bus, { tokens });
    unregister();

    await bus.publish('user.deleted', { userId: 'user-1', actorId: null });

    await expect(tokens.has('mock-refresh-token-a')).resolves.toBe(true);
  });
});
