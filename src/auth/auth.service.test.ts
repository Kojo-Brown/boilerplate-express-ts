import { authService, createAuthService } from '@/auth/auth.service';
import { tokenStore } from '@/auth/token-store';
import { createAuthStrategyRegistry } from '@/auth/strategies';
import type { AuthStrategyRegistry } from '@/auth/strategies';
import { createInMemoryApiKeyDirectory } from '@/auth/strategies/api-key.directory';
import { createInMemoryMagicLinkStore } from '@/auth/strategies/magic-link.store';
import type {
  AuthUser,
  InspectableRefreshTokenStore,
  RefreshTokenStore,
  UserDirectory,
} from '@/auth/auth.types';

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

describe('authService.logout', () => {
  it('revokes the refresh token', async () => {
    const { refreshToken } = await authService.login({
      email: 'admin@example.com',
      password: 'password',
    });

    await authService.logout(refreshToken);

    await expect(tokenStore.has(refreshToken)).resolves.toBe(false);
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

    await expect(tokenStore.has(login1.refreshToken)).resolves.toBe(false);
    await expect(tokenStore.has(login2.refreshToken)).resolves.toBe(false);
  });
});

describe('createAuthService — injected collaborators', () => {
  // The point of the seam: this suite substitutes both dependencies with plain
  // objects. No jest.mock of the store or the directory, and nothing here
  // touches the process-wide singletons the default wiring uses.

  function makeFakeStore(): InspectableRefreshTokenStore & { addCalls: string[] } {
    const tokens = new Map<string, string>();
    return {
      addCalls: [],
      async add(token: string, userId: string): Promise<void> {
        this.addCalls.push(userId);
        tokens.set(token, userId);
      },
      async has(token: string): Promise<boolean> {
        return tokens.has(token);
      },
      async remove(token: string): Promise<void> {
        tokens.delete(token);
      },
      async removeAllForUser(userId: string): Promise<void> {
        for (const [token, uid] of tokens.entries()) {
          if (uid === userId) tokens.delete(token);
        }
      },
      size: () => tokens.size,
    };
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
    const service = createAuthService({ strategies: makeStrategies(directory), tokens });

    const result = await service.login({ email: 'injected@example.com', password: 'password' });

    expect(result.user.id).toBe('fake-user-1');
    expect(result.user.roles).toEqual(['auditor']);
  });

  it('writes the refresh token to the injected store, not the default one', async () => {
    const tokens = makeFakeStore();
    const before = tokenStore.size();
    const service = createAuthService({ strategies: makeStrategies(directory), tokens });

    await service.login({ email: 'injected@example.com', password: 'password' });

    expect(tokens.addCalls).toEqual(['fake-user-1']);
    expect(tokens.size()).toBe(1);
    expect(tokenStore.size()).toBe(before);
  });

  it('rejects a user the injected directory does not know', async () => {
    const service = createAuthService({ strategies: makeStrategies(directory), tokens: makeFakeStore() });

    await expect(
      service.login({ email: 'admin@example.com', password: 'password' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rotates through the injected store on refresh', async () => {
    const tokens = makeFakeStore();
    const service = createAuthService({ strategies: makeStrategies(directory), tokens });

    const { refreshToken } = await service.login({
      email: 'injected@example.com',
      password: 'password',
    });
    const rotated = await service.refresh(refreshToken);

    expect(rotated.refreshToken).not.toBe(refreshToken);
    await expect(tokens.has(refreshToken)).resolves.toBe(false);
    await expect(tokens.has(rotated.refreshToken)).resolves.toBe(true);
  });

  it('propagates a failure from the injected store rather than swallowing it', async () => {
    const failing: RefreshTokenStore = {
      add: () => Promise.reject(new Error('store unavailable')),
      has: () => Promise.resolve(false),
      remove: () => Promise.resolve(),
      removeAllForUser: () => Promise.resolve(),
    };
    const service = createAuthService({ strategies: makeStrategies(directory), tokens: failing });

    await expect(
      service.login({ email: 'injected@example.com', password: 'password' }),
    ).rejects.toThrow('store unavailable');
  });
});
