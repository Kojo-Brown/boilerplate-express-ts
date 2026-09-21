import { randomUUID } from 'crypto';
import { createTokenPair, refreshTokenExpiresAt, verifyRefreshToken } from '@/lib/jwt';
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

    // A login starts a new family. Every rotation from here carries the same
    // id, which is what makes the chain revocable as a unit later.
    await tokens.issue({
      token: pair.refreshToken,
      userId: principal.id,
      familyId: randomUUID(),
      expiresAt: refreshTokenExpiresAt(pair.refreshToken),
    });

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
     * Rotation itself publishes nothing. A refresh happens every few minutes
     * per active session, so an event on the success path would be the
     * highest-volume thing on the bus while carrying the least: it says a
     * session that already announced itself is still going.
     *
     * The signal worth having from this path is a token presented *after* it
     * was rotated away, and that is what `auth.refresh.reused` reports. Such a
     * token was valid once, so the server is holding two mutually exclusive
     * facts — this chain was superseded, and someone still has the superseded
     * link — and it has no way to tell whether the presenter is the client
     * replaying a spent token or somebody who copied it. Trusting either
     * reading is a guess, and one of the two guesses hands out a live session
     * to a thief. So the whole family goes, both parties are logged out, and
     * the user reauthenticates: the only outcome that is safe under both
     * readings.
     *
     * Note what is *not* here: no grace window in which the immediate
     * successor is handed back for a second presentation of the same token.
     * It is a real and common suggestion, because a client that retries a
     * refresh across a dropped connection trips this legitimately. But the
     * window is equally open to whoever else holds the token, so it converts
     * the one signal that a credential has been copied into a configurable
     * amount of time in which copying it is free — and the same retry is
     * already survivable, because the client still holds credentials to log in
     * with. `docs/refresh-token-reuse.md` carries the argument in full.
     */
    async refresh(refreshToken: string): Promise<RefreshResponse> {
      const payload = verifyRefreshToken(refreshToken);

      if (payload.type !== 'refresh') {
        throw new AppError(401, 'Token type mismatch', 'TOKEN_TYPE_MISMATCH');
      }

      // One call, not a check followed by a retire: see `RefreshTokenStore`
      // for why the join is what keeps two concurrent refreshes from both
      // winning — and therefore from being a way around the detection.
      const consumption = await tokens.consume(refreshToken);

      if (consumption.outcome === 'reuse') {
        const revokedCount = await tokens.revokeFamily(consumption.familyId);

        // Published after the revocation, so no subscriber can observe the
        // alarm for a family that is still usable.
        await events.publish('auth.refresh.reused', {
          userId: consumption.userId,
          familyId: consumption.familyId,
          revokedCount,
        });

        // The same 401 an ordinary revoked token gets. A distinct code here
        // would tell whoever is holding the token that the server noticed,
        // which is worth nothing to a legitimate client — it must log in again
        // either way — and tells an attacker precisely when to stop and which
        // token they hold is the one being watched.
        throw new AppError(401, 'Refresh token revoked', 'TOKEN_REVOKED');
      }

      if (consumption.outcome !== 'rotated') {
        throw new AppError(401, 'Refresh token revoked', 'TOKEN_REVOKED');
      }

      const pair = createTokenPair(payload.userId, payload.roles);
      await tokens.issue({
        token: pair.refreshToken,
        userId: payload.userId,
        // The successor stays in the family it descends from. This is the line
        // that makes the chain a chain: a fresh id here would leave every
        // rotation its own family of one, and revoking one of those on reuse
        // would kill the stolen token while leaving every other token the
        // session had minted alive.
        familyId: consumption.familyId,
        expiresAt: refreshTokenExpiresAt(pair.refreshToken),
      });

      return pair;
    },

    async logout(refreshToken: string): Promise<void> {
      // Best-effort: ignore errors so callers always get 204.
      try {
        const payload = verifyRefreshToken(refreshToken);
        if (payload.type === 'refresh') {
          await tokens.revoke(refreshToken);
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
      await tokens.revokeAllForUser(userId);
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
