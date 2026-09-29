import type { UserRow } from '@/users/users.repository';

/**
 * A user as the API is allowed to describe one.
 *
 * `UserRow` is the *table*, and the two were the same type until now: every
 * users route answered with the row the repository handed back, so
 * `password_hash` — an argon2id digest of the account's password — was in the
 * body of `GET /v1/users/:id`, of `POST /v1/users`, of both writes, and in the
 * cached copy of each. Nothing was exploiting it; nothing had to. A password
 * digest is the one value whose whole purpose is that the server is the only
 * party holding it, and it was being served to every authenticated caller and
 * written into every client's logs.
 *
 * The projection is a *list of fields to keep* rather than a `delete
 * row.password_hash`, and that direction is the only part of this module worth
 * arguing about. Both are one line today; they differ in what happens to the
 * column somebody adds next year. Subtracting one known name leaves every
 * future column exposed by default — the failure is silent, it ships with a
 * migration nobody reviewed for this, and it is exactly how this leak got here.
 * Naming the keepers fails the other way: a new column is invisible to clients
 * until someone comes here and says it may be seen.
 *
 * `version` is on the list because a client that cannot read it has nothing to
 * put in the `If-Match` the writes require — see `sendWithETag`.
 */
export interface PublicUser {
  id: string;
  email: string;
  roles: string[];
  created_at: Date;
  updated_at: Date;
  version: number;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    roles: row.roles,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

export function toPublicUsers(rows: readonly UserRow[]): PublicUser[] {
  return rows.map(toPublicUser);
}
