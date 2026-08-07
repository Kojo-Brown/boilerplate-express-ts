import { hashSecret } from '@/auth/strategies/secret-hash';

/** What an accepted API key resolves to. */
export interface ApiKeyRecord {
  /** The user the key acts as. */
  userId: string;
  email: string;
  roles: string[];
  /** Human-readable name for the key, for audit logs and revocation UIs. */
  label: string;
}

/**
 * Where API keys are looked up. One method, taking a digest and never a key —
 * an implementation of this interface is not trusted with a usable credential
 * and a leaked dump of one yields nothing.
 */
export interface ApiKeyDirectory {
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
}

/** A key handed to `createInMemoryApiKeyDirectory` in plaintext, hashed on the way in. */
export interface ApiKeySeed extends ApiKeyRecord {
  key: string;
}

/**
 * In-memory API key directory, replaced by a DB-backed one in Phase 3 by
 * handing a different `ApiKeyDirectory` to `createAuthStrategyRegistry`.
 *
 * Seeds are hashed at construction and the plaintext is not retained, so the
 * directory holds the same thing a real table would.
 */
export function createInMemoryApiKeyDirectory(
  seeds: readonly ApiKeySeed[] = [],
): ApiKeyDirectory {
  const byHash = new Map<string, ApiKeyRecord>(
    seeds.map(({ key, ...record }): [string, ApiKeyRecord] => [hashSecret(key), record]),
  );

  return {
    findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
      return Promise.resolve(byHash.get(keyHash) ?? null);
    },
  };
}

/**
 * Obviously-fake keys for local development, so `POST /v1/auth/login/api-key`
 * can be exercised from a clean clone without provisioning anything.
 *
 * These are not secrets — they are published in this file, in the README and in
 * the tests. That is precisely why the composition root seeds them only outside
 * production: a deployment that forgets to swap in a real `ApiKeyDirectory`
 * gets an empty one that authenticates nobody, rather than a public admin key.
 */
export const DEV_API_KEYS: readonly ApiKeySeed[] = [
  {
    key: 'mock-api-key-admin',
    userId: '1',
    email: 'admin@example.com',
    roles: ['admin', 'user'],
    label: 'local development — admin',
  },
  {
    key: 'mock-api-key-user',
    userId: '2',
    email: 'user@example.com',
    roles: ['user'],
    label: 'local development — user',
  },
];
