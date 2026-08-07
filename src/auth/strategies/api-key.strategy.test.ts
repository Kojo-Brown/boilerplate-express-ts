import {
  DEV_API_KEYS,
  createInMemoryApiKeyDirectory,
} from '@/auth/strategies/api-key.directory';
import type { ApiKeySeed } from '@/auth/strategies/api-key.directory';
import { createApiKeyStrategy } from '@/auth/strategies/api-key.strategy';
import { hashSecret } from '@/auth/strategies/secret-hash';
import { ValidationError } from '@/lib/errors';

const SEEDS: readonly ApiKeySeed[] = [
  {
    key: 'mock-api-key-service',
    userId: 'svc-1',
    email: 'service@example.com',
    roles: ['service'],
    label: 'test service key',
  },
];

describe('createInMemoryApiKeyDirectory', () => {
  it('resolves a seeded key by its digest', async () => {
    const directory = createInMemoryApiKeyDirectory(SEEDS);

    await expect(directory.findByHash(hashSecret('mock-api-key-service'))).resolves.toMatchObject({
      userId: 'svc-1',
      label: 'test service key',
    });
  });

  it('does not resolve a key by its plaintext', async () => {
    const directory = createInMemoryApiKeyDirectory(SEEDS);

    await expect(directory.findByHash('mock-api-key-service')).resolves.toBeNull();
  });

  it('does not retain the plaintext on the stored record', async () => {
    const directory = createInMemoryApiKeyDirectory(SEEDS);

    const record = await directory.findByHash(hashSecret('mock-api-key-service'));

    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty('key');
  });

  it('returns null for an unknown digest', async () => {
    const directory = createInMemoryApiKeyDirectory(SEEDS);

    await expect(directory.findByHash(hashSecret('mock-api-key-nope'))).resolves.toBeNull();
  });

  it('is empty when seeded with nothing', async () => {
    const directory = createInMemoryApiKeyDirectory();

    await expect(directory.findByHash(hashSecret('mock-api-key-admin'))).resolves.toBeNull();
  });
});

describe('DEV_API_KEYS', () => {
  it('are obviously fake', () => {
    for (const seed of DEV_API_KEYS) {
      expect(seed.key.startsWith('mock-api-key-')).toBe(true);
    }
  });

  it('map onto the seeded users of the in-memory directory', () => {
    expect(DEV_API_KEYS.map((seed) => seed.email)).toEqual([
      'admin@example.com',
      'user@example.com',
    ]);
  });
});

describe('api-key strategy', () => {
  const strategy = createApiKeyStrategy({ keys: createInMemoryApiKeyDirectory(SEEDS) });

  it('is registered under the name the URL segment uses', () => {
    expect(strategy.name).toBe('api-key');
  });

  it('resolves the principal the key acts as', async () => {
    await expect(strategy.authenticate({ apiKey: 'mock-api-key-service' })).resolves.toEqual({
      id: 'svc-1',
      email: 'service@example.com',
      roles: ['service'],
    });
  });

  it('copies the roles rather than aliasing the directory record', async () => {
    const first = await strategy.authenticate({ apiKey: 'mock-api-key-service' });
    first.roles.push('admin');

    const second = await strategy.authenticate({ apiKey: 'mock-api-key-service' });
    expect(second.roles).toEqual(['service']);
  });

  it('rejects an unknown key with 401', async () => {
    await expect(strategy.authenticate({ apiKey: 'mock-api-key-wrong' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID_API_KEY',
    });
  });

  it('rejects a key that differs by one character', async () => {
    await expect(strategy.authenticate({ apiKey: 'mock-api-key-servicE' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('raises a 422, not a 401, when the body is the wrong shape', async () => {
    await expect(strategy.authenticate({ token: 'wrong-field' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(strategy.authenticate({ apiKey: '' })).rejects.toBeInstanceOf(ValidationError);
  });
});
