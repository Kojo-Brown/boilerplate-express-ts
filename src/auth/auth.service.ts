import { AppError } from '@/lib/errors';
import { createTokenPair, verifyRefreshToken } from '@/lib/jwt';
import { verifyPassword } from '@/lib/password';
import { tokenStore } from '@/auth/token-store';
import type { LoginRequest, LoginResponse, RefreshResponse } from '@/auth/auth.types';

interface MockUser {
  id: string;
  email: string;
  passwordHash: string;
  roles: string[];
}

// Stub user store — replaced with DB queries in Phase 3.
// Hashes are argon2id of 'password' (regenerate via hashPassword() when seeding real DB).
const MOCK_USERS: MockUser[] = [
  {
    id: '1',
    email: 'admin@example.com',
    passwordHash:
      '$argon2id$v=19$m=65536,t=3,p=4$stub-seed-admin$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    roles: ['admin', 'user'],
  },
  {
    id: '2',
    email: 'user@example.com',
    passwordHash:
      '$argon2id$v=19$m=65536,t=3,p=4$stub-seed-user$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    roles: ['user'],
  },
];

function findUserByEmail(email: string): MockUser | undefined {
  return MOCK_USERS.find((u) => u.email === email);
}

export const authService = {
  async login(req: LoginRequest): Promise<LoginResponse> {
    const user = findUserByEmail(req.email);
    if (!user || !(await verifyPassword(req.password, user.passwordHash))) {
      throw new AppError(401, 'Invalid email or password', 'AUTH_INVALID_CREDENTIALS');
    }

    const tokens = createTokenPair(user.id, user.roles);
    tokenStore.add(tokens.refreshToken, user.id);

    return {
      user: { id: user.id, email: user.email, roles: [...user.roles] },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  },

  async refresh(refreshToken: string): Promise<RefreshResponse> {
    const payload = verifyRefreshToken(refreshToken);

    if (payload.type !== 'refresh') {
      throw new AppError(401, 'Token type mismatch', 'TOKEN_TYPE_MISMATCH');
    }

    if (!tokenStore.has(refreshToken)) {
      throw new AppError(401, 'Refresh token revoked', 'TOKEN_REVOKED');
    }

    // Rotate: revoke old, issue fresh pair.
    tokenStore.remove(refreshToken);
    const tokens = createTokenPair(payload.userId, payload.roles);
    tokenStore.add(tokens.refreshToken, payload.userId);

    return tokens;
  },

  async logout(refreshToken: string): Promise<void> {
    // Best-effort: ignore errors so callers always get 204.
    try {
      const payload = verifyRefreshToken(refreshToken);
      if (payload.type === 'refresh') {
        tokenStore.remove(refreshToken);
      }
    } catch {
      // no-op
    }
  },

  async logoutAll(userId: string): Promise<void> {
    tokenStore.removeAllForUser(userId);
  },
};
