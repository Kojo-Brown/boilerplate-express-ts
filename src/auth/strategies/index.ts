import { env } from '@/config/env';
import { createProviderRegistry } from '@/lib/provider-registry';
import type { ProviderRegistry } from '@/lib/provider-registry';
import { inMemoryUserDirectory } from '@/auth/in-memory-user-directory';
import type { UserDirectory } from '@/auth/auth.types';
import type { AuthStrategy, AuthStrategyName } from '@/auth/strategies/auth-strategy.types';
import { createPasswordStrategy } from '@/auth/strategies/password.strategy';
import { createMagicLinkIssuer, createMagicLinkStrategy } from '@/auth/strategies/magic-link.strategy';
import type { MagicLinkIssuer } from '@/auth/strategies/magic-link.strategy';
import { createInMemoryMagicLinkStore } from '@/auth/strategies/magic-link.store';
import type { InspectableMagicLinkStore, MagicLinkStore } from '@/auth/strategies/magic-link.store';
import {
  createRecordingMagicLinkDelivery,
  createUnconfiguredMagicLinkDelivery,
  logMagicLink,
} from '@/auth/strategies/magic-link.delivery';
import type { MagicLinkDelivery } from '@/auth/strategies/magic-link.delivery';
import {
  DEV_API_KEYS,
  createInMemoryApiKeyDirectory,
} from '@/auth/strategies/api-key.directory';
import type { ApiKeyDirectory, ApiKeySeed } from '@/auth/strategies/api-key.directory';
import { createApiKeyStrategy } from '@/auth/strategies/api-key.strategy';

export type AuthStrategyRegistry = ProviderRegistry<AuthStrategyName, AuthStrategy>;

export interface AuthStrategyDeps {
  users: UserDirectory;
  links: MagicLinkStore;
  keys: ApiKeyDirectory;
}

/**
 * The registration table for authentication strategies.
 *
 * `AuthStrategyName` is pinned explicitly rather than inferred, which is what
 * makes this exhaustive: add a name to `AUTH_STRATEGIES` and this object stops
 * satisfying `Record<AuthStrategyName, …>` until its strategy is registered
 * here. The failure lands at the point of registration, not at the first
 * request that happens to ask for the new name.
 *
 * Factories run on first resolve, so a deployment that only ever sees password
 * logins never constructs the magic-link or API key strategies, and never
 * touches the stores behind them.
 */
export function createAuthStrategyRegistry({
  users,
  links,
  keys,
}: AuthStrategyDeps): AuthStrategyRegistry {
  return createProviderRegistry<AuthStrategyName, AuthStrategy>('auth strategy', {
    password: () => createPasswordStrategy({ users }),
    'magic-link': () => createMagicLinkStrategy({ users, links }),
    'api-key': () => createApiKeyStrategy({ keys }),
  });
}

/**
 * Process-wide magic-link store. Its TTL and the issuer's must agree, so both
 * read the same env var rather than each carrying a default.
 */
export const magicLinkStore: InspectableMagicLinkStore = createInMemoryMagicLinkStore({
  ttlSeconds: env.MAGIC_LINK_TTL_SECONDS,
});

type NodeEnv = (typeof env)['NODE_ENV'];

/**
 * In development and test the link is recorded in memory instead of mailed —
 * that is what lets a clean clone log in without an SMTP account and what lets
 * the E2E suite click the link. In production the default refuses to send at
 * all until a real transport is wired; see `magic-link.delivery.ts` for why
 * that is better than either alternative.
 *
 * The token is written to the log only in `development`. Under `test` it is
 * read back through `lastFor()`, and printing it would put credentials in CI
 * output for no benefit.
 *
 * Takes the environment as an argument rather than closing over `env` so the
 * production branch is reachable from a test without re-importing this module
 * under a mutated `process.env`.
 */
export function selectMagicLinkDelivery(nodeEnv: NodeEnv): MagicLinkDelivery {
  if (nodeEnv === 'production') return createUnconfiguredMagicLinkDelivery();
  return createRecordingMagicLinkDelivery(
    nodeEnv === 'development' ? { log: logMagicLink } : {},
  );
}

/**
 * Dev keys are seeded only outside production. A deployment that forgets to
 * hand `createAuthStrategyRegistry` a real directory therefore gets one that
 * authenticates nobody, rather than one whose admin key is published in this
 * repository.
 */
export function selectApiKeySeeds(nodeEnv: NodeEnv): readonly ApiKeySeed[] {
  return nodeEnv === 'production' ? [] : DEV_API_KEYS;
}

export const magicLinkDelivery: MagicLinkDelivery = selectMagicLinkDelivery(env.NODE_ENV);

export const apiKeyDirectory: ApiKeyDirectory = createInMemoryApiKeyDirectory(
  selectApiKeySeeds(env.NODE_ENV),
);

/** Default wiring used by the HTTP layer. */
export const authStrategyRegistry: AuthStrategyRegistry = createAuthStrategyRegistry({
  users: inMemoryUserDirectory,
  links: magicLinkStore,
  keys: apiKeyDirectory,
});

/**
 * Issuing a link is not part of `AuthService`: it produces no session and is
 * meaningless for the other two strategies, so putting it there would make the
 * service's interface depend on which strategies happen to exist.
 */
export const magicLinkIssuer: MagicLinkIssuer = createMagicLinkIssuer({
  users: inMemoryUserDirectory,
  links: magicLinkStore,
  delivery: magicLinkDelivery,
  ttlSeconds: env.MAGIC_LINK_TTL_SECONDS,
});

export { AUTH_STRATEGIES } from '@/auth/strategies/auth-strategy.types';
export type {
  AuthStrategy,
  AuthStrategyName,
  AuthenticatedPrincipal,
} from '@/auth/strategies/auth-strategy.types';
