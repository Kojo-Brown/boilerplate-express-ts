import type { AnyInjectionToken, InjectionToken } from '@/lib/container/token';
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

/** What a factory is handed so it can ask for its own dependencies. */
export interface Resolver {
  resolve<T>(token: InjectionToken<T>): T;
}

/**
 * Builds one instance.
 *
 * Synchronous, and that is a decision rather than an omission. An async factory
 * makes `resolve` return a promise, which means every consumer awaits its
 * collaborators — and two concurrent resolutions of the same singleton can both
 * enter the factory before either stores a result, so "singleton" quietly
 * becomes "usually one". Anything that needs I/O to construct is registered
 * already-built with `registerValue`, or exposes an `init()` the composition
 * root awaits once at boot.
 */
export type Factory<T> = (resolve: Resolver) => T;

/** Releases whatever the instance holds open. Awaited during disposal. */
export type Disposer<T> = (instance: T) => void | Promise<void>;

export interface RegistrationOptions<T> {
  /**
   * Called when the owning container or scope is disposed. Only instances the
   * container *created* are disposed — see `registerValue`.
   */
  dispose?: Disposer<T>;
}

/**
 * Reports a disposer that threw.
 *
 * Disposal continues past a failure: a scope that stops halfway leaks
 * everything it had not reached yet, which is strictly worse than the single
 * failure it stopped for.
 */
export type DisposeErrorReporter = (error: unknown, token: AnyInjectionToken) => void;

export interface ContainerOptions {
  /** Used in error messages and as the prefix for scope names. */
  name?: string;
  onDisposeError?: DisposeErrorReporter;
}

type Lifetime = 'singleton' | 'scoped' | 'transient';

interface Registration {
  readonly lifetime: Lifetime;
  /** `null` marks a seeded token: the value arrives through `Scope.seed`. */
  readonly factory: Factory<unknown> | null;
  readonly dispose: Disposer<unknown> | undefined;
}

/** An instance the container created, and is therefore responsible for closing. */
interface Owned {
  readonly token: AnyInjectionToken;
  readonly instance: unknown;
  readonly dispose: Disposer<unknown>;
}

interface ScopeState {
  readonly instances: Map<AnyInjectionToken, unknown>;
  readonly owned: Owned[];
}

/**
 * A resolution context — one per request, in this service.
 *
 * A scope memoises `scoped` registrations, holds seeded values, and disposes
 * everything it created. Singletons are not stored here: they live on the root
 * container and are shared by every scope.
 */
export interface Scope extends Resolver {
  readonly name: string;
  readonly disposed: boolean;

  /**
   * Supplies the value for a token registered with `registerSeed`.
   *
   * This is how per-scope input that no factory could construct — the HTTP
   * request, a job message — enters the graph. A token may be seeded once, and
   * only before anything has resolved it.
   */
  seed<T>(token: InjectionToken<T>, value: T): void;

  /**
   * Disposes the instances this scope created, most recent first, and marks it
   * unusable. Idempotent: later calls return the first call's promise.
   */
  dispose(): Promise<void>;
}

export interface Container extends Resolver {
  readonly name: string;
  readonly disposed: boolean;

  /**
   * One instance for the process. Its dependencies resolve against the root, so
   * a singleton may depend on other singletons and on nothing narrower — see
   * `CaptiveDependencyError`.
   */
  registerSingleton<T>(
    token: InjectionToken<T>,
    factory: Factory<T>,
    options?: RegistrationOptions<T>,
  ): Container;

  /** One instance per scope. Resolving it off the root is an error, not a fallback. */
  registerScoped<T>(
    token: InjectionToken<T>,
    factory: Factory<T>,
    options?: RegistrationOptions<T>,
  ): Container;

  /**
   * A fresh instance on every resolve.
   *
   * No `dispose` option, deliberately. The container hands a transient over and
   * immediately forgets it; holding a reference so it could close it later
   * would make every resolve a leak for as long as the owner lives. If a
   * transient owns a resource, the caller that asked for it owns closing it —
   * and the missing option is what says so at the registration site.
   */
  registerTransient<T>(token: InjectionToken<T>, factory: Factory<T>): Container;

  /**
   * Registers an already-built instance, shared like a singleton.
   *
   * Never disposed: the container did not create it, so it does not get to
   * decide when it closes. Use it for module-level objects, and for
   * substituting fakes in tests.
   */
  registerValue<T>(token: InjectionToken<T>, value: T): Container;

