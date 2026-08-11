import { createContainer, createToken } from '@/lib/container';
import type { Container } from '@/lib/container';
import {
  CaptiveDependencyError,
  CircularDependencyError,
  DisposedError,
  DuplicateRegistrationError,
  MissingSeedError,
  ScopeRequiredError,
  SeedConflictError,
  UnregisteredTokenError,
} from '@/lib/container/container.errors';

interface Counter {
  readonly id: number;
}

let nextId = 0;
function makeCounter(): Counter {
  nextId += 1;
  return { id: nextId };
}

const A = createToken<Counter>('A');
const B = createToken<Counter>('B');
const C = createToken<Counter>('C');

function container(): Container {
  return createContainer({ name: 'test', onDisposeError: () => {} });
}

beforeEach(() => {
  nextId = 0;
});

describe('createToken', () => {
  it('gives distinct identities to tokens with the same description', () => {
    const first = createToken<Counter>('shared-description');
    const second = createToken<Counter>('shared-description');

    const c = container();
    c.registerValue(first, { id: 1 });
    c.registerValue(second, { id: 2 });

    expect(c.resolve(first).id).toBe(1);
    expect(c.resolve(second).id).toBe(2);
  });
});

describe('singleton lifetime', () => {
  it('runs the factory once and shares the instance', () => {
    const factory = jest.fn(makeCounter);
    const c = container().registerSingleton(A, factory);

    expect(c.resolve(A)).toBe(c.resolve(A));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('shares one instance across every scope', () => {
    const c = container().registerSingleton(A, makeCounter);

    const first = c.createScope('one').resolve(A);
    const second = c.createScope('two').resolve(A);

    expect(first).toBe(second);
    expect(first).toBe(c.resolve(A));
  });

  it('memoises a factory that legitimately returns undefined', () => {
    // `undefined` is a value, not a cache miss. Storing presence separately
    // from the value is what keeps this from re-running forever.
    const nothing = createToken<undefined>('nothing');
    const factory = jest.fn(() => undefined);
    const c = container().registerSingleton(nothing, factory);

    expect(c.resolve(nothing)).toBeUndefined();
    expect(c.resolve(nothing)).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('resolves its own dependencies', () => {
    const c = container()
      .registerSingleton(B, makeCounter)
      .registerSingleton(A, (resolve) => ({ id: resolve.resolve(B).id + 100 }));

    expect(c.resolve(A).id).toBe(101);
  });
});

describe('scoped lifetime', () => {
  it('gives one instance per scope', () => {
    const c = container().registerScoped(A, makeCounter);
    const scope = c.createScope();

    expect(scope.resolve(A)).toBe(scope.resolve(A));
    expect(c.createScope().resolve(A)).not.toBe(scope.resolve(A));
  });

  it('refuses to resolve from the root container', () => {
    const c = container().registerScoped(A, makeCounter);

    expect(() => c.resolve(A)).toThrow(ScopeRequiredError);
    expect(() => c.resolve(A)).toThrow(/cannot be resolved from the root container/);
  });

  it('may depend on a singleton', () => {
    const c = container()
      .registerSingleton(B, makeCounter)
      .registerScoped(A, (resolve) => ({ id: resolve.resolve(B).id }));

    expect(c.createScope().resolve(A).id).toBe(c.resolve(B).id);
  });
});

describe('transient lifetime', () => {
  it('builds a new instance on every resolve', () => {
    const c = container().registerTransient(A, makeCounter);
    const scope = c.createScope();

    expect(c.resolve(A)).not.toBe(c.resolve(A));
    expect(scope.resolve(A)).not.toBe(scope.resolve(A));
  });

  it('resolves its dependencies in the scope that asked for it', () => {
    const c = container()
      .registerScoped(B, makeCounter)
      .registerTransient(A, (resolve) => ({ id: resolve.resolve(B).id }));

    const scope = c.createScope();
    // Two transients, one scoped dependency: the scope is what they share.
    expect(scope.resolve(A).id).toBe(scope.resolve(A).id);
    expect(c.createScope().resolve(A).id).not.toBe(scope.resolve(A).id);
  });
});

describe('captive dependencies', () => {
  it('rejects a singleton that depends on a scoped registration', () => {
    const c = container()
      .registerScoped(B, makeCounter)
      .registerSingleton(A, (resolve) => resolve.resolve(B));

    expect(() => c.createScope().resolve(A)).toThrow(CaptiveDependencyError);
    expect(() => c.createScope().resolve(A)).toThrow(/"A" cannot depend on scoped "B"/);
  });

  it('rejects it through an intermediate transient, and names the whole path', () => {
    const c = container()
      .registerScoped(C, makeCounter)
      .registerTransient(B, (resolve) => resolve.resolve(C))
      .registerSingleton(A, (resolve) => resolve.resolve(B));

    expect(() => c.createScope().resolve(A)).toThrow(/resolving A → B → C/);
  });

  it('rejects a singleton that depends on a seeded token', () => {
    const c = container()
      .registerSeed(B)
      .registerSingleton(A, (resolve) => resolve.resolve(B));

    const scope = c.createScope();
    scope.seed(B, { id: 7 });

    // The value is right there in the scope, and it still fails: a singleton
    // that took it would serve request one's value to every later request.
    expect(() => scope.resolve(A)).toThrow(CaptiveDependencyError);
  });
});

describe('cycles and missing registrations', () => {
  it('reports a cycle with the path that produced it', () => {
    const c = container()
      .registerSingleton(A, (resolve) => resolve.resolve(B))
      .registerSingleton(B, (resolve) => resolve.resolve(A));

    expect(() => c.resolve(A)).toThrow(CircularDependencyError);
    expect(() => c.resolve(A)).toThrow(/Circular dependency: A → B → A/);
  });

  it('reports a self-referential factory', () => {
    const c = container().registerTransient(A, (resolve) => resolve.resolve(A));

    expect(() => c.resolve(A)).toThrow(/Circular dependency: A → A/);
  });

  it('names the resolution path when a dependency was never registered', () => {
    const c = container().registerSingleton(A, (resolve) => resolve.resolve(B));

    expect(() => c.resolve(A)).toThrow(UnregisteredTokenError);
    expect(() => c.resolve(A)).toThrow(/No registration for "B" \(resolving A → B\)/);
  });

  it('refuses to register the same token twice', () => {
    const c = container().registerSingleton(A, makeCounter);

    expect(() => c.registerSingleton(A, makeCounter)).toThrow(DuplicateRegistrationError);
    expect(() => c.registerValue(A, { id: 1 })).toThrow(DuplicateRegistrationError);
  });

  it('reports has() per token', () => {
    const c = container().registerSingleton(A, makeCounter);

    expect(c.has(A)).toBe(true);
    expect(c.has(B)).toBe(false);
  });
});

describe('seeded tokens', () => {
  it('resolves the value the scope was given', () => {
    const c = container().registerSeed(A);
    const scope = c.createScope();
    const value = { id: 42 };

    scope.seed(A, value);

    expect(scope.resolve(A)).toBe(value);
  });

  it('keeps seeds scope-local', () => {
    const c = container().registerSeed(A);
    const seeded = c.createScope();
    seeded.seed(A, { id: 1 });

    expect(() => c.createScope().resolve(A)).toThrow(MissingSeedError);
  });

  it('rejects a second seed for the same token', () => {
    const c = container().registerSeed(A);
    const scope = c.createScope();
    scope.seed(A, { id: 1 });

    expect(() => scope.seed(A, { id: 2 })).toThrow(SeedConflictError);
  });

  it('rejects seeding a token that has a factory', () => {
    const c = container().registerScoped(A, makeCounter);

    expect(() => c.createScope().seed(A, { id: 1 })).toThrow(SeedConflictError);
  });

  it('rejects seeding an unregistered token', () => {
    expect(() => container().createScope().seed(A, { id: 1 })).toThrow(UnregisteredTokenError);
  });
});

describe('disposal', () => {
  it('disposes a scope’s instances in reverse creation order', async () => {
    const closed: string[] = [];
    const c = container()
      .registerScoped(A, makeCounter, { dispose: () => void closed.push('A') })
      .registerScoped(B, (resolve) => ({ id: resolve.resolve(A).id }), {
        dispose: () => void closed.push('B'),
      });

    const scope = c.createScope();
    scope.resolve(B);
    await scope.dispose();

    // A was built first because B needed it, so B lets go first.
    expect(closed).toEqual(['B', 'A']);
  });

  it('awaits async disposers', async () => {
    const closed: string[] = [];
    const c = container().registerScoped(A, makeCounter, {
      dispose: async () => {
        await Promise.resolve();
        closed.push('A');
      },
    });

    const scope = c.createScope();
    scope.resolve(A);
    await scope.dispose();

    expect(closed).toEqual(['A']);
  });

  it('keeps disposing after a disposer throws, and reports it', async () => {
    const onDisposeError = jest.fn();
    const closed: string[] = [];
    const c = createContainer({ name: 'test', onDisposeError })
      .registerScoped(A, makeCounter, { dispose: () => void closed.push('A') })
      .registerScoped(B, makeCounter, {
        dispose: () => {
          throw new Error('boom');
        },
      });

    const scope = c.createScope();
    scope.resolve(A);
    scope.resolve(B);
    await scope.dispose();

    expect(closed).toEqual(['A']);
    expect(onDisposeError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ description: 'B' }));
  });

  it('never disposes values, seeds, or transients', async () => {
    const dispose = jest.fn();
    const value = { id: 1 };
    const c = container()
      .registerValue(A, value)
      // A transient cannot even declare a disposer — the option does not exist
      // on `registerTransient` — so the only way to observe this is that a
      // disposed scope has released nothing it handed out.
      .registerTransient(B, makeCounter)
      .registerSeed(C);

    const scope = c.createScope();
    scope.seed(C, { id: 2 });
    scope.resolve(A);
    scope.resolve(B);
    scope.resolve(C);
    await scope.dispose();
    await c.dispose();

    expect(dispose).not.toHaveBeenCalled();
    expect(value).toEqual({ id: 1 });
  });

  it('leaves singletons alone when a scope is disposed', async () => {
    const dispose = jest.fn();
    const c = container().registerSingleton(A, makeCounter, { dispose });

    const scope = c.createScope();
    const instance = scope.resolve(A);
    await scope.dispose();

    expect(dispose).not.toHaveBeenCalled();
    expect(c.resolve(A)).toBe(instance);
  });

  it('disposes singletons when the container is disposed', async () => {
    const dispose = jest.fn();
    const c = container().registerSingleton(A, makeCounter, { dispose });
    c.resolve(A);

    await c.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(c.disposed).toBe(true);
  });

  it('never disposes a singleton that was never resolved', async () => {
    const dispose = jest.fn();
    const c = container().registerSingleton(A, makeCounter, { dispose });

    await c.dispose();

    expect(dispose).not.toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const dispose = jest.fn();
    const c = container().registerScoped(A, makeCounter, { dispose });
    const scope = c.createScope();
    scope.resolve(A);

    await Promise.all([scope.dispose(), scope.dispose()]);
    await scope.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('refuses to resolve or seed from a disposed scope', async () => {
    const c = container().registerScoped(A, makeCounter).registerSeed(B);
    const scope = c.createScope();
    await scope.dispose();

    expect(scope.disposed).toBe(true);
    expect(() => scope.resolve(A)).toThrow(DisposedError);
    expect(() => scope.seed(B, { id: 1 })).toThrow(DisposedError);
  });

  it('refuses to resolve, register, or open a scope on a disposed container', async () => {
    const c = container().registerSingleton(A, makeCounter);
    await c.dispose();

    expect(() => c.resolve(A)).toThrow(DisposedError);
    expect(() => c.registerSingleton(B, makeCounter)).toThrow(DisposedError);
    expect(() => c.createScope()).toThrow(DisposedError);
  });
});
