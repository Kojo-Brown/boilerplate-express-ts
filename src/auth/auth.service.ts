import { AppError } from '@/lib/errors';
import { createTokenPair, verifyRefreshToken } from '@/lib/jwt';
import { verifyPassword } from '@/lib/password';
import { tokenStore } from '@/auth/token-store';
import { inMemoryUserDirectory } from '@/auth/in-memory-user-directory';
import type {
  LoginRequest,
  LoginResponse,
  RefreshResponse,
  RefreshTokenStore,
  UserDirectory,
} from '@/auth/auth.types';

export interface AuthServiceDeps {
  users: UserDirectory;
  tokens: RefreshTokenStore;
}

export interface AuthService {
  login(req: LoginRequest): Promise<LoginResponse>;
  refresh(refreshToken: string): Promise<RefreshResponse>;
  logout(refreshToken: string): Promise<void>;
  logoutAll(userId: string): Promise<void>;
}

/**
 * The auth service depends on the `UserDirectory` and `RefreshTokenStore`
 * abstractions, never on the in-memory implementations of them. Swapping either
 * for a DB-backed one is a change at the composition root, not here.
 *
 * `verifyPassword` and the JWT helpers stay as module imports on purpose: they
 * are pure functions over their arguments with no lifecycle, connection or
 * substitutable policy, so injecting them would buy indirection and nothing else.
 */
export function createAuthService({ users, tokens }: AuthServiceDeps): AuthService {
  return {
    async login(req: LoginRequest): Promise<LoginResponse> {
      const user = await users.findByEmail(req.email);
      if (!user || !(await verifyPassword(req.password, user.passwordHash))) {
        throw new AppError(401, 'Invalid email or password', 'AUTH_INVALID_CREDENTIALS');
      }

      const pair = createTokenPair(user.id, user.roles);
      await tokens.add(pair.refreshToken, user.id);

      return {
        user: { id: user.id, email: user.email, roles: [...user.roles] },
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
      };
    },

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
        }
      } catch {
        // no-op
      }
    },

    async logoutAll(userId: string): Promise<void> {
      await tokens.removeAllForUser(userId);
    },
  };
}

/** Composition root for the default wiring used by the HTTP layer. */
export const authService: AuthService = createAuthService({
  users: inMemoryUserDirectory,
  tokens: tokenStore,
});