  /**
   * Declares a token whose value is supplied per scope by `Scope.seed`.
   *
   * Scoped for lifetime purposes: a singleton that reaches for one is a captive
   * dependency for exactly the same reason.
   */
  registerSeed<T>(token: InjectionToken<T>): Container;

  has(token: AnyInjectionToken): boolean;

  createScope(name?: string): Scope;

  /**
   * Disposes the singletons this container created, most recent first.
   *
   * Live scopes are not tracked and so are not disposed here — a container
   * holding every scope it ever handed out would be a per-request leak. Scopes
   * are disposed by whoever created them.
   */
  dispose(): Promise<void>;
}

function defaultDisposeErrorReporter(error: unknown, token: AnyInjectionToken): void {
  console.error(`[container] Disposer for "${token.description}" failed:`, error);
}

/**
 * Disposes owned instances in reverse creation order.
 *
 * Reverse, because creation order is dependency order: B was built after A
 * because B needed A, so B has to let go first.
 */
async function disposeAll(owned: Owned[], report: DisposeErrorReporter): Promise<void> {
  for (let i = owned.length - 1; i >= 0; i -= 1) {
    // Bounded by the loop condition; `noUncheckedIndexedAccess` cannot see that.
    const entry = owned[i];
    if (!entry) continue;
    try {
      await entry.dispose(entry.instance);
    } catch (error) {
      report(error, entry.token);
    }
  }
  owned.length = 0;
}

/**
 * A hand-rolled container with three lifetimes, no decorators, no reflection
 * metadata, and no ambient registry.
 *
 * Wiring is written out in a composition root rather than inferred from
 * constructor parameter types. That costs a line per registration and buys what
 * `reflect-metadata` cannot: the graph is ordinary code, so it typechecks, it
 * is greppable, and a new dependency shows up as a diff in one reviewable file
 * instead of as a decorator on a constructor nobody re-reads.
 */
