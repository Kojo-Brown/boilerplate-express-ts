import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { verifyPassword } from '@/lib/password';
import { defineAuthStrategy } from '@/auth/strategies/auth-strategy.types';
import type { AuthStrategy } from '@/auth/strategies/auth-strategy.types';
import type { UserDirectory } from '@/auth/auth.types';

export const passwordCredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type PasswordCredentials = z.infer<typeof passwordCredentialsSchema>;

export interface PasswordStrategyDeps {
  users: UserDirectory;
}

/**
 * Email plus password, verified against the argon2 digest in the directory.
 *
 * The failure message is identical for an unknown email and a wrong password,
 * and the code is the same `AUTH_INVALID_CREDENTIALS` the login route has
 * always returned: telling a caller which half was wrong turns the login
 * endpoint into an account-enumeration oracle.
 */
export function createPasswordStrategy({ users }: PasswordStrategyDeps): AuthStrategy {
  return defineAuthStrategy({
    name: 'password',
    credentials: passwordCredentialsSchema,

    async authenticate({ email, password }: PasswordCredentials) {
      const user = await users.findByEmail(email);

      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        throw new AppError(401, 'Invalid email or password', 'AUTH_INVALID_CREDENTIALS');
      }

      return { id: user.id, email: user.email, roles: [...user.roles] };
    },
  });
}
