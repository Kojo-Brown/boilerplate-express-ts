import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { defineAuthStrategy } from '@/auth/strategies/auth-strategy.types';
import type { AuthStrategy } from '@/auth/strategies/auth-strategy.types';
import { hashSecret } from '@/auth/strategies/secret-hash';
import type { ApiKeyDirectory } from '@/auth/strategies/api-key.directory';

export const apiKeyCredentialsSchema = z.object({
  apiKey: z.string().min(1),
});

export type ApiKeyCredentials = z.infer<typeof apiKeyCredentialsSchema>;

export interface ApiKeyStrategyDeps {
  keys: ApiKeyDirectory;
}

/**
 * A long-lived shared secret belonging to a machine client.
 *
 * The key is exchanged for the same short-lived token pair every other strategy
 * produces, rather than being accepted on each request. That is the deliberate
 * choice: it keeps the key off every subsequent request (so it is not in
 * proxy logs, browser history, or a replayed capture of a hot endpoint), gives
 * revocation a bounded blast radius of one access-token lifetime, and means
 * `requireAuth` and `requireRole` keep validating exactly one credential type.
 *
 * The cost is that revoking a key does not invalidate tokens already issued
 * from it; `authService.logoutAll(userId)` is what closes that window.
 */
export function createApiKeyStrategy({ keys }: ApiKeyStrategyDeps): AuthStrategy {
  return defineAuthStrategy({
    name: 'api-key',
    credentials: apiKeyCredentialsSchema,

    async authenticate({ apiKey }: ApiKeyCredentials) {
      const record = await keys.findByHash(hashSecret(apiKey));

      if (!record) {
        throw new AppError(401, 'Invalid API key', 'AUTH_INVALID_API_KEY');
      }

      return { id: record.userId, email: record.email, roles: [...record.roles] };
    },
  });
}