export function createContainer(options: ContainerOptions = {}): Container {
  const name = options.name ?? 'container';
  const report = options.onDisposeError ?? defaultDisposeErrorReporter;

  const registrations = new Map<AnyInjectionToken, Registration>();
  const singletons = new Map<AnyInjectionToken, unknown>();
  const ownedSingletons: Owned[] = [];

  let disposed = false;
  let disposal: Promise<void> | null = null;

  function assertLive(): void {
    if (disposed) throw new DisposedError(`Container "${name}"`);
  }

  function register(token: AnyInjectionToken, registration: Registration): void {
    assertLive();
    if (registrations.has(token)) throw new DuplicateRegistrationError(token);
    registrations.set(token, registration);
  }

  /**
   * The whole resolution algorithm, in one place.
   *
   * `scope` is `null` when resolving at the root — either because the caller
   * asked the container directly, or because we are inside a singleton's
   * factory, which amounts to the same thing: a singleton is built once, for
   * everyone, so it cannot be built against any one scope.
   *
   * `path` is the chain of tokens currently under construction. It drives both
   * the cycle check and the error messages, and it is threaded through as an
   * argument rather than kept in a module-level stack because a module-level
   * stack would be shared by concurrent requests.
   *
   * Values come out of the instance maps as `unknown`; the casts back to `T`
   * are sound because both maps are only ever written under the token whose
   * registration produced the value, and the public signatures are what pair a
   * token's `T` with its factory.
   */
  function resolveInternal<T>(
    token: InjectionToken<T>,
    scope: ScopeState | null,
    path: readonly AnyInjectionToken[],
  ): T {
    const registration = registrations.get(token);
    if (!registration) throw new UnregisteredTokenError(token, path);

    switch (registration.lifetime) {
      case 'singleton': {
        if (singletons.has(token)) return singletons.get(token) as T;

        const instance = construct(token, registration, null, path);
        singletons.set(token, instance);
        if (registration.dispose) {
          ownedSingletons.push({ token, instance, dispose: registration.dispose });
        }
        return instance as T;
      }

      case 'scoped': {
        if (!scope) {
          // A non-empty path means we are inside a factory, and the only
          // factories that resolve with no scope are singletons' — so this is
          // the captive-dependency bug rather than a misuse of the root API.
          throw path.length > 0
            ? new CaptiveDependencyError(token, path)
            : new ScopeRequiredError(token);
        }
        if (scope.instances.has(token)) return scope.instances.get(token) as T;
        if (registration.factory === null) throw new MissingSeedError(token);

        const instance = construct(token, registration, scope, path);
        scope.instances.set(token, instance);
        if (registration.dispose) {
          scope.owned.push({ token, instance, dispose: registration.dispose });
        }
        return instance as T;
      }

      case 'transient':
        return construct(token, registration, scope, path) as T;
    }
  }

  function construct(
    token: AnyInjectionToken,
    registration: Registration,
    scope: ScopeState | null,
    path: readonly AnyInjectionToken[],
  ): unknown {
    if (path.includes(token)) throw new CircularDependencyError(token, path);
    if (registration.factory === null) throw new MissingSeedError(token);

    const nextPath = [...path, token];
    // A singleton's dependencies resolve at the root even when the resolution
    // that reached it started in a scope. This one line is what makes captive
    // dependencies impossible rather than merely discouraged.
    const dependencyScope = registration.lifetime === 'singleton' ? null : scope;

    return registration.factory({
      resolve: <U>(dependency: InjectionToken<U>): U =>
        resolveInternal(dependency, dependencyScope, nextPath),
    });
  }

  function createScope(scopeName?: string): Scope {
    assertLive();

    const state: ScopeState = { instances: new Map(), owned: [] };
    const label = scopeName ?? `${name}:scope`;
    let scopeDisposed = false;
    let scopeDisposal: Promise<void> | null = null;

    return {
      name: label,

      get disposed(): boolean {
        return scopeDisposed;
      },

      resolve<T>(token: InjectionToken<T>): T {
        if (scopeDisposed) throw new DisposedError(`Scope "${label}"`);
        assertLive();
        return resolveInternal(token, state, []);
      },

      seed<T>(token: InjectionToken<T>, value: T): void {
        if (scopeDisposed) throw new DisposedError(`Scope "${label}"`);
        const registration = registrations.get(token);
        if (!registration) throw new UnregisteredTokenError(token, []);
        if (registration.lifetime !== 'scoped' || registration.factory !== null) {
          throw new SeedConflictError(token, 'not-a-seed');
        }
        if (state.instances.has(token)) throw new SeedConflictError(token, 'already-seeded');

        // Seeded values are never pushed onto `owned`: the scope did not create
        // them, so it does not close them. The request object outliving the
        // scope is the entire point.
        state.instances.set(token, value);
      },

      dispose(): Promise<void> {
        if (scopeDisposal) return scopeDisposal;
        scopeDisposed = true;
        scopeDisposal = disposeAll(state.owned, report).then(() => {
          state.instances.clear();
        });
        return scopeDisposal;
      },
    };
  }

  const container: Container = {
    name,

    get disposed(): boolean {
      return disposed;
    },

    registerSingleton<T>(
      token: InjectionToken<T>,
      factory: Factory<T>,
      registrationOptions?: RegistrationOptions<T>,
    ): Container {
      register(token, {
        lifetime: 'singleton',
        factory,
        // `Disposer<T>` is contravariant in `T`, so it cannot widen to
        // `Disposer<unknown>` on its own. The cast is safe because the disposer
        // is only ever invoked with the instance stored under this same token.
        dispose: registrationOptions?.dispose as Disposer<unknown> | undefined,
      });
      return container;
    },

    registerScoped<T>(
      token: InjectionToken<T>,
      factory: Factory<T>,
      registrationOptions?: RegistrationOptions<T>,
    ): Container {
      register(token, {
        lifetime: 'scoped',
        factory,
        dispose: registrationOptions?.dispose as Disposer<unknown> | undefined,
      });
      return container;
    },

    registerTransient<T>(token: InjectionToken<T>, factory: Factory<T>): Container {
      register(token, { lifetime: 'transient', factory, dispose: undefined });
      return container;
    },

    registerValue<T>(token: InjectionToken<T>, value: T): Container {
      register(token, { lifetime: 'singleton', factory: () => value, dispose: undefined });
      return container;
    },

    registerSeed<T>(token: InjectionToken<T>): Container {
      register(token, { lifetime: 'scoped', factory: null, dispose: undefined });
      return container;
    },

    has(token: AnyInjectionToken): boolean {
      return registrations.has(token);
    },

    resolve<T>(token: InjectionToken<T>): T {
      assertLive();
      return resolveInternal(token, null, []);
    },

    createScope,

    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      disposal = disposeAll(ownedSingletons, report).then(() => {
        singletons.clear();
      });
      return disposal;
    },
  };

  return container;
}
