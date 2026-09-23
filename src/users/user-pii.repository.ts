import type { QueryResultRow } from 'pg';
import { BaseRepository } from '@/db/repository';
import type { Queryable } from '@/db/queryable';
import { getFieldCipher } from '@/crypto/field-encryption';
import type { FieldCipher, FieldContext } from '@/crypto/field-cipher';

/** The table, and the first component of every context bound into its rows. */
export const USER_PII_TABLE = 'user_pii';

/** The encrypted columns, and the second component of those contexts. */
export const PHONE_COLUMN = 'phone_encrypted';
export const ADDRESS_COLUMN = 'address_encrypted';

/**
 * The row as it is stored: envelopes, or nothing.
 *
 * `id` is the user's id — this table shares the identity of the row it belongs
 * to rather than carrying a surrogate key. See the migration.
 */
export interface UserPiiRow extends QueryResultRow {
  id: string;
  phone_encrypted: Buffer | null;
  address_encrypted: Buffer | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The insert and update shapes the inherited CRUD methods take.
 *
 * `Buffer`, never `string`, and that is the safety property that lets this
 * class inherit `create`, `update` and `createMany` without them becoming ways
 * to bypass the cipher: a caller reaching past `savePii` to write a plaintext
 * phone number does not get a row of readable PII, it gets a compile error.
 * The reverse direction — reading an envelope back through `findById` — is
 * harmless, because an envelope is not something a caller can do anything with
 * except hand to the cipher.
 */
// A type alias rather than an interface, as `UserInsert` in
// `users.repository.ts` is: the base class constrains its insert and update
// parameters to `Record<string, unknown>`, and only an alias gets the implicit
// index signature that satisfies it.
export type UserPiiInsert = {
  id: string;
  phone_encrypted?: Buffer | null;
  address_encrypted?: Buffer | null;
};

export type UserPiiUpdate = Omit<UserPiiInsert, 'id'>;

/** What a caller reads and writes: plaintext, never an envelope. */
export interface UserPii {
  readonly userId: string;
  readonly phone: string | null;
  readonly address: string | null;
}

/**
 * A write. An omitted field is left alone; `null` clears it.
 *
 * The distinction is why this is not `Partial<UserPii>` with `undefined` doing
 * both jobs: "the caller did not mention the address" and "the user asked us to
 * erase their address" are different instructions, and a shape that cannot tell
 * them apart either makes the second unexpressible or performs it on every
 * partial update.
 */
export interface UserPiiWrite {
  readonly phone?: string | null;
  readonly address?: string | null;
}

/** One page of a rotation pass. */
export interface RewrapPage {
  /** Rows examined, whether or not they needed anything. */
  readonly scanned: number;
  /** Rows whose envelopes were re-wrapped under the active key. */
  readonly rewrapped: number;
  /** Where the next page starts, or `null` at the end of the table. */
  readonly nextCursor: string | null;
}

/**
 * `user_pii`, with encryption at its edge: nothing above this class holds an
 * envelope, and nothing below it holds a plaintext.
 *
 * The cipher is a constructor parameter rather than a module-level import so a
 * test can hand in one built on a ring it controls — which is what makes the
 * rotation tests possible at all, since they need two rings over one table.
 */
export class UserPiiRepository extends BaseRepository<
  UserPiiRow,
  UserPiiInsert,
  UserPiiUpdate
> {
  protected override readonly tableName = USER_PII_TABLE;

  constructor(private readonly cipher: FieldCipher = getFieldCipher()) {
    super();
  }

  private context(userId: string, column: string): FieldContext {
    return { table: USER_PII_TABLE, column, id: userId };
  }

  private decode(row: UserPiiRow): UserPii {
    return {
      userId: row.id,
      phone: row.phone_encrypted
        ? this.cipher.decryptText(row.phone_encrypted, this.context(row.id, PHONE_COLUMN))
        : null,
      address: row.address_encrypted
        ? this.cipher.decryptText(row.address_encrypted, this.context(row.id, ADDRESS_COLUMN))
        : null,
    };
  }

  /**
   * `undefined` (not mentioned) and `null` (clear it) both bind as SQL `NULL`;
   * which of the two the statement means is decided by the upsert's `SET`
   * clause, not here.
   */
  private encryptOrNull(
    userId: string,
    column: string,
    value: string | null | undefined,
  ): Buffer | null {
    return value === undefined || value === null
      ? null
      : this.cipher.encrypt(value, this.context(userId, column));
  }

  /** One user's personal data, decrypted, or `null` if they have no row. */
  async findPii(userId: string, tx?: Queryable): Promise<UserPii | null> {
    const row = await this.findById(userId, tx);
    return row ? this.decode(row) : null;
  }

  /**
   * Insert or update one user's personal data, encrypting whatever the caller
   * named.
   *
   * An upsert rather than `create`-or-`update`, because the read-then-write
   * version of this races: two concurrent saves both find no row and both
   * insert, and the loser gets a unique violation on a path that looks like it
   * only ever updates. `ON CONFLICT` makes the database settle it in one
   * statement.
   *
   * `COALESCE(EXCLUDED.x, user_pii.x)` is what makes an omitted field "leave it
   * alone": the insert carries `NULL` for anything the caller did not mention,
   * and the coalesce keeps what is stored. Clearing therefore cannot go through
   * the same expression — `NULL` already means "not mentioned" on the way in —
   * so an explicitly cleared column is assigned `NULL` outright.
   */
  async savePii(userId: string, values: UserPiiWrite, tx?: Queryable): Promise<UserPii> {
    const phone = this.encryptOrNull(userId, PHONE_COLUMN, values.phone);
    const address = this.encryptOrNull(userId, ADDRESS_COLUMN, values.address);

    const assignments = [
      assignment(PHONE_COLUMN, values.phone === null),
      assignment(ADDRESS_COLUMN, values.address === null),
      '"updated_at" = NOW()',
    ];

    const row = await this.executor(tx).queryOne<UserPiiRow>(
      `INSERT INTO "${USER_PII_TABLE}" ("id", "${PHONE_COLUMN}", "${ADDRESS_COLUMN}")
       VALUES ($1, $2, $3)
       ON CONFLICT ("id") DO UPDATE SET ${assignments.join(', ')}
       RETURNING *`,
      [userId, phone, address],
    );

    if (!row) {
      // `RETURNING` on an upsert always produces a row; none means the
      // statement did not run the branch it appears to. Louder than returning
      // the values the caller passed in, which would look like a successful
      // write of data that is not stored anywhere.
      throw new Error(`Upsert into "${USER_PII_TABLE}" returned no rows`);
    }
    return this.decode(row);
  }

  /**
   * Re-wrap one page of rows under the ring's active key.
   *
   * Keyset pagination on the primary key, not `OFFSET`: rotation runs against a
   * live table, and an offset scan re-reads and skips everything it has already
   * passed on every page while concurrent inserts shift rows across page
   * boundaries — rows get visited twice, or missed. A cursor on `id` visits
   * every row that exists throughout the pass exactly once.
   *
   * The `SELECT` is written out rather than assembled from `findAll`, which
   * pages by offset and has no cursor to give: this is the query the paging
   * argument above is about.
   *
   * Rows already on the active key are scanned and skipped, so a pass is
   * restartable and a second pass is nearly free. That scan is the cost of not
   * having a `key_id` column to index — the trade a table large enough to care
   * should make, per `docs/field-encryption.md`.
   */
  async rewrapPage(cursor: string | null, limit: number, tx?: Queryable): Promise<RewrapPage> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`rewrapPage: limit must be an integer >= 1, received ${String(limit)}`);
    }

    const rows = await this.executor(tx).query<UserPiiRow>(
      `SELECT * FROM "${USER_PII_TABLE}"
       WHERE $1::uuid IS NULL OR "id" > $1::uuid
       ORDER BY "id"
       LIMIT $2`,
      [cursor, limit],
    );

    let rewrapped = 0;
    for (const row of rows) {
      const update: UserPiiUpdate = {};
      const phone = row.phone_encrypted;
      if (phone && this.cipher.needsRewrap(phone)) {
        update.phone_encrypted = this.cipher.rewrap(phone, this.context(row.id, PHONE_COLUMN));
      }
      const address = row.address_encrypted;
      if (address && this.cipher.needsRewrap(address)) {
        update.address_encrypted = this.cipher.rewrap(address, this.context(row.id, ADDRESS_COLUMN));
      }
      if (Object.keys(update).length === 0) continue;

      await this.update(row.id, update, tx);
      rewrapped += 1;
    }

    const last = rows.at(-1);
    return {
      scanned: rows.length,
      rewrapped,
      // A short page is the end of the table. Signalling it through the cursor
      // rather than leaving the caller to compare `scanned` with `limit` keeps
      // the "are we done?" decision in the one place that knows the query.
      nextCursor: rows.length === limit && last ? last.id : null,
    };
  }
}

/**
 * One column's `DO UPDATE SET` clause.
 *
 * Column names come from the constants above and never from a caller, so the
 * interpolation here is a template rather than a query built out of input.
 */
function assignment(column: string, clear: boolean): string {
  return clear
    ? `"${column}" = NULL`
    : `"${column}" = COALESCE(EXCLUDED."${column}", "${USER_PII_TABLE}"."${column}")`;
}
