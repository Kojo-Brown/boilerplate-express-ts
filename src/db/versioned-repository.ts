import type { QueryResultRow } from 'pg';
import { BaseRepository } from '@/db/repository';
import { queryOne } from '@/db/query';
import type {
  ConditionalDelete,
  ConditionalUpdate,
  Precondition,
} from '@/concurrency/concurrency.types';

/** What a table needs before a conditional write can be written against it. */
export interface VersionedRow extends QueryResultRow {
  id: string;
  version: number;
}

/** The flag the update statement carries alongside the row. See `stripUpdatedFlag`. */
type Flagged<TRow> = TRow & { __updated: boolean };

/**
 * A repository whose table carries a `version` column, adding compare-and-swap
 * writes to the inherited unconditional ones.
 *
 * ## Why a subclass rather than an option on `BaseRepository`
 *
 * Because `TRow extends VersionedRow` is the whole guarantee. A flag on the
 * base class (`protected readonly hasVersion = true`) would let
 * `updateWithVersion` be called against a table with no such column, and the
 * failure would be a Postgres error at run time on whichever route reached it
 * first. Here, a repository whose row type has no `version` cannot extend this
 * class, so the mistake is a compile error at the declaration.
 *
 * ## The inherited `update` and `delete` are still there, deliberately
 *
 * They are the unconditional writes, and plenty of writes have no client
 * expectation to check — a background job, a migration-time backfill. What
 * makes leaving them exposed safe is that the version is bumped by a database
 * trigger rather than by these statements: an unconditional write still moves
 * the version, so an `ETag` issued before it stops matching afterwards. The
 * guarantee does not depend on every writer going through this class, which is
 * exactly the property a guarantee needs.
 */
export abstract class VersionedRepository<
  TRow extends VersionedRow,
  TInsert extends Record<string, unknown> = Record<string, unknown>,
  TUpdate extends Record<string, unknown> = Partial<TInsert>,
