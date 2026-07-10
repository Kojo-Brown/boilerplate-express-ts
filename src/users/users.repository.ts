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

  async findByRole(role: string): Promise<UserRow[]> {
    return this.findWhere({ roles: [role] as unknown as string[] });
  }
}

export const userRepository = new UserRepository();
