import type { QueryResultRow } from 'pg';
import { VersionedRepository } from '@/db/versioned-repository';

export interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  password_hash: string | null;
  roles: string[];
  created_at: Date;
  updated_at: Date;
  /**
   * Bumped by a database trigger on every update, never by a caller — see
   * `migrations/*_users_version_column.ts`. It is on the row type, and
   * therefore in the response body, because a client that cannot read the
   * current version has nothing to put in `If-Match`.
   */
  version: number;
}

export type UserInsert = {
  email: string;
  password_hash?: string | null;
  roles?: string[];
};

export type UserUpdate = {
  email?: string;
  password_hash?: string | null;
  roles?: string[];
};

export class UserRepository extends VersionedRepository<UserRow, UserInsert, UserUpdate> {
  protected override readonly tableName = 'users';

  async findByEmail(email: string): Promise<UserRow | null> {
    return this.findOne({ email });
  }

  /**
   * Users who hold `role`, not users whose role list is exactly `[role]`.
   * `roles` is `text[]`, so this is a containment test.
   */
  async findByRole(role: string): Promise<UserRow[]> {
    return this.findWhereArrayContains('roles', [role]);
  }
}

// There is deliberately no module-level `userRepository` here. The one instance
// is registered in the composition root under `USER_REPOSITORY` and resolved
// from the request scope, so its lifetime is a decision someone made rather
// than a consequence of where `new` happened to be written.

