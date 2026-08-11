import { AppError } from '@/lib/errors';
import type { AnyInjectionToken } from '@/lib/container/token';
import { formatPath } from '@/lib/container/token';

/**
 * Base for every container failure.
 *
 * Extends `AppError` with a 500 for the same reason `UnknownProviderError`
 * does: resolution happens inside a request, so the failure has to travel the
 * existing translator chain rather than reach the error middleware as an
 * anonymous throw. 5xx rather than 4xx because none of these are caused by the
 * caller — every one is a wiring mistake in this deployment.
 *
 * Registration-time failures reuse the same base even though they fire at boot
 * and can never reach a response, so that `instanceof ContainerError` catches
 * the whole category.
 */
export class ContainerError extends AppError {
  constructor(message: string, code: string) {
    super(500, message, code);
    this.name = 'ContainerError';
  }
}

/** A token was resolved that nothing ever registered. */
export class UnregisteredTokenError extends ContainerError {
  constructor(
    public readonly token: AnyInjectionToken,
    public readonly path: readonly AnyInjectionToken[],
  ) {
    super(
      path.length > 0
        ? `No registration for "${token.description}" (resolving ${formatPath([...path, token])})`
        : `No registration for "${token.description}"`,
      'CONTAINER_UNREGISTERED_TOKEN',
    );
    this.name = 'UnregisteredTokenError';
  }
}

/**
 * The same token was registered twice.
 *
 * Thrown rather than overwritten. Last-write-wins is how a test harness's stub
 * ends up serving production traffic, and how two modules that both believe
 * they own a token stay wrong until one of them is deleted.
 */
export class DuplicateRegistrationError extends ContainerError {
  constructor(public readonly token: AnyInjectionToken) {
    super(`"${token.description}" is already registered`, 'CONTAINER_DUPLICATE_REGISTRATION');
    this.name = 'DuplicateRegistrationError';
  }
}

/**
 * A scoped token was resolved straight off the root container.
 *
 * There is no instance to hand back and no correct one to invent: a scoped
 * registration means "one per scope", and the root is not a scope.
 */
export class ScopeRequiredError extends ContainerError {
  constructor(public readonly token: AnyInjectionToken) {
    super(
      `"${token.description}" is registered as scoped and cannot be resolved from the root container — resolve it from a scope`,
      'CONTAINER_SCOPE_REQUIRED',
    );
    this.name = 'ScopeRequiredError';
  }
}

/**
 * The captive dependency: a singleton reached for something scoped.
 *
 * This is the bug the three lifetimes exist to make impossible. A singleton
 * that captures a per-request object keeps the *first* request's copy for the
 * life of the process — so the tenth caller reads the first caller's principal,
 * and nothing about it is visible under a single-request test. Singleton
 * factories therefore resolve against the root, where scoped tokens do not
 * exist, and asking for one fails at the first resolution instead of leaking
 * quietly for months.
 *
 * The fix is never to widen the scoped registration. It is to make the consumer
 * scoped too, or to pass the per-request value as an argument to the method
 * that needs it.
 */
export class CaptiveDependencyError extends ContainerError {
  constructor(
    public readonly token: AnyInjectionToken,
    public readonly path: readonly AnyInjectionToken[],
  ) {
    super(
      `"${path[0]?.description ?? 'A singleton'}" cannot depend on scoped "${token.description}" — a singleton would capture one scope's instance for the process lifetime (resolving ${formatPath([...path, token])})`,
      'CONTAINER_CAPTIVE_DEPENDENCY',
    );
    this.name = 'CaptiveDependencyError';
  }
}

/** A resolution path came back to a token already under construction. */
export class CircularDependencyError extends ContainerError {
  constructor(
    public readonly token: AnyInjectionToken,
    public readonly path: readonly AnyInjectionToken[],
  ) {
    super(`Circular dependency: ${formatPath([...path, token])}`, 'CONTAINER_CIRCULAR_DEPENDENCY');
    this.name = 'CircularDependencyError';
  }
}

/**
 * A seeded token was resolved in a scope that never received a value.
 *
 * Distinct from `UnregisteredTokenError` on purpose: the wiring is right and
 * the *scope* is wrong, which points at the middleware that should have seeded
 * it rather than at the composition root.
 */
export class MissingSeedError extends ContainerError {
  constructor(public readonly token: AnyInjectionToken) {
    super(
      `"${token.description}" is seeded per scope and was never provided to this scope`,
      'CONTAINER_MISSING_SEED',
    );
    this.name = 'MissingSeedError';
  }
}

/** A seed was provided twice, or for a token that is not seeded at all. */
export class SeedConflictError extends ContainerError {
  constructor(
    public readonly token: AnyInjectionToken,
    public readonly reason: 'already-seeded' | 'not-a-seed',
  ) {
    super(
      reason === 'already-seeded'
        ? `"${token.description}" has already been seeded in this scope`
        : `"${token.description}" is not registered as a seeded token`,
      'CONTAINER_SEED_CONFLICT',
    );
    this.name = 'SeedConflictError';
  }
}

/** Something used a container or scope after it was disposed. */
export class DisposedError extends ContainerError {
  constructor(public readonly subject: string) {
    super(`${subject} has been disposed`, 'CONTAINER_DISPOSED');
    this.name = 'DisposedError';
  }
}