> extends BaseRepository<TRow, TInsert, TUpdate> {
  /**
   * `version` is the database's to set. A patch carrying it is a client — or a
   * careless caller — trying to forge the validator that guards its own write.
   */
  protected override immutableColumns(): readonly string[] {
    return [...super.immutableColumns(), 'version'];
  }

  /**
   * Update the row only if its version satisfies `precondition`.
   *
   * ## Why one statement and not "update, then look"
   *
   * A conditional `UPDATE` that affects no rows cannot say why. The obvious fix
   * is a follow-up `SELECT` to find out whether the row is missing or merely at
   * another version, and it introduces a race of its own: the row can be
   * deleted between the two, so a genuine version conflict gets reported as a
   * 404 — the one answer that tells a client to stop retrying. Both branches
   * here run inside a single statement and therefore a single snapshot, so the
   * answer is the state the write actually lost to.
   *
   * `NOT EXISTS (SELECT 1 FROM updated)` is what keeps the second branch from
   * duplicating the first: the CTE is evaluated once, and the `SELECT` reads
   * the pre-update snapshot, so it can only contribute a row when the update
   * matched nothing.
   *
   * ## Why there is no "nothing to write" shortcut
   *
   * `BaseRepository.update` returns the current row when the patch has no
   * writable columns, rather than issuing an `UPDATE` whose only effect is to
   * touch `updated_at`. Doing that here would answer `updated` — a 200 — to a
   * request whose precondition was stale, because the check that would have
   * caught it is in the statement that was skipped. An empty patch under a
   * precondition is a version assertion, and it has to reach the database.
   */
  async updateWithVersion(
    id: string,
    data: TUpdate,
    precondition: Precondition,
  ): Promise<ConditionalUpdate<TRow>> {
    const immutable = new Set(this.immutableColumns());
    const entries = Object.entries(data).filter(([k]) => !immutable.has(k));

    const params: unknown[] = entries.map(([, v]) => v);
    const setClauses = entries.map(([k], i) => `"${k}" = $${i + 1}`);
    if (this.hasTimestamps) setClauses.push('"updated_at" = NOW()');

    // Stated in the statement even though the trigger computes the same value.
    // It costs nothing — a `BEFORE` trigger's assignment to `NEW.version` wins,
    // so there is no double increment — and it buys two things: the intent is
    // readable at the query rather than only in a migration, and the `SET` list
    // can never be empty, which an empty patch on a table without timestamps
    // would otherwise make it.
    setClauses.push('"version" = "version" + 1');

    params.push(id);
    const idParam = `$${params.length}`;
    let predicate = `"id" = ${idParam}`;

    if (precondition.kind === 'versions') {
      params.push(precondition.versions);
      // `= ANY(...)` rather than `IN (...)`: `If-Match` accepts a list of
      // entity-tags and passes if *any* of them matches, and an array parameter
      // expresses that in one placeholder. An empty list matches no row, which
      // is the correct reading of a header whose every tag was unmatchable.
      predicate += ` AND "version" = ANY($${params.length}::int[])`;
    }

    const sql = `
      WITH updated AS (
        UPDATE "${this.tableName}" SET ${setClauses.join(', ')} WHERE ${predicate} RETURNING *
      )
      SELECT TRUE AS "__updated", u.* FROM updated u
      UNION ALL
      SELECT FALSE AS "__updated", c.* FROM "${this.tableName}" c
      WHERE c."id" = ${idParam} AND NOT EXISTS (SELECT 1 FROM updated)
    `;

    const row = await queryOne<Flagged<TRow>>(sql, params);

    if (row === null) return { outcome: 'missing' };
    if (row.__updated) return { outcome: 'updated', row: stripUpdatedFlag(row) };
    return { outcome: 'conflict', currentVersion: row.version };
  }

  /**
   * Delete the row only if its version satisfies `precondition`.
   *
   * Same statement shape as `updateWithVersion` and for the same reason. The
   * second branch selects only `version`, because there is nothing to return
   * from a successful delete and the conflict case needs one number.
   */
  async deleteWithVersion(id: string, precondition: Precondition): Promise<ConditionalDelete> {
    const params: unknown[] = [id];
    let predicate = '"id" = $1';

    if (precondition.kind === 'versions') {
      params.push(precondition.versions);
      predicate += ` AND "version" = ANY($${params.length}::int[])`;
    }

    const sql = `
      WITH deleted AS (
        DELETE FROM "${this.tableName}" WHERE ${predicate} RETURNING "id"
      )
      SELECT TRUE AS "__deleted", NULL::integer AS "version" FROM deleted
      UNION ALL
      SELECT FALSE AS "__deleted", c."version" FROM "${this.tableName}" c
      WHERE c."id" = $1 AND NOT EXISTS (SELECT 1 FROM deleted)
    `;

    const row = await queryOne<{ __deleted: boolean; version: number | null }>(sql, params);

    if (row === null) return { outcome: 'missing' };
    if (row.__deleted) return { outcome: 'deleted' };
    // Unreachable: the second branch reads a row that exists, and `version` is
    // `NOT NULL` on it. Answering `missing` beats asserting non-null on a value
    // that arrived from outside the process.
    if (row.version === null) return { outcome: 'missing' };
    return { outcome: 'conflict', currentVersion: row.version };
  }
}

/**
 * Drop the discriminator the statement carried, leaving the row.
 *
 * The flag has to be a real column — the two `UNION ALL` branches need
 * something to tell them apart, and `to_jsonb(row)` would have flattened
 * `created_at` from a `Date` into a string on the way out. So it is added in
 * SQL and removed here, and this is the one cast in the file:
 * `Omit<TRow & { __updated: boolean }, '__updated'>` is structurally `TRow` for
 * every concrete row type, but `Omit` does not reduce while `TRow` is still a
 * type parameter, so TypeScript cannot see it.
 */
function stripUpdatedFlag<TRow extends QueryResultRow>(row: Flagged<TRow>): TRow {
  const rest: Record<string, unknown> = { ...row };
  delete rest['__updated'];
  return rest as unknown as TRow;
}
