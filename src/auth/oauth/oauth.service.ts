import crypto from 'crypto';
import { createTokenPair, refreshTokenExpiresAt } from '@/lib/jwt';
import { tokenStore } from '@/auth/token-store';
import type { GoogleUpsertInput, OAuthUser } from '@/auth/oauth/oauth.types';
import type { TokenPair } from '@/auth/auth.types';

const googleUsers = new Map<string, OAuthUser>();

export const oauthService = {
  async upsertGoogleUser(input: GoogleUpsertInput): Promise<OAuthUser> {
    const existing = googleUsers.get(input.id);
    if (existing) return existing;

    const user: OAuthUser = {
      id: crypto.randomUUID(),
      email: input.email ?? `${input.id}@google.oauth`,
      name: input.displayName,
      picture: input.picture ?? null,
      provider: 'google',
      providerId: input.id,
      roles: ['user'],
    };
    googleUsers.set(input.id, user);
    return user;
  },

  async issueTokens(user: OAuthUser): Promise<TokenPair> {
    const tokens = createTokenPair(user.id, user.roles);
    // A provider login starts its own rotation family, exactly as a password
    // login does: the chain has to exist from the first token or the rotations
    // built on it have nothing to belong to.
    await tokenStore.issue({
      token: tokens.refreshToken,
      userId: user.id,
      familyId: crypto.randomUUID(),
      expiresAt: refreshTokenExpiresAt(tokens.refreshToken),
    });
    return tokens;
  },
};
