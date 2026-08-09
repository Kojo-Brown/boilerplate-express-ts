import { createTokenPair, verifyRefreshToken } from '@/lib/jwt';
import { AppError } from '@/lib/errors';
import { tokenStore } from '@/auth/token-store';
import { authStrategyRegistry } from '@/auth/strategies';
import type { AuthStrategyRegistry } from '@/auth/strategies';
import type { AuthStrategyName, AuthenticatedPrincipal } from '@/auth/strategies';
import type { DomainEventBus } from '@/events';
import { domainEventBus } from '@/events';
import type {
  LoginRequest,
  LoginResponse,
  RefreshResponse,
  RefreshTokenStore,
} from '@/auth/auth.types';

export interface AuthServiceDeps {
  strategies: AuthStrategyRegistry;
  tokens: RefreshTokenStore;
  /**
   * Where session facts are announced. Injected rather than imported so a test
   * can assert on what was published without reaching for the process-wide bus.
   */
  events: DomainEventBus;
}

export interface AuthService {
  /**
   * Proves who the caller is with the named strategy, then issues them a
   * session. `credentials` is `unknown` because its shape is the strategy's
   * business — see `AuthStrategy` for why the type is erased here.
   */
  authenticate(strategy: AuthStrategyName, credentials: unknown): Promise<LoginResponse>;
  login(req: LoginRequest): Promise<LoginResponse>;
  refresh(refreshToken: string): Promise<RefreshResponse>;
  logout(refreshToken: string): Promise<void>;
  logoutAll(userId: string): Promise<void>;
}

/**
 * The auth service depends on the `AuthStrategyRegistry` and
 * `RefreshTokenStore` abstractions, never on concrete implementations of
 * either. Swapping a strategy's backing store — or adding a strategy — is a
 * change at the composition root, not here.
 *
 * What the service still owns is everything that happens *after* a principal is
 * established: minting the pair, recording the refresh token, rotation, and
 * revocation. That is the whole reason the strategies are interchangeable —
 * they all converge on `issueSession`, so nothing downstream of login branches
 * on how the caller proved who they were.
 *
 * The JWT helpers stay as module imports on purpose: they are pure functions
 * over their arguments with no lifecycle, connection or substitutable policy,
 * so injecting them would buy indirection and nothing else.
 */
export function createAuthService({ strategies, tokens, events }: AuthServiceDeps): AuthService {
  async function issueSession(
    principal: AuthenticatedPrincipal,
    strategy: AuthStrategyName,
  ): Promise<LoginResponse> {
    const pair = createTokenPair(principal.id, principal.roles);
    await tokens.add(pair.refreshToken, principal.id);

    // After the token is recorded, so a subscriber never observes a login for a
    // session that does not exist yet. The tokens themselves stay out of the
    // payload — subscribers persist what they are given.
    await events.publish('auth.login.succeeded', {
      userId: principal.id,
      strategy,
    });

    return {
      user: { id: principal.id, email: principal.email, roles: [...principal.roles] },
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    };
  }

  async function authenticate(
    strategy: AuthStrategyName,
    credentials: unknown,
  ): Promise<LoginResponse> {
    const principal = await strategies.resolve(strategy).authenticate(credentials);
    return issueSession(principal, strategy);
  }

  return {
    authenticate,

    /**
     * Email-and-password login, kept as a named method because it is the one
     * strategy with a dedicated route (`POST /v1/auth/login`) and a typed
     * request body. It is a thin call into `authenticate` — the credentials
     * still go through the password strategy's own schema, so there is exactly
     * one place that decides what a valid password credential looks like.
     */
    login(req: LoginRequest): Promise<LoginResponse> {
      return authenticate('password', req);
    },

    /**
     * Rotation publishes nothing on purpose. A refresh happens every few
     * minutes per active session, so an event here would be the highest-volume
     * thing on the bus while carrying the least: it says a session that already
     * announced itself is still going. The signal worth having from this path
     * is a *reused* refresh token, and that is the Phase 10 reuse-detection
     * item — a different event with a different meaning.
     */
    async refresh(refreshToken: string): Promise<RefreshResponse> {
      const payload = verifyRefreshToken(refreshToken);

      if (payload.type !== 'refresh') {
        throw new AppError(401, 'Token type mismatch', 'TOKEN_TYPE_MISMATCH');
      }

      if (!(await tokens.has(refreshToken))) {
        throw new AppError(401, 'Refresh token revoked', 'TOKEN_REVOKED');
      }

      // Rotate: revoke old, issue fresh pair.
      await tokens.remove(refreshToken);
      const pair = createTokenPair(payload.userId, payload.roles);
      await tokens.add(pair.refreshToken, payload.userId);

      return pair;
    },

    async logout(refreshToken: string): Promise<void> {
      // Best-effort: ignore errors so callers always get 204.
      try {
        const payload = verifyRefreshToken(refreshToken);
        if (payload.type === 'refresh') {
          await tokens.remove(refreshToken);
          // Inside the `if`, so the event means a session was actually retired
          // rather than that someone posted a string to `/logout`.
          await events.publish('auth.session.revoked', {
            userId: payload.userId,
            scope: 'single',
          });
        }
      } catch {
        // no-op
      }
    },

    async logoutAll(userId: string): Promise<void> {
      await tokens.removeAllForUser(userId);
      await events.publish('auth.session.revoked', { userId, scope: 'all' });
    },
  };
}

/** Composition root for the default wiring used by the HTTP layer. */
export const authService: AuthService = createAuthService({
  strategies: authStrategyRegistry,
  tokens: tokenStore,
  events: domainEventBus,
});
