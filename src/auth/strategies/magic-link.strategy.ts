import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { defineAuthStrategy } from '@/auth/strategies/auth-strategy.types';
import type { AuthStrategy } from '@/auth/strategies/auth-strategy.types';
import { generateSecret, hashSecret } from '@/auth/strategies/secret-hash';
import type { MagicLinkDelivery } from '@/auth/strategies/magic-link.delivery';
import type { MagicLinkStore } from '@/auth/strategies/magic-link.store';
import type { UserDirectory } from '@/auth/auth.types';

export const magicLinkCredentialsSchema = z.object({
  token: z.string().min(1),
});

export type MagicLinkCredentials = z.infer<typeof magicLinkCredentialsSchema>;

export const magicLinkRequestSchema = z.object({
  email: z.string().email(),
});

export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

export interface MagicLinkStrategyDeps {
  users: UserDirectory;
  links: MagicLinkStore;
}

export interface MagicLinkIssuerDeps extends MagicLinkStrategyDeps {
  delivery: MagicLinkDelivery;
  /** Lifetime of an issued link, in seconds. Must match the store's TTL. */
  ttlSeconds: number;
  /** Overridable so tests can assert on a known token instead of a random one. */
  generateToken?: () => string;
  now?: () => number;
}

export interface MagicLinkIssuer {
  /**
   * Mints a link for `email` and hands it to the delivery.
   *
   * Resolves the same way whether or not the address belongs to a user: the
   * request endpoint is unauthenticated, so a caller who could tell "we sent
   * one" from "no such user" would have a free account-enumeration oracle
   * against the whole directory.
   */
  request(email: string): Promise<void>;
}

export function createMagicLinkIssuer({
  users,
  links,
  delivery,
  ttlSeconds,
  generateToken = generateSecret,
  now = () => Date.now(),
}: MagicLinkIssuerDeps): MagicLinkIssuer {
  return {
    async request(email: string): Promise<void> {
      const user = await users.findByEmail(email);
      if (!user) return;

      const token = generateToken();

      // Hash first, store second, deliver last. If delivery throws, the link is
      // already outstanding and simply goes unredeemed until it expires — the
      // opposite order would send a user a link the store never accepted.
      await links.issue(hashSecret(token), user.email);
      await delivery.send({ email: user.email, token, expiresAt: now() + ttlSeconds * 1000 });
    },
  };
}

/**
 * A single-use token that was mailed to an address the directory knows.
 *
 * The token proves control of the inbox, so the address it was issued to is
 * the identity — the strategy re-reads the user from the directory rather than
 * trusting anything carried in the token itself, which is what keeps a link
 * issued before a user was deleted or renamed from resurrecting them.
 */
export function createMagicLinkStrategy({ users, links }: MagicLinkStrategyDeps): AuthStrategy {
  return defineAuthStrategy({
    name: 'magic-link',
    credentials: magicLinkCredentialsSchema,

    async authenticate({ token }: MagicLinkCredentials) {
      const email = await links.consume(hashSecret(token));

      if (email === null) {
        throw new AppError(
          401,
          'Magic link is invalid, expired, or already used',
          'AUTH_INVALID_MAGIC_LINK',
        );
      }

      const user = await users.findByEmail(email);

      if (!user) {
        // The link was genuine and has now been spent. Same status and code as
        // a bad token: the holder of a link for a deleted account learns only
        // that it no longer works.
        throw new AppError(
          401,
          'Magic link is invalid, expired, or already used',
          'AUTH_INVALID_MAGIC_LINK',
        );
      }

      return { id: user.id, email: user.email, roles: [...user.roles] };
    },
  });
}
