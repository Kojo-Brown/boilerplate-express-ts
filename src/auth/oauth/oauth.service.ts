import crypto from 'crypto';
import { createTokenPair } from '@/lib/jwt';
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

  issueTokens(user: OAuthUser): TokenPair {
    const tokens = createTokenPair(user.id, user.roles);
    tokenStore.add(tokens.refreshToken, user.id);
    return tokens;
  },
};
