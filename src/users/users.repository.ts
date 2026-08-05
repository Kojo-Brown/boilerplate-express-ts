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

export const userRepository = new UserRepository();
