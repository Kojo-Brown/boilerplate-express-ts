import { authService, createAuthService } from '@/auth/auth.service';
import type { AuthService } from '@/auth/auth.service';
import { createInMemoryTokenStore, tokenStore } from '@/auth/token-store';
import { authStrategyRegistry, createAuthStrategyRegistry } from '@/auth/strategies';
import type { AuthStrategyRegistry } from '@/auth/strategies';
import { createInMemoryApiKeyDirectory } from '@/auth/strategies/api-key.directory';
import { createInMemoryMagicLinkStore } from '@/auth/strategies/magic-link.store';
import type {
  AuthUser,
  InspectableRefreshTokenStore,
  NewRefreshToken,
  RefreshResponse,
  RefreshTokenStore,
  UserDirectory,
} from '@/auth/auth.types';
import type { DomainEventBus, DomainEventPayloads } from '@/events';
import { createEventBus, domainEventBus } from '@/events';

// env vars injected via jest.setup.ts before any module is loaded

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

describe('authService.login', () => {
  it('returns tokens and user on valid credentials', async () => {
    const result = await authService.login({
      email: 'admin@example.com',
      password: 'password',
    });

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user.email).toBe('admin@example.com');
    expect(result.user.roles).toContain('admin');
  });

  it('stores the refresh token in the token store', async () => {
    const before = tokenStore.size();
    await authService.login({ email: 'user@example.com', password: 'password' });
    expect(tokenStore.size()).toBeGreaterThan(before);
  });

  it('throws 401 on wrong password', async () => {
    await expect(
      authService.login({ email: 'admin@example.com', password: 'wrong' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws 401 on unknown email', async () => {
    await expect(
      authService.login({ email: 'nobody@example.com', password: 'password' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.refresh', () => {
  it('issues a rotated token pair for a valid refresh token', async () => {
    const { refreshToken } = await authService.login({
      email: 'user@example.com',
      password: 'password',
    });

    const result = await authService.refresh(refreshToken);

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.refreshToken).not.toBe(refreshToken);
  });

  it('rejects a refresh token that was already used (rotation)', async () => {
    const { refreshToken } = await authService.login({
      email: 'admin@example.com',
      password: 'password',
    });

    await authService.refresh(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a revoked refresh token', async () => {
    const { refreshToken } = await authService.login({
      email: 'user@example.com',
      password: 'password',
    });

    await authService.logout(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a garbage token string', async () => {
    await expect(authService.refresh('not.a.valid.token')).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe('authService.refresh — reuse detection', () => {
  /**
   * These go through a store of their own rather than the process-wide
   * singleton, because the assertions are about which tokens survive a
   * revocation and the shared store carries whatever every other suite in this
   * file has logged in with.
   */
  function makeService(): { service: AuthService; tokens: InspectableRefreshTokenStore } {
    const tokens = createInMemoryTokenStore();
    return {
      tokens,
      service: createAuthService({
        strategies: authStrategyRegistry,
        tokens,
        events: createEventBus<DomainEventPayloads>(),
      }),
    };
  }

  it('kills the whole chain when a spent token comes back, not just that token', async () => {
    // The case the feature exists for. The session rotates a few times, then
    // an old link in the chain is presented again — which means someone has a
    // copy of it, and the copy is as likely to be the live end of the chain as
    // the spent one. The current token dies with it.
    const { service, tokens } = makeService();
    const login = await service.login({ email: 'user@example.com', password: 'password' });

    const second = await service.refresh(login.refreshToken);
    const third = await service.refresh(second.refreshToken);
    await expect(tokens.isActive(third.refreshToken)).resolves.toBe(true);

    await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });

    // Without family revocation this stays live and the attacker keeps the
    // session — the detection would have fired and changed nothing.
    await expect(tokens.isActive(third.refreshToken)).resolves.toBe(false);
    await expect(service.refresh(third.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('leaves the user other sessions', async () => {
    // Family and not user: a second device is a separate chain, and logging
    // someone out of their laptop because their phone replayed a token is a
    // blast radius the evidence does not support.
    const { service, tokens } = makeService();
    const laptop = await service.login({ email: 'user@example.com', password: 'password' });
    const phone = await service.login({ email: 'user@example.com', password: 'password' });

    await service.refresh(phone.refreshToken);
    await expect(service.refresh(phone.refreshToken)).rejects.toMatchObject({ statusCode: 401 });

    await expect(tokens.isActive(laptop.refreshToken)).resolves.toBe(true);
  });

  it('keeps the successor alive across an ordinary rotation', async () => {
    // The other half of the claim: detection that fired on a normal refresh
    // would log every user out every few minutes, and would also pass the test
    // above.
    const { service, tokens } = makeService();
    const login = await service.login({ email: 'user@example.com', password: 'password' });

    const second = await service.refresh(login.refreshToken);
    const third = await service.refresh(second.refreshToken);

    await expect(tokens.isActive(third.refreshToken)).resolves.toBe(true);
  });

  it('publishes auth.refresh.reused naming the family and what it cost', async () => {
    const tokens = createInMemoryTokenStore();
    const bus = createEventBus<DomainEventPayloads>();
    const reuses: DomainEventPayloads['auth.refresh.reused'][] = [];
    bus.on('auth.refresh.reused', (event) => void reuses.push(event.payload));

    const service = createAuthService({ strategies: authStrategyRegistry, tokens, events: bus });
    const login = await service.login({ email: 'user@example.com', password: 'password' });
    await service.refresh(login.refreshToken);

    await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });

    expect(reuses).toHaveLength(1);
    expect(reuses[0]).toMatchObject({ userId: '2', revokedCount: 2 });
    expect(typeof reuses[0]?.familyId).toBe('string');
  });

  it('carries no token material in the reuse event', async () => {
    // The payload reaches every sink the bus has, including durable ones.
    const tokens = createInMemoryTokenStore();
    const bus = createEventBus<DomainEventPayloads>();
    const reuses: DomainEventPayloads['auth.refresh.reused'][] = [];
    bus.on('auth.refresh.reused', (event) => void reuses.push(event.payload));

    const service = createAuthService({ strategies: authStrategyRegistry, tokens, events: bus });
    const login = await service.login({ email: 'user@example.com', password: 'password' });
    await service.refresh(login.refreshToken);
    await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });

    const serialised = JSON.stringify(reuses);
    expect(serialised).not.toContain(login.refreshToken);
    expect(serialised).not.toContain(login.accessToken);
  });

  it('does not publish reuse for a token that was merely logged out', async () => {
    // A stale client after a logout is ordinary. Firing the theft signal here
    // would bury the real one under it.
    const tokens = createInMemoryTokenStore();
    const bus = createEventBus<DomainEventPayloads>();
    const reuses: DomainEventPayloads['auth.refresh.reused'][] = [];
    bus.on('auth.refresh.reused', (event) => void reuses.push(event.payload));

    const service = createAuthService({ strategies: authStrategyRegistry, tokens, events: bus });
    const login = await service.login({ email: 'user@example.com', password: 'password' });
    await service.logout(login.refreshToken);

    await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
    expect(reuses).toEqual([]);
  });

  it('does not re-publish reuse for a family it has already killed', async () => {
    // Otherwise an attacker retrying in a loop is an alert per attempt.
    const tokens = createInMemoryTokenStore();
    const bus = createEventBus<DomainEventPayloads>();
    const reuses: DomainEventPayloads['auth.refresh.reused'][] = [];
    bus.on('auth.refresh.reused', (event) => void reuses.push(event.payload));

    const service = createAuthService({ strategies: authStrategyRegistry, tokens, events: bus });
    const login = await service.login({ email: 'user@example.com', password: 'password' });
    await service.refresh(login.refreshToken);

    await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });

    expect(reuses).toHaveLength(1);
  });

  it('answers a reused token with the same code as any other dead one', async () => {
    // A distinct code would tell whoever holds the token that the server
    // noticed — useless to a legitimate client, informative to an attacker.
    const { service } = makeService();
    const reusable = await service.login({ email: 'user@example.com', password: 'password' });
    await service.refresh(reusable.refreshToken);

    const revoked = await service.login({ email: 'user@example.com', password: 'password' });
    await service.logout(revoked.refreshToken);

    await expect(service.refresh(reusable.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_REVOKED',
    });
    await expect(service.refresh(revoked.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_REVOKED',
    });
  });

  it('resolves concurrent refreshes of one token to a single live successor', async () => {
    // Two refreshes racing is a retry, not an attack, but the pair still has
    // to settle deterministically: one successor, and the loser reported as
    // reuse rather than quietly handed a second live token.
    const { service, tokens } = makeService();
    const login = await service.login({ email: 'user@example.com', password: 'password' });

    const results = await Promise.allSettled([
      service.refresh(login.refreshToken),
      service.refresh(login.refreshToken),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    // And the winner's token is revoked too, because the loser's presentation
    // was a reuse and took the family with it.
    const winner = (fulfilled[0] as PromiseFulfilledResult<RefreshResponse>).value;
    await expect(tokens.isActive(winner.refreshToken)).resolves.toBe(false);
  });
});

describe('authService.logout', () => {
  it('revokes the refresh token', async () => {
    const { refreshToken } = await authService.login({
      email: 'admin@example.com',
      password: 'password',
    });

    await authService.logout(refreshToken);

    await expect(tokenStore.isActive(refreshToken)).resolves.toBe(false);
  });

  it('is idempotent for an already-logged-out token', async () => {
    const { refreshToken } = await authService.login({
      email: 'user@example.com',
      password: 'password',
    });

    await authService.logout(refreshToken);
    await expect(authService.logout(refreshToken)).resolves.toBeUndefined();
  });

  it('is idempotent for a completely invalid token', async () => {
    await expect(authService.logout('garbage-token')).resolves.toBeUndefined();
  });
});

describe('authService.logoutAll', () => {
  it('revokes all refresh tokens for a user', async () => {
    const login1 = await authService.login({ email: 'admin@example.com', password: 'password' });
    const login2 = await authService.login({ email: 'admin@example.com', password: 'password' });

    await authService.logoutAll('1');

    await expect(tokenStore.isActive(login1.refreshToken)).resolves.toBe(false);
    await expect(tokenStore.isActive(login2.refreshToken)).resolves.toBe(false);
  });
});

describe('createAuthService — injected collaborators', () => {
  // The point of the seam: this suite substitutes both dependencies with plain
  // objects. No jest.mock of the store or the directory, and nothing here
  // touches the process-wide singletons the default wiring uses.

  /**
   * A *separate instance* of the real store with `issue` recorded, rather than
   * a second implementation of it.
   *
   * What this suite is demonstrating is the seam — that the service writes to
   * the store it was handed and never to the process-wide one — and a fresh
   * instance shows that just as well as a hand-rolled map. Re-implementing the
   * store here would mean two versions of the rotation rules, and the fake
   * would be the one with no reuse detection in it: `consume` would hand back
   * whatever the fake's author found convenient, and every assertion about
   * what the service does on reuse would be an assertion about this file.
   */
  function makeFakeStore(): InspectableRefreshTokenStore & { issuedFor: string[] } {
    const store = createInMemoryTokenStore();
    const issuedFor: string[] = [];

    return {
      ...store,
      issuedFor,
      async issue(record: NewRefreshToken): Promise<void> {
        issuedFor.push(record.userId);
        await store.issue(record);
      },
    };
  }

  /**
   * A real bus with recording subscribers rather than a stubbed one: the
   * assertions below are about what the service publishes, and a hand-written
   * fake would let a payload that no subscriber could actually consume pass.
   */
  function makeRecordingBus(): {
    bus: DomainEventBus;
    logins: DomainEventPayloads['auth.login.succeeded'][];
    revocations: DomainEventPayloads['auth.session.revoked'][];
    reuses: DomainEventPayloads['auth.refresh.reused'][];
  } {
    const bus = createEventBus<DomainEventPayloads>();
    const logins: DomainEventPayloads['auth.login.succeeded'][] = [];
    const revocations: DomainEventPayloads['auth.session.revoked'][] = [];
    const reuses: DomainEventPayloads['auth.refresh.reused'][] = [];

    bus.on('auth.login.succeeded', (event) => {
      logins.push(event.payload);
    });
    bus.on('auth.session.revoked', (event) => {
      revocations.push(event.payload);
    });
    bus.on('auth.refresh.reused', (event) => {
      reuses.push(event.payload);
    });

    return { bus, logins, revocations, reuses };
  }

  const fakeUser: AuthUser = {
    id: 'fake-user-1',
    email: 'injected@example.com',
    passwordHash: 'not-a-real-hash',
    roles: ['auditor'],
  };

  const directory: UserDirectory = {
    async findByEmail(email: string): Promise<AuthUser | null> {
      return email === fakeUser.email ? fakeUser : null;
    },
  };

  // The service reaches its users through the strategy registry now, so the
  // seam this suite exercises is the registry. Building a real one over the
  // fake directory — rather than stubbing the registry itself — keeps the
  // password strategy's own credential parsing and 401 in the path under test.
  function makeStrategies(users: UserDirectory): AuthStrategyRegistry {
    return createAuthStrategyRegistry({
      users,
      links: createInMemoryMagicLinkStore({ ttlSeconds: 900 }),
      keys: createInMemoryApiKeyDirectory(),
    });
  }

  it('logs in against an injected directory the singletons know nothing about', async () => {
    const tokens = makeFakeStore();
    const service = createAuthService({
      strategies: makeStrategies(directory),
      tokens,
      events: domainEventBus,
    });

    const result = await service.login({ email: 'injected@example.com', password: 'password' });

    expect(result.user.id).toBe('fake-user-1');
    expect(result.user.roles).toEqual(['auditor']);
  });

  it('writes the refresh token to the injected store, not the default one', async () => {
    const tokens = makeFakeStore();
    const before = tokenStore.size();
    const service = createAuthService({
      strategies: makeStrategies(directory),
      tokens,
      events: domainEventBus,
    });

    await service.login({ email: 'injected@example.com', password: 'password' });

    expect(tokens.issuedFor).toEqual(['fake-user-1']);
    expect(tokens.size()).toBe(1);
    expect(tokenStore.size()).toBe(before);
  });

  it('rejects a user the injected directory does not know', async () => {
    const service = createAuthService({
      strategies: makeStrategies(directory),
      tokens: makeFakeStore(),
      events: domainEventBus,
    });

    await expect(
      service.login({ email: 'admin@example.com', password: 'password' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rotates through the injected store on refresh', async () => {
    const tokens = makeFakeStore();
    const service = createAuthService({
      strategies: makeStrategies(directory),
      tokens,
      events: domainEventBus,
    });

    const { refreshToken } = await service.login({
      email: 'injected@example.com',
      password: 'password',
    });
    const rotated = await service.refresh(refreshToken);

    expect(rotated.refreshToken).not.toBe(refreshToken);
    await expect(tokens.isActive(refreshToken)).resolves.toBe(false);
    await expect(tokens.isActive(rotated.refreshToken)).resolves.toBe(true);
  });

  it('propagates a failure from the injected store rather than swallowing it', async () => {
    const failing: RefreshTokenStore = {
      issue: () => Promise.reject(new Error('store unavailable')),
      consume: () => Promise.resolve({ outcome: 'unknown' }),
      revoke: () => Promise.resolve(),
      revokeFamily: () => Promise.resolve(0),
      revokeAllForUser: () => Promise.resolve(),
      isActive: () => Promise.resolve(false),
    };
    const service = createAuthService({
      strategies: makeStrategies(directory),
      tokens: failing,
      events: domainEventBus,
    });

    await expect(
      service.login({ email: 'injected@example.com', password: 'password' }),
    ).rejects.toThrow('store unavailable');
  });

  describe('domain events', () => {
    it('publishes auth.login.succeeded naming the strategy that authenticated', async () => {
      const { bus, logins } = makeRecordingBus();
      const service = createAuthService({
        strategies: makeStrategies(directory),
        tokens: makeFakeStore(),
        events: bus,
      });

      await service.login({ email: 'injected@example.com', password: 'password' });

      expect(logins).toEqual([{ userId: 'fake-user-1', strategy: 'password' }]);
    });

    it('never puts a token in a login payload', async () => {
      const { bus, logins } = makeRecordingBus();
      const service = createAuthService({
        strategies: makeStrategies(directory),
        tokens: makeFakeStore(),
        events: bus,
      });

      const result = await service.login({
        email: 'injected@example.com',
        password: 'password',
      });

      const serialised = JSON.stringify(logins);
      expect(serialised).not.toContain(result.accessToken);
      expect(serialised).not.toContain(result.refreshToken);
    });

    it('publishes nothing when authentication fails', async () => {
      const { bus, logins } = makeRecordingBus();
      const service = createAuthService({
        strategies: makeStrategies(directory),
        tokens: makeFakeStore(),
        events: bus,
      });

      await expect(
        service.login({ email: 'injected@example.com', password: 'wrong' }),
      ).rejects.toMatchObject({ statusCode: 401 });

      expect(logins).toEqual([]);
    });

    it('publishes a single-scope revocation on logout', async () => {
      const { bus, revocations } = makeRecordingBus();
      const service = createAuthService({
        strategies: makeStrategies(directory),
        tokens: makeFakeStore(),
        events: bus,
      });

      const { refreshToken } = await service.login({
        email: 'injected@example.com',
        password: 'password',
      });
      await service.logout(refreshToken);

      expect(revocations).toEqual([{ userId: 'fake-user-1', scope: 'single' }]);
    });

    it('publishes nothing when logout is handed a token it cannot verify', async () => {
      const { bus, revocations } = makeRecordingBus();
      const service = createAuthService({
        strategies: makeStrategies(directory),
        tokens: makeFakeStore(),
        events: bus,
      });

      await service.logout('not-a-token');

      expect(revocations).toEqual([]);
    });

    it('publishes an all-scope revocation on logoutAll', async () => {
      const { bus, revocations } = makeRecordingBus();
      const service = createAuthService({
        strategies: makeStrategies(directory),
        tokens: makeFakeStore(),
        events: bus,
      });

      await service.logoutAll('fake-user-1');

      expect(revocations).toEqual([{ userId: 'fake-user-1', scope: 'all' }]);
    });

    it('does not publish on refresh — rotation is not a new session', async () => {
      const { bus, logins, revocations } = makeRecordingBus();
      const service = createAuthService({
        strategies: makeStrategies(directory),
        tokens: makeFakeStore(),
        events: bus,
      });

      const { refreshToken } = await service.login({
        email: 'injected@example.com',
        password: 'password',
      });
      await service.refresh(refreshToken);

      expect(logins).toHaveLength(1);
      expect(revocations).toEqual([]);
    });

    it('completes the login even when a subscriber throws', async () => {
      const onHandlerError = jest.fn();
      const bus = createEventBus<DomainEventPayloads>({ onHandlerError });
      bus.on('auth.login.succeeded', () => {
        throw new Error('audit sink unavailable');
      });

      const service = createAuthService({
        strategies: makeStrategies(directory),
        tokens: makeFakeStore(),
        events: bus,
      });

      const result = await service.login({
        email: 'injected@example.com',
        password: 'password',
      });

      expect(result.user.id).toBe('fake-user-1');
      expect(onHandlerError).toHaveBeenCalledTimes(1);
    });
  });
});
