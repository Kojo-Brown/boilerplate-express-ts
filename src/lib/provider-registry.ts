import { AppError } from '@/lib/errors';

/**
 * Builds one adapter. Called at most once per key — the registry memoises the
 * result — so a factory is the right place to open a client, read config, or do
 * anything else that should happen lazily rather than at import time.
 */
export type ProviderFactory<TProvider> = () => TProvider;

/**
 * The registration table: one factory per key, and *every* key present.
 *
 * This is where the compile-time exhaustiveness comes from. Pin `TKey` to a
 * union at the call site and the table is checked in both directions — a key in
 * the union with no factory fails to satisfy the `Record`, and a factory whose
 * key is not in the union is rejected as an excess property. Widening the union
 * therefore breaks the build at the registration site, which is the one place
 * that can actually fix it.
 */
export type ProviderFactories<TKey extends string, TProvider> = Readonly<
  Record<TKey, ProviderFactory<TProvider>>
>;

/**
 * Raised when a key that did not come from `TKey` turns out not to be
 * registered. Extends `AppError` so it travels through the existing translator
 * chain instead of arriving at the error middleware as an anonymous 500.
 *
 * 500 rather than 400 is deliberate: `resolveUnknown` is fed by configuration
 * and stored records, not by request bodies. A key that does not resolve means
 * the deployment is misconfigured, and a 4xx would tell the caller to fix
 * something they do not control.
 */
export class UnknownProviderError extends AppError {
  constructor(
    public readonly registryName: string,
    public readonly requestedKey: string,
    public readonly knownKeys: readonly string[],
  ) {
    super(
      500,
      `Unknown ${registryName} provider "${requestedKey}". Registered: ${knownKeys.join(', ')}`,
      'UNKNOWN_PROVIDER',
    );
    this.name = 'UnknownProviderError';
  }
}

export interface ProviderRegistry<TKey extends string, TProvider> {
  /** Registered keys, in registration order. */
  readonly keys: readonly TKey[];

  /**
   * Resolves the adapter for a key the compiler has already vouched for.
   * Memoised: the same instance comes back for the lifetime of the process.
   */
  resolve(key: TKey): TProvider;

  /**
   * Narrows an arbitrary string to a registered key. Use this at the edges —
   * a column value, a header, a feature flag — so the unchecked string is
   * converted once and the rest of the code keeps the union.
   */
  has(key: string): key is TKey;

  /**
   * `resolve` for keys that have not been narrowed, throwing
   * `UnknownProviderError` rather than returning `undefined`. A missing adapter
   * is never something the caller can carry on without.
   */
  resolveUnknown(key: string): TProvider;

  /**
   * Drops every memoised instance; factories run again on the next `resolve`.
   * Exists for tests that need a provider rebuilt against changed
   * configuration — nothing in the request path should call it.
   */
  reset(): void;
}

/**
 * Factory-of-factories: turns a registration table into a lazily-instantiating,
 * memoising registry.
 *
 * `TKey` is inferred from the table's keys when it is not supplied, which is
 * convenient but gives up the exhaustiveness check — an unregistered key simply
 * is not part of the inferred union, so nothing is ever "missing". Pass the
 * union explicitly (`createProviderRegistry<StorageDriver, StorageProvider>`)
 * wherever the set of keys is declared elsewhere and must stay covered.
 *
 * @param name Used in error messages; name the *domain* ("storage"), not the
 * variable, since it is what a misconfigured operator will read.
 */
export function createProviderRegistry<TKey extends string, TProvider>(
  name: string,
  factories: ProviderFactories<TKey, TProvider>,
): ProviderRegistry<TKey, TProvider> {
  // The cast is sound by construction: `factories` is a `Record<TKey, …>`, so
  // its own enumerable keys are exactly `TKey`. `Object.keys` just cannot say so.
  const keys = Object.keys(factories) as TKey[];

  if (keys.length === 0) {
    throw new Error(`Provider registry "${name}" was created with no providers`);
  }

  // A Map rather than the record itself: lookups by an unnarrowed string stay
  // honestly typed as possibly-absent, and no key can collide with something
  // inherited from Object.prototype.
  const factoryByKey = new Map<string, ProviderFactory<TProvider>>(
    keys.map((key): [string, ProviderFactory<TProvider>] => [key, factories[key]]),
  );
  const instanceByKey = new Map<string, TProvider>();

  function instantiate(key: string, factory: ProviderFactory<TProvider>): TProvider {
    const existing = instanceByKey.get(key);
    if (existing !== undefined) return existing;

    const created = factory();
    instanceByKey.set(key, created);
    return created;
  }

  return {
    keys,

    resolve(key: TKey): TProvider {
      const factory = factoryByKey.get(key);
      // Unreachable through the typed signature, but `resolve` is also the
      // implementation `resolveUnknown` delegates to once it has checked.
      if (factory === undefined) {
        throw new UnknownProviderError(name, key, keys);
      }
      return instantiate(key, factory);
    },

    has(key: string): key is TKey {
      return factoryByKey.has(key);
    },

    resolveUnknown(key: string): TProvider {
      const factory = factoryByKey.get(key);
      if (factory === undefined) {
        throw new UnknownProviderError(name, key, keys);
      }
      return instantiate(key, factory);
    },

    reset(): void {
      instanceByKey.clear();
    },
  };
}
