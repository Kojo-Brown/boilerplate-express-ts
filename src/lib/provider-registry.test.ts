import { AppError } from '@/lib/errors';
import { createProviderRegistry, UnknownProviderError } from '@/lib/provider-registry';

interface Greeter {
  greet(): string;
}

type Locale = 'en' | 'fr';

function makeRegistry(): ReturnType<typeof createProviderRegistry<Locale, Greeter>> {
  return createProviderRegistry<Locale, Greeter>('greeter', {
    en: () => ({ greet: () => 'hello' }),
    fr: () => ({ greet: () => 'bonjour' }),
  });
}

describe('createProviderRegistry', () => {
  it('resolves the adapter registered under each key', () => {
    const registry = makeRegistry();

    expect(registry.resolve('en').greet()).toBe('hello');
    expect(registry.resolve('fr').greet()).toBe('bonjour');
  });

  it('exposes the registered keys in registration order', () => {
    expect(makeRegistry().keys).toEqual(['en', 'fr']);
  });

  it('rejects an empty registration table', () => {
    expect(() => createProviderRegistry<never, Greeter>('greeter', {})).toThrow(
      'Provider registry "greeter" was created with no providers',
    );
  });
});

describe('lazy instantiation', () => {
  it('does not run any factory until a key is resolved', () => {
    const en = jest.fn((): Greeter => ({ greet: () => 'hello' }));
    const fr = jest.fn((): Greeter => ({ greet: () => 'bonjour' }));

    const registry = createProviderRegistry<Locale, Greeter>('greeter', { en, fr });

    expect(en).not.toHaveBeenCalled();
    expect(fr).not.toHaveBeenCalled();

    registry.resolve('en');

    // The unresolved factory stays untouched — this is what lets a deployment
    // configured for one driver skip the other's credentials entirely.
    expect(en).toHaveBeenCalledTimes(1);
    expect(fr).not.toHaveBeenCalled();
  });

  it('memoises the instance so repeated resolves share one adapter', () => {
    const en = jest.fn((): Greeter => ({ greet: () => 'hello' }));
    const registry = createProviderRegistry<Locale, Greeter>('greeter', {
      en,
      fr: () => ({ greet: () => 'bonjour' }),
    });

    const first = registry.resolve('en');
    const second = registry.resolve('en');

    expect(first).toBe(second);
    expect(en).toHaveBeenCalledTimes(1);
  });

  it('memoises resolveUnknown and resolve against the same cache', () => {
    const en = jest.fn((): Greeter => ({ greet: () => 'hello' }));
    const registry = createProviderRegistry<Locale, Greeter>('greeter', {
      en,
      fr: () => ({ greet: () => 'bonjour' }),
    });

    expect(registry.resolveUnknown('en')).toBe(registry.resolve('en'));
    expect(en).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the adapter after reset', () => {
    const en = jest.fn((): Greeter => ({ greet: () => 'hello' }));
    const registry = createProviderRegistry<Locale, Greeter>('greeter', {
      en,
      fr: () => ({ greet: () => 'bonjour' }),
    });

    const before = registry.resolve('en');
    registry.reset();
    const after = registry.resolve('en');

    expect(after).not.toBe(before);
    expect(en).toHaveBeenCalledTimes(2);
  });
});

describe('has', () => {
  it('narrows a registered string to a key', () => {
    const registry = makeRegistry();
    const fromConfig: string = 'fr';

    if (!registry.has(fromConfig)) throw new Error('expected fr to be registered');

    // Compiles only because `has` is a type predicate: `resolve` takes `Locale`.
    expect(registry.resolve(fromConfig).greet()).toBe('bonjour');
  });

  it('rejects an unregistered string', () => {
    expect(makeRegistry().has('de')).toBe(false);
  });

  it('rejects inherited Object properties', () => {
    // A plain-object lookup would answer `true` for these and then resolve
    // `Object.prototype.constructor` as though it were an adapter.
    const registry = makeRegistry();

    expect(registry.has('constructor')).toBe(false);
    expect(registry.has('toString')).toBe(false);
  });
});

describe('resolveUnknown', () => {
  it('resolves a key that happens to be registered', () => {
    expect(makeRegistry().resolveUnknown('en').greet()).toBe('hello');
  });

  it('throws UnknownProviderError naming the registry and the valid keys', () => {
    let thrown: unknown;
    try {
      makeRegistry().resolveUnknown('de');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UnknownProviderError);
    const err = thrown as UnknownProviderError;
    expect(err.registryName).toBe('greeter');
    expect(err.requestedKey).toBe('de');
    expect(err.knownKeys).toEqual(['en', 'fr']);
    expect(err.message).toBe('Unknown greeter provider "de". Registered: en, fr');
  });

  it('reports 500 through the AppError contract', () => {
    // Misconfiguration, not a bad request: the caller cannot pick the driver.
    const err = new UnknownProviderError('storage', 'gcs', ['s3', 'memory']);

    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('UNKNOWN_PROVIDER');
  });
});
