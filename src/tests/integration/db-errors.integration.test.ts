import { postgresErrorTranslator } from '@/db/db.errors';
import { query } from '@/db/query';
import { withTransaction } from '@/db/transaction';
import { createTable, holding, truncate } from './fixtures';

/**
 * The SQLSTATE table in `db.errors.ts`, checked against errors Postgres
 * actually raised.
 *
 * The unit suite constructs a `DatabaseError`, assigns `code = '23505'` and
 * asserts the translator answers 409. That is a complete test of the lookup and
 * no test at all of the table's contents: a code written from memory, a
 * violation that turns out to arrive as a different SQLSTATE than expected, or
 * a constraint shape this codebase uses that Postgres reports under a code the
 * table does not list, all pass the unit suite and reach a client as a 500.
 *
 * So nothing here invents an error. Each case provokes the real violation
 * through the real query layer and puts whatever came back into the translator.
 *
 * The last case is the important one in the other direction: an error that is
 * *not* in the table must stay a 500. A translator that answered 4xx for an
 * undefined table would turn "we deployed without the migration" into a client
 * error, which is a 500 the operator needs to see.
 */

const PARENT = 'it_err_parent';
const CHILD = 'it_err_child';

beforeAll(async () => {
  await createTable(PARENT, 'id uuid PRIMARY KEY, email text NOT NULL UNIQUE');
  await createTable(
    CHILD,
    `
      id uuid PRIMARY KEY,
      parent_id uuid NOT NULL REFERENCES "${PARENT}" (id),
      quantity integer NOT NULL CONSTRAINT it_err_quantity_positive CHECK (quantity > 0)
    `,
  );
});

beforeEach(async () => {
  await truncate(CHILD, PARENT);
  await query(
    `INSERT INTO "${PARENT}" (id, email) VALUES ('11111111-1111-1111-1111-111111111111', 'taken@example.test')`,
  );
});

/** Runs `sql`, expecting it to fail, and hands the error to the translator. */
async function translate(sql: string, params?: unknown[]): Promise<unknown> {
  const error = await query(sql, params).then(
    () => {
      throw new Error(`expected this statement to fail: ${sql}`);
    },
    (err: unknown) => err,
  );
  return postgresErrorTranslator(error);
}

describe('integrity violations', () => {
  it('unique_violation is a 409', async () => {
    expect(
      await translate(
        `INSERT INTO "${PARENT}" (id, email) VALUES ('22222222-2222-2222-2222-222222222222', 'taken@example.test')`,
      ),
    ).toEqual({
      statusCode: 409,
      code: 'UNIQUE_VIOLATION',
      message: 'A record with those values already exists',
    });
  });

  it('foreign_key_violation is a 409 whether the parent is missing or still referenced', async () => {
    const expected = {
      statusCode: 409,
      code: 'FOREIGN_KEY_VIOLATION',
      message: 'A referenced record is missing or still in use',
    };

    // Insert naming a parent that is not there.
    expect(
      await translate(
        `INSERT INTO "${CHILD}" (id, parent_id, quantity) VALUES ('33333333-3333-3333-3333-333333333333', '99999999-9999-9999-9999-999999999999', 1)`,
      ),
    ).toEqual(expected);

    // And the other direction, which is the same SQLSTATE from the opposite
    // mistake: deleting a parent a child still points at.
    await query(
      `INSERT INTO "${CHILD}" (id, parent_id, quantity) VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 1)`,
    );
    expect(
      await translate(`DELETE FROM "${PARENT}" WHERE id = '11111111-1111-1111-1111-111111111111'`),
    ).toEqual(expected);
  });

  it('not_null_violation is a 422', async () => {
    expect(
      await translate(`INSERT INTO "${PARENT}" (id, email) VALUES ('55555555-5555-5555-5555-555555555555', NULL)`),
    ).toEqual({
      statusCode: 422,
      code: 'NOT_NULL_VIOLATION',
      message: 'A required field was missing',
    });
  });

  it('check_violation is a 422', async () => {
    expect(
      await translate(
        `INSERT INTO "${CHILD}" (id, parent_id, quantity) VALUES ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 0)`,
      ),
    ).toEqual({
      statusCode: 422,
      code: 'CHECK_VIOLATION',
      message: 'A field failed a database constraint',
    });
  });

  it('invalid_text_representation is a 400, which is how a malformed uuid arrives', async () => {
    // The case the code-comment names: a path parameter that is not a uuid
    // reaches the server as text and fails in the cast, not in validation.
    expect(await translate(`SELECT * FROM "${PARENT}" WHERE id = $1`, ['not-a-uuid'])).toEqual({
      statusCode: 400,
      code: 'INVALID_INPUT_SYNTAX',
      message: 'A field was not in the expected format',
    });
  });
});

describe('contention failures', () => {
  it('serialization_failure is a 409 asking the client to retry', async () => {
    const error = await withTransaction(
      async (tx) => {
        await tx.query(`SELECT email FROM "${PARENT}" LIMIT 1`);
        await query(`UPDATE "${PARENT}" SET email = 'moved@example.test' WHERE id = '11111111-1111-1111-1111-111111111111'`);
        await tx.query(`UPDATE "${PARENT}" SET email = 'mine@example.test' WHERE id = '11111111-1111-1111-1111-111111111111'`);
      },
      { isolationLevel: 'repeatable read' },
    ).catch((err: unknown) => err);

    expect(postgresErrorTranslator(error)).toEqual({
      statusCode: 409,
      code: 'WRITE_CONFLICT',
      message: 'The request conflicted with a concurrent write; please retry',
    });
  });

  it('lock_not_available is a 409 with its own code, because the row is still held', async () => {
    const error = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          await tx.query(`SELECT id FROM "${PARENT}" LIMIT 1 FOR UPDATE`);
          held();
          await release;
        }),
      async () =>
        withTransaction(async (tx) =>
          tx.query(`SELECT id FROM "${PARENT}" LIMIT 1 FOR UPDATE NOWAIT`),
        ).catch((err: unknown) => err),
    );

    // `RESOURCE_LOCKED` and not `WRITE_CONFLICT`: the two mean different things
    // to a client deciding how to back off — "you were rolled back" against
    // "somebody is still holding it".
    expect(postgresErrorTranslator(error)).toEqual({
      statusCode: 409,
      code: 'RESOURCE_LOCKED',
      message: 'The record is being modified by another request; please retry',
    });
  });
});

describe('what is deliberately not translated', () => {
  it('leaves an undefined table to the 500 handler', async () => {
    // `42P01`. A deployment that is missing a migration is not a client error,
    // and answering 4xx for it would hide the one failure an operator has to
    // see.
    expect(await translate('SELECT * FROM "it_err_no_such_table"')).toBeNull();
  });

  it('leaves a syntax error and a division by zero alone too', async () => {
    expect(await translate('SELECT FROM WHERE')).toBeNull();
    expect(await translate('SELECT 1 / 0')).toBeNull();
  });

  it('returns null for anything that is not a driver error', () => {
    expect(postgresErrorTranslator(new Error('not from pg'))).toBeNull();
  });
});
