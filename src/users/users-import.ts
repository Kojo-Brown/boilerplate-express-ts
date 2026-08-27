import { z } from 'zod';
import { MAX_BIND_PARAMETERS } from '@/db/repository';
import type { ColumnSpec } from '@/ingest/header';
import type { UserInsert, UserRepository, UserRow } from '@/users/users.repository';

/**
 * The header this endpoint accepts, and nothing else.
 *
 * `password_hash` is deliberately absent, and its absence is a security
 * decision rather than an oversight. A column that sets a credential directly
 * would let anyone who can reach an admin token mint accounts with a hash they
 * chose — including one they know the pre-image of — and would do it through a
 * bulk endpoint whose whole design tolerates partial success and reports counts
 * rather than rows. Imported users have no password and must go through the
 * magic-link or OAuth flow, which is also what makes this endpoint's blast
 * radius describable in one sentence.
 */
export const USER_IMPORT_COLUMNS: readonly ColumnSpec[] = [
  { name: 'email', required: true },
  { name: 'roles', required: false },
];

/**
 * A CSV field carries no types: everything arrives as a string, and an omitted
 * value and an empty one are indistinguishable. So the schema's job here is
 * wider than it is for a JSON body — it is the layer that decides what a blank
 * cell means, and it has to say so explicitly for each column.
 */
export const userImportRowSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1, 'email is required')
      .email('email must be a valid address')
      // Addresses are compared case-insensitively by every provider that
      // matters, and the unique index is on the stored text. Without this an
      // import containing both `A@x.test` and `a@x.test` creates two accounts
      // that every human involved believes are one.
      .transform((value) => value.toLowerCase()),
    /**
     * A comma-separated list *inside* one CSV field, which means the field has
     * to be quoted — `"admin,auditor"`. That is not a quirk to work around; it
     * is the format doing its job, and it is the reason the parser's quoted-field
     * path is exercised by the ordinary case rather than only by a test.
     *
     * Blank means "the column exists but this row said nothing", which is not
     * the same as `[]` — an explicit empty role list. Mapping blank to
     * `undefined` lets it fall through to the column's `ARRAY['user']` default,
     * where `[]` would override it and create a user who can do nothing.
     */
    roles: z
      .string()
      .optional()
      .transform((value) => {
        if (value === undefined) return undefined;
        const roles = value
          .split(',')
          .map((role) => role.trim())
          .filter((role) => role.length > 0);
        return roles.length > 0 ? roles : undefined;
      }),
  })
  .strip();

export type UserImportRow = z.infer<typeof userImportRowSchema>;

/**
 * Rows per `INSERT`.
 *
 * Two columns, so the protocol's 65,535-parameter ceiling would allow far more
 * than this; the binding constraint is the other one. A batch is also the unit
 * of work whose failure is retried and whose success is reported, and it is
 * held in memory in full — 500 rows is a statement small enough to plan
 * quickly and large enough that the round trip stops being the cost.
 */
export const USER_IMPORT_BATCH_SIZE = 500;

/** Belt and braces: a change to either constant that broke the other would
 * otherwise only be found by the protocol error it causes in production. */
if (USER_IMPORT_BATCH_SIZE * USER_IMPORT_COLUMNS.length > MAX_BIND_PARAMETERS) {
  throw new RangeError('USER_IMPORT_BATCH_SIZE exceeds the bind-parameter ceiling');
}

/**
 * Writes one batch and returns how many rows were *new*.
 *
 * `ON CONFLICT (email) DO NOTHING` is what makes the endpoint safe to retry.
 * Batches commit independently, so a connection lost at row 40,000 leaves the
 * earlier ones written; re-uploading the same file then converges rather than
 * failing on the first duplicate or creating a second copy of everything. It is
 * the property that pays for this ingest not being one transaction — see
 * `ingestCsv`.
 *
 * Rows are de-duplicated within the batch first — and the reason is *not* that
 * the statement would otherwise insert both. It would not: verified against
 * PostgreSQL 16.13, `ON CONFLICT (email) DO NOTHING` handles a repeat inside one
 * command through speculative insertion, inserting the first and skipping the
 * second. (`DO UPDATE` is the form that cannot: it fails outright with "cannot
 * affect row a second time", which is where the folklore comes from.)
 *
 * So this is an optimisation and a narrowing of what the code depends on, not a
 * correctness fix. A file listing one address 500 times would otherwise spend
 * 500 of the statement's bind slots — a hard, protocol-level budget, see
 * `MAX_BIND_PARAMETERS` — to insert one row, which is how a batch sized against
 * that ceiling stops fitting. And doing it here means the count this function
 * returns does not rest on a subtlety of one database's conflict handling.
 */
export async function writeUserImportBatch(
  repository: UserRepository,
  batch: readonly UserImportRow[],
): Promise<number> {
  const seen = new Set<string>();
  const rows: UserInsert[] = [];

  for (const row of batch) {
    if (seen.has(row.email)) continue;
    seen.add(row.email);
    // Uniform keys, because `createMany` builds one column list for the whole
    // statement. `roles: undefined` is not the same as omitting the key — the
    // first is a column in the list bound to `NULL`, which would defeat the
    // table's default — so the property is added only when there is a value.
    rows.push(row.roles === undefined ? { email: row.email } : { email: row.email, roles: row.roles });
  }

  // One statement per distinct shape. In practice a file either carries the
  // `roles` column or does not, so this is one group; a file that leaves the
  // cell blank on some rows produces two, which is still two round trips rather
  // than one per row.
  const groups = new Map<string, UserInsert[]>();
  for (const row of rows) {
    const shape = Object.keys(row).sort().join(',');
    const group = groups.get(shape);
    if (group) group.push(row);
    else groups.set(shape, [row]);
  }

  let written = 0;
  for (const group of groups.values()) {
    const inserted: UserRow[] = await repository.createMany(group, {
      onConflict: 'ignore',
      conflictTarget: ['email'],
    });
    written += inserted.length;
  }
  return written;
}
