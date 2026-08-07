import {
  AUTH_STRATEGIES,
  apiKeyDirectory,
  authStrategyRegistry,
  createAuthStrategyRegistry,
  magicLinkStore,
  selectApiKeySeeds,
  selectMagicLinkDelivery,
} from '@/auth/strategies';
import type { AuthStrategyName } from '@/auth/strategies';
import { createInMemoryApiKeyDirectory } from '@/auth/strategies/api-key.directory';
import { createInMemoryMagicLinkStore } from '@/auth/strategies/magic-link.store';
import { hashSecret } from '@/auth/strategies/secret-hash';
import { UnknownProviderError } from '@/lib/provider-registry';
import { inMemoryUserDirectory } from '@/auth/in-memory-user-directory';

function makeRegistry(): ReturnType<typeof createAuthStrategyRegistry> {
  return createAuthStrategyRegistry({
    users: inMemoryUserDirectory,
    links: createInMemoryMagicLinkStore({ ttlSeconds: 900 }),
    keys: createInMemoryApiKeyDirectory(),
  });
}

describe('auth strategy registry', () => {
  it('registers exactly the declared strategies', () => {
    expect([...makeRegistry().keys].sort()).toEqual([...AUTH_STRATEGIES].sort());
  });

  it('resolves each key to the strategy that key names', () => {
    const registry = makeRegistry();

    // The exhaustiveness check guarantees a factory exists for every key; it
    // cannot notice a factory registered under the *wrong* key, which this does.
    for (const name of AUTH_STRATEGIES) {
      expect(registry.resolve(name).name).toBe(name);
    }
  });

  it('memoises: the same key yields the same instance', () => {
    const registry = makeRegistry();

    expect(registry.resolve('password')).toBe(registry.resolve('password'));
  });

  it('gives each key its own instance', () => {
    const registry = makeRegistry();

    expect(registry.resolve('password')).not.toBe(registry.resolve('api-key'));
  });

  it('narrows a raw segment with has()', () => {
    const registry = makeRegistry();
    const raw: string = 'magic-link';

    expect(registry.has(raw)).toBe(true);
    expect(registry.has('magic')).toBe(false);
    expect(registry.has('')).toBe(false);
    expect(registry.has('toString')).toBe(false);
  });

  it('raises UnknownProviderError for an unregistered key', () => {
    const registry = makeRegistry();

    expect(() => registry.resolveUnknown('sms')).toThrow(UnknownProviderError);
  });

  it('names the registry and the registered keys in that error', () => {
    const registry = makeRegistry();

    expect(() => registry.resolveUnknown('sms')).toThrow(/auth strategy/);
    expect(() => registry.resolveUnknown('sms')).toThrow(/password/);
  });
});

describe('default wiring', () => {
  it('covers every declared strategy', () => {
    for (const name of AUTH_STRATEGIES) {
      expect(authStrategyRegistry.resolve(name).name).toBe(name);
    }
  });

  it('resolves the password strategy against the seeded directory', () => {
    const name: AuthStrategyName = 'password';
    expect(authStrategyRegistry.resolve(name).name).toBe('password');
  });

  it('shares one magic-link store between the issuer and the strategy', async () => {
    // Not a tautology: two `createInMemoryMagicLinkStore()` calls in the module
    // would type-check identically and silently break every link.
    await magicLinkStore.issue(hashSecret('mock-shared-token'), 'user@example.com');

    await expect(
      authStrategyRegistry.resolve('magic-link').authenticate({ token: 'mock-shared-token' }),
    ).resolves.toMatchObject({ email: 'user@example.com' });
  });

  it('seeds the dev API keys outside production', async () => {
    await expect(
      authStrategyRegistry.resolve('api-key').authenticate({ apiKey: 'mock-api-key-admin' }),
    ).resolves.toMatchObject({ email: 'admin@example.com', roles: ['admin', 'user'] });
  });

  it('exposes the same API key directory the strategy resolves through', async () => {
    await expect(apiKeyDirectory.findByHash(hashSecret('mock-api-key-user'))).resolves.toMatchObject(
      { email: 'user@example.com' },
    );
  });
});

describe('environment-dependent wiring', () => {
  it('seeds no API keys in production', () => {
    expect(selectApiKeySeeds('production')).toEqual([]);
  });

  it('seeds the dev keys in development and test', () => {
    expect(selectApiKeySeeds('development').length).toBeGreaterThan(0);
    expect(selectApiKeySeeds('test').length).toBeGreaterThan(0);
  });

  it('refuses to deliver magic links in production until a sender is wired', async () => {
    await expect(
      selectMagicLinkDelivery('production').send({
        email: 'user@example.com',
        token: 'mock-token',
        expiresAt: 0,
      }),
    ).rejects.toMatchObject({ code: 'MAGIC_LINK_DELIVERY_UNCONFIGURED' });
  });

  it('records rather than logs under test, so tokens stay out of CI output', async () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await selectMagicLinkDelivery('test').send({
        email: 'user@example.com',
        token: 'mock-token',
        expiresAt: 0,
      });

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('logs the link under development, where seeing it is the point', async () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await selectMagicLinkDelivery('development').send({
        email: 'user@example.com',
        token: 'mock-token',
        expiresAt: 0,
      });

      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
