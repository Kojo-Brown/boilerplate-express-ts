import type { Request } from 'express';
import { correlationIdOf } from '@/middleware/logger.middleware';

/**
 * The per-request facts everything downstream keeps re-deriving: who the caller
 * is, and which log line this work belongs to.
 *
 * One object per request rather than four `req.` lookups scattered through the
 * controllers — and the thing that made `scoped` worth having as a lifetime,
 * since it is meaningless as a singleton and wasteful as a transient.
 */
export interface RequestContext {
  /**
   * `undefined` when `correlationIdMiddleware` did not run, matching
   * `correlationIdOf`. Minting one here would produce an id that appears in an
   * audit line and in no access log.
   */
  readonly correlationId: string | undefined;
  /** The authenticated principal, or `null` on an anonymous route. */
  readonly actorId: string | null;
  readonly roles: readonly string[];
}

/**
 * Wraps the request in accessors rather than snapshotting it.
 *
 * A scoped instance is created at the *first resolve*, which is not the moment
 * the request arrived — `requireAuth` may not have run yet. Reading `req.auth`
 * eagerly here would freeze `actorId: null` for any request that resolved the
 * context before authenticating, and the resulting audit lines would be
 * anonymous for reasons no one could reconstruct. The getters make creation
 * time irrelevant.
 */
export function createRequestContext(req: Request): RequestContext {
  return {
    get correlationId(): string | undefined {
      return correlationIdOf(req);
    },
    get actorId(): string | null {
      return req.auth?.userId ?? null;
    },
    get roles(): readonly string[] {
      return req.auth?.roles ?? [];
    },
  };
}
