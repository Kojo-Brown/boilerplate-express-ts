import { LastAdminError } from '@/users/users.errors';
import { ADMIN_ROLE } from '@/users/users.repository';
import type { UserRow } from '@/users/users.repository';
import type { UpdateUserBody } from '@/users/users.schemas';

/**
 * The invariant: at least one account holds `admin` at all times.
 *
 * Not expressible as a constraint. `CHECK` sees one row, and a table-level
 * assertion over a count is not something Postgres implements — the usual
 * substitutes (a trigger counting the survivors, a summary row) each move the
 * problem rather than solving it, since the count they read is subject to the
 * same race unless the rows behind it are held still. So this lives in the
 * application, and what makes it hold is not this function but the lock the
 * caller takes before calling it.
 */

/**
 * Whether this patch would take `admin` away from whoever it is applied to.
 *
 * A patch that does not mention `roles` cannot, and a patch that lists `admin`
 * cannot either — so most updates skip the lock entirely, which is the point of
 * asking. The check is on the incoming body rather than on a diff against the
 * stored row because it runs *before* the row is read: it decides whether the
 * expensive thing (locking every administrator) is needed at all.
 */
export function patchRemovesAdminRole(patch: UpdateUserBody): boolean {
  return patch.roles !== undefined && !patch.roles.includes(ADMIN_ROLE);
}

/**
 * Throws if removing `targetId` from the administrator set would empty it.
 *
 * `admins` must be the *locked* set — `UserRepository.lockAdmins` inside the
 * transaction that performs the write. Called with an unlocked read this
 * function is decorative: it would be answering a question about a set that
 * another transaction is free to change between the answer and the write.
 *
 * A target absent from the set is not an administrator, so the write cannot
 * shrink it and there is nothing to check. That case is a `return`, not an
 * error, and it is the common one — most users are not administrators.
 */
export function assertAdminRemains(admins: readonly UserRow[], targetId: string): void {
  const targetIsAdmin = admins.some((admin) => admin.id === targetId);
  if (!targetIsAdmin) return;
  if (admins.length === 1) throw new LastAdminError();
}
