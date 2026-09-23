import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Encrypted personal data, in its own table rather than as columns on `users`.
 *
 * Three reasons, in order of how often they matter:
 *
 * 1. Erasure is a `DELETE` of one row. On `users` it would be an `UPDATE` that
 *    leaves the old ciphertext in a dead tuple until vacuum, in every index
 *    page that referenced it, and in every WAL segment shipped to a replica.
 * 2. `SELECT * FROM users` is written in a hundred places, including this
 *    repository's own generic repository. Personal data that lives on that row
 *    ends up in responses, logs and CSV exports by default, and stays out of
 *    them only for as long as everyone remembers to exclude it.
 * 3. `GRANT` works per table. A reporting role can have `users` without ever
 *    being able to read this.
 *
 * `bytea`, not `text`: an envelope is bytes, and storing it base64'd would add
 * a third of its size and invite a tool somewhere to re-encode it. `pg` returns
 * `bytea` as a `Buffer`, which is what the cipher takes.
 *
 * The `_encrypted` suffix is load-bearing. A column called `phone` holding
 * ciphertext is a column somebody will one day write a plaintext phone number
 * into, and nothing at any layer would object.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.createTable('user_pii', {
    // The primary key *is* the user's id: one PII row per user, sharing its
    // identity rather than carrying a surrogate key beside a unique foreign
    // key. Named `id` because that is the column the repository base class
    // addresses rows by, so this table gets `findById`, `update` and `delete`
    // without overriding any of them.
    //
    // It is also the value bound into every envelope in the row as additional
    // authenticated data, which is why it has to be an id the caller already
    // holds: the binding has to be known before the insert, and a
    // `gen_random_uuid()` default is known after it.
    id: {
      type: 'uuid',
      primaryKey: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    phone_encrypted: { type: 'bytea' },
    address_encrypted: { type: 'bytea' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Deliberately no index on either encrypted column. A fresh data key and
  // nonce per value means equal plaintexts produce unrelated ciphertexts, so an
  // index could serve no lookup — it would only make the write slower and put
  // another copy of the ciphertext in another file. Looking a field up by value
  // needs a blind index, which is a separate column and a separate decision:
  // see docs/field-encryption.md.
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('user_pii');
}
