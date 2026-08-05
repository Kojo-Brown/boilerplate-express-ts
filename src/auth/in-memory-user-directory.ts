import type { AuthUser, UserDirectory } from '@/auth/auth.types';

// Stub user store — replaced with DB queries in Phase 3 by passing a different
// `UserDirectory` to `createAuthService`.
//
// Hashes are non-functional placeholders in argon2id's encoding shape; they
// verify against nothing. Regenerate via hashPassword() when seeding a real DB.
const SEED_USERS: readonly AuthUser[] = [
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

export function createInMemoryUserDirectory(
  users: readonly AuthUser[] = SEED_USERS,
): UserDirectory {
  return {
    async findByEmail(email: string): Promise<AuthUser | null> {
      return users.find((u) => u.email === email) ?? null;
    },
  };
}

/** Process-wide default instance, wired up in the composition root. */
export const inMemoryUserDirectory: UserDirectory = createInMemoryUserDirectory();
