import type { QueryResultRow } from 'pg';
import { BaseRepository } from '@/db/repository';

export interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  password_hash: string | null;
  roles: string[];
  created_at: Date;
  updated_at: Date;
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

export class UserRepository extends BaseRepository<UserRow, UserInsert, UserUpdate> {
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

