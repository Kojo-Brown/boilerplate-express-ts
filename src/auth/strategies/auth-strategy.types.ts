import type { ZodType } from 'zod';
import { ValidationError } from '@/lib/errors';

/**
 * The single source of truth for which authentication strategies exist.
 *
 * The provider registry is keyed by this list, so adding a name here is a
 * compile error until a strategy is registered for it. Values double as the
 * `:strategy` URL segment, which is why they are kebab-case rather than
 * camelCase.
 */
export const AUTH_STRATEGIES = ['password', 'magic-link', 'api-key'] as const;

export type AuthStrategyName = (typeof AUTH_STRATEGIES)[number];

/**
 * Who the caller turned out to be. This is the *only* thing a strategy
 * produces — no tokens, no session, no cookies.
 *
 * Minting the token pair is the auth service's job, and keeping it there is
 * what makes the strategies swappable: every one of them ends at the same
 * place, so the code after authentication never branches on how the caller
 * proved who they were.
 */
export interface AuthenticatedPrincipal {
  id: string;
  email: string;
  roles: string[];
}

/**
 * A strategy as the registry and the auth service see it, with its credential
 * type erased.
 *
 * The erasure is deliberate, not laziness. Which strategy runs is chosen at
 * runtime — by a URL segment — so at the call site the credential type is not
 * knowable, and a heterogeneous registry of `AuthStrategy<TCredentials>` would
 * collapse to a union whose `authenticate` takes the *intersection* of three
 * unrelated credential shapes, which is uncallable. Erasing at the boundary and
 * re-establishing the type inside each strategy (see `defineAuthStrategy`) puts
 * the `unknown` in exactly one place instead of spreading `as` casts around.
 */
export interface AuthStrategy {
  readonly name: AuthStrategyName;

  /**
   * Validates the raw credentials and resolves the principal they identify.
   *
   * Throws `ValidationError` (422) when the credentials are the wrong *shape*
   * and `AppError` (401) when they are well-formed but wrong. The distinction
   * matters: a client sending `{ token }` to the password strategy has a bug,
   * while one sending the wrong password does not.
   */
  authenticate(rawCredentials: unknown): Promise<AuthenticatedPrincipal>;
}

/**
 * What an individual strategy actually writes: a name, the schema its
 * credentials must satisfy, and an `authenticate` that receives them already
 * parsed and typed.
 */
export interface AuthStrategyDefinition<TCredentials> {
  readonly name: AuthStrategyName;

  /**
   * Parses the request body into this strategy's credentials.
   *
   * Each strategy owning its own schema is why `/login/:strategy` carries no
   * `validate()` middleware — the router cannot know which schema applies until
   * the strategy has been resolved, and a union schema at the edge would accept
   * an API key posted to the password strategy.
   */
  readonly credentials: ZodType<TCredentials>;

  authenticate(credentials: TCredentials): Promise<AuthenticatedPrincipal>;
}

/**
 * Turns a typed definition into the erased `AuthStrategy` the registry stores.
 *
 * `TCredentials` is inferred from `credentials` and checked against
 * `authenticate`'s parameter, so a schema and a handler that disagree fail to
 * compile at the definition site.
 */
export function defineAuthStrategy<TCredentials>(
  definition: AuthStrategyDefinition<TCredentials>,
): AuthStrategy {
  return {
    name: definition.name,

    async authenticate(rawCredentials: unknown): Promise<AuthenticatedPrincipal> {
      const parsed = definition.credentials.safeParse(rawCredentials);

      if (!parsed.success) {
        // The same `ValidationError` `validate.middleware` raises, so a
        // malformed body gets the identical 422 envelope — issues included —
        // whether it was rejected at the router or inside a strategy.
        throw new ValidationError(parsed.error.issues);
      }

      return definition.authenticate(parsed.data);
    },
  };
}
