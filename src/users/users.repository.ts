import type { QueryResultRow } from 'pg';
import { VersionedRepository } from '@/db/versioned-repository';
import type { RowLockStrength } from '@/db/locking';
import type { TransactionClient } from '@/db/transaction';

/** The role the last-administrator invariant is about. */
export const ADMIN_ROLE = 'admin';

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

  /**
   * Lock every administrator, in `id` order, for the rest of `tx`.
   *
   * This is the read half of the last-administrator invariant, and it has to
   * lock rather than merely read because the rule spans rows. Two transactions
   * demoting two different administrators each leave their own row's version
   * untouched, so both pass their `If-Match` preconditions and both observe two
   * administrators; optimistic concurrency has nothing to compare and the
   * system ends with none. Holding the set still is the only thing that orders
   * them, and under `read committed` the second transaction's scan re-checks
   * the row it waited on and sees the demotion, so it counts one and refuses.
   *
   * `strength` is the caller's, because the two writers need different modes:
   * a role change is a non-key update, so `no key update` is enough and leaves
   * inserts that merely reference these users unblocked, while a delete does
   * change the key and needs the full `update`. Defaulting to the stronger of
   * the two would make every role edit contend with unrelated referencing
   * writes, which is a real cost paid for nothing.
   */
  async lockAdmins(tx: TransactionClient, strength: RowLockStrength): Promise<UserRow[]> {
    return this.lockWhereArrayContains(tx, 'roles', [ADMIN_ROLE], { strength });
  }
}

// There is deliberately no module-level `userRepository` here. The one instance
// is registered in the composition root under `USER_REPOSITORY` and resolved
// from the request scope, so its lifetime is a decision someone made rather
// than a consequence of where `new` happened to be written.

