import { z } from 'zod';
import { passwordCredentialsSchema } from '@/auth/strategies/password.strategy';
import { magicLinkRequestSchema } from '@/auth/strategies/magic-link.strategy';

/**
 * The dedicated `POST /v1/auth/login` route validates the same credentials the
 * password strategy does, so it reuses that schema rather than restating it —
 * two copies would be free to drift, and the route would start accepting bodies
 * the strategy then rejects with a second 422 from a different layer.
 */
export const loginBodySchema = passwordCredentialsSchema;

export const magicLinkRequestBodySchema = magicLinkRequestSchema;

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutBodySchema = refreshBodySchema;

export type LoginBody = z.infer<typeof loginBodySchema>;
export type MagicLinkRequestBody = z.infer<typeof magicLinkRequestBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
export type LogoutBody = z.infer<typeof logoutBodySchema>;
