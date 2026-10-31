import type { QueryResultRow } from 'pg';
import { query, queryOne } from '@/db/query';
import { BaseRepository, MAX_BIND_PARAMETERS } from '@/db/repository';
import { withTransaction } from '@/db/transaction';
import { createTable, truncate, TIMESTAMP_COLUMNS } from './fixtures';

/**
 * `BaseRepository` against a server that parses its SQL.
 *
 * The unit suite (`src/db/repository.test.ts`) mocks `@/db/query` and asserts on
 * the strings this class builds. That is the right way to pin down *which*
 * statement each method composes, and it cannot tell whether any of them is
 * valid SQL: a mock accepts a mis-numbered placeholder, an unbalanced quote, an
 * `ON CONFLICT` clause the grammar rejects and a column list that disagrees with
 * the `VALUES` tuples, and reports every one of them as the expected string.
 * Nothing in this file asserts on a statement. Every assertion here is about
 * what the server did with it.
 *
 * Five things that only appear here:
 *
 * - The statements parse and plan at all.
 * - Identifier quoting is load-bearing, not decoration. `"order"` is a reserved
 *   word; the column exists to prove the quotes are doing work, because an
 *   unquoted version of the same statement is a syntax error rather than a
 *   subtly different result.
 * - Values survive the round trip with their types. `pg` returns `timestamptz`
 *   as a `Date`, `integer` as a `number` and `bigint`/`count` as a *string*,
 *   which is why `queryCount` parses and why asserting it against a mock that
 *   returned a number proves nothing.
 * - Defaults are applied by the server. `create` with an omitted column is only
 *   correct if the column's `DEFAULT` fills it, and a mock has no defaults.
 * - `ON CONFLICT ... DO NOTHING` with `RETURNING *` really does return the
 *   inserted rows only, which is the claim `createMany`'s documentation makes
 *   about counting writes rather than attempts.
 */

const TABLE = 'it_items';
const DEFAULTS_TABLE = 'it_defaults';

interface ItemRow extends QueryResultRow {
  id: string;
  name: string;
  value: number;
  tags: string[];
  order: number | null;
  created_at: Date;
  updated_at: Date;
}

type ItemInsert = { name: string; value?: number; tags?: string[]; order?: number | null };
type ItemUpdate = Partial<ItemInsert> & { id?: string; created_at?: Date };

class ItemRepository extends BaseRepository<ItemRow, ItemInsert, ItemUpdate> {
  protected override readonly tableName = TABLE;

  /** The two `protected` helpers, exposed so the suite can reach them. */
  withTag(tags: readonly string[]): Promise<ItemRow[]> {
    return this.findWhereArrayContains('tags', tags);
  }
}

interface DefaultsRow extends QueryResultRow {
  id: string;
  label: string;
}

class DefaultsRepository extends BaseRepository<DefaultsRow, Record<string, never>> {
  protected override readonly tableName = DEFAULTS_TABLE;
  protected override readonly hasTimestamps = false;
}

const items = new ItemRepository();
const defaults = new DefaultsRepository();

beforeAll(async () => {
  await createTable(
    TABLE,
    `
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(64) NOT NULL UNIQUE,
      value integer NOT NULL DEFAULT 7,
      tags text[] NOT NULL DEFAULT ARRAY['default']::text[],
      "order" integer,
      ${TIMESTAMP_COLUMNS}
    `,
  );
  await createTable(
    DEFAULTS_TABLE,
    `
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label text NOT NULL DEFAULT 'unlabelled'
    `,
  );
});

beforeEach(async () => {
  await truncate(TABLE, DEFAULTS_TABLE);
});

describe('create', () => {
  it('returns the inserted row with the server’s defaults filled in', async () => {
    const row = await items.create({ name: 'first' });

    expect(row.name).toBe('first');
    // Neither of these came from the statement: `value` and `tags` were not in
    // the column list, so the row proves the server applied the `DEFAULT`.
    expect(row.value).toBe(7);
    expect(row.tags).toEqual(['default']);
    expect(row.order).toBeNull();
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it('writes an explicit array and a reserved-word column', async () => {
    const row = await items.create({ name: 'second', tags: ['a', 'b'], order: 3 });

    expect(row.tags).toEqual(['a', 'b']);
    expect(row.order).toBe(3);
  });

  it('inserts DEFAULT VALUES when the patch is empty', async () => {
    const row = await defaults.create({});

    expect(row.label).toBe('unlabelled');
  });

  it('fails the statement on a unique violation rather than inserting twice', async () => {
    await items.create({ name: 'dupe' });

    await expect(items.create({ name: 'dupe' })).rejects.toMatchObject({ code: '23505' });
    expect(await items.count()).toBe(1);
  });
});

describe('createMany', () => {
  it('inserts every row in one statement and returns them', async () => {
    const rows = await items.createMany([
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
      { name: 'c', value: 3 },
    ]);

    expect(rows.map((row) => row.name)).toEqual(['a', 'b', 'c']);
    expect(rows.map((row) => row.value)).toEqual([1, 2, 3]);
    expect(await items.count()).toBe(3);
  });

  it('rolls the whole statement back when one row collides and conflicts are errors', async () => {
    await items.create({ name: 'taken' });

    await expect(
      items.createMany([{ name: 'fresh' }, { name: 'taken' }, { name: 'also-fresh' }]),
    ).rejects.toMatchObject({ code: '23505' });

    // The point of the assertion: a single statement is atomic even outside an
    // explicit transaction, so the two rows that would have succeeded are not
    // there. A loop over `create` would have left them.
    expect(await items.count()).toBe(1);
  });

  it('returns only the rows it actually inserted under DO NOTHING', async () => {
    await items.create({ name: 'taken' });

    const inserted = await items.createMany(
      [{ name: 'taken' }, { name: 'new-1' }, { name: 'new-2' }],
      { onConflict: 'ignore', conflictTarget: ['name'] },
    );

    expect(inserted.map((row) => row.name)).toEqual(['new-1', 'new-2']);
    // Which is what makes `inserted.length` a count of writes and not of
    // attempts — the claim `createMany`'s own documentation makes.
    expect(inserted).toHaveLength(2);
    expect(await items.count()).toBe(3);
  });

  it('absorbs a conflict on any constraint when no target is named', async () => {
    await items.create({ name: 'taken' });

    const inserted = await items.createMany([{ name: 'taken' }, { name: 'new' }], {
      onConflict: 'ignore',
    });

    expect(inserted.map((row) => row.name)).toEqual(['new']);
  });

  it('refuses a batch over the protocol’s bind-parameter ceiling before sending it', async () => {
    const columns = 4;
    const rows = Array.from({ length: Math.ceil(MAX_BIND_PARAMETERS / columns) + 1 }, (_, i) => ({
      name: `row-${String(i)}`,
      value: i,
      tags: ['x'],
      order: i,
    }));

    // The reason this is checked in the repository and not left to the server:
    // `pg` would send a Bind message whose parameter count does not fit the
    // protocol's `int16`, and the failure names nothing that leads to the batch
    // size.
    await expect(items.createMany(rows)).rejects.toThrow(RangeError);
    expect(await items.count()).toBe(0);
  });
});

describe('reads', () => {
  beforeEach(async () => {
    await items.createMany([
      { name: 'alpha', value: 10, tags: ['red', 'small'], order: 2 },
      { name: 'beta', value: 20, tags: ['red', 'large'], order: 1 },
      { name: 'gamma', value: 30, tags: ['blue'], order: 3 },
    ]);
  });

  it('findById returns the row, and null for an id that is absent', async () => {
    const created = await items.findOne({ name: 'alpha' });
    expect(created).not.toBeNull();

    const found = await items.findById(created!.id);
    expect(found?.name).toBe('alpha');

    expect(await items.findById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('findWhere orders, limits and offsets on the server', async () => {
    const page = await items.findWhere({}, { orderBy: 'name', order: 'DESC', limit: 2 });
    expect(page.map((row) => row.name)).toEqual(['gamma', 'beta']);

    const next = await items.findWhere({}, { orderBy: 'name', order: 'DESC', limit: 2, offset: 2 });
    expect(next.map((row) => row.name)).toEqual(['alpha']);
  });

  it('orders by a reserved-word column, which is what the quoting is for', async () => {
    const ordered = await items.findAll({ orderBy: 'order', order: 'ASC' });

    expect(ordered.map((row) => row.name)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('findWhere compares an array column for equality, not containment', async () => {
    expect((await items.findWhere({ tags: ['red', 'small'] })).map((row) => row.name)).toEqual([
      'alpha',
    ]);
    // The distinction the `findWhereArrayContains` doc-comment exists for: the
    // same argument through `@>` matches both red rows.
    expect((await items.withTag(['red'])).map((row) => row.name).sort()).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('counts with and without a predicate, parsing the server’s string', async () => {
    const total = await items.count();
    const red = await items.count({ tags: ['red', 'small'] });

    // `COUNT(*)` arrives as a string because it is a `bigint`; both of these
    // being numbers is `queryCount` having parsed it.
    expect(total).toBe(3);
    expect(red).toBe(1);
    expect(typeof total).toBe('number');
  });

  it('findOne with no conditions returns some row rather than failing', async () => {
    expect(await items.findOne({})).not.toBeNull();
  });

  it('drops undefined conditions instead of comparing against NULL', async () => {
    const found = await items.findWhere({ name: 'alpha', value: undefined });

    // `value = NULL` is never true, so a condition built from the undefined
    // entry would have returned nothing here.
    expect(found.map((row) => row.name)).toEqual(['alpha']);
  });
});

describe('update', () => {
  it('writes the patch and moves updated_at past created_at', async () => {
    const created = await items.create({ name: 'before', value: 1 });

    const updated = await items.update(created.id, { name: 'after', value: 2 });

    expect(updated?.name).toBe('after');
    expect(updated?.value).toBe(2);
    expect(updated?.created_at.getTime()).toBe(created.created_at.getTime());
    // `NOW()` is the transaction's start time, and these are two autocommit
    // statements, so it has advanced.
    expect(updated!.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime());
  });

  it('ignores a patch’s attempt to write id or created_at', async () => {
    const created = await items.create({ name: 'immutable' });
    const forged = '11111111-1111-1111-1111-111111111111';

    const updated = await items.update(created.id, {
      id: forged,
      created_at: new Date('2000-01-01T00:00:00.000Z'),
      value: 99,
    });

    expect(updated?.id).toBe(created.id);
    expect(updated?.created_at.getTime()).toBe(created.created_at.getTime());
    expect(updated?.value).toBe(99);
    expect(await items.findById(forged)).toBeNull();
  });

  it('issues no statement for a patch with nothing writable in it', async () => {
    const created = await items.create({ name: 'untouched' });

    const result = await items.update(created.id, { id: 'ignored' });

    // Returned by `findById`, so `updated_at` has not moved — which is the
    // observable difference between this and an `UPDATE` with only the
    // timestamp clause.
    expect(result?.updated_at.getTime()).toBe(created.updated_at.getTime());
  });

  it('returns null for an id that is not there', async () => {
    expect(await items.update('00000000-0000-0000-0000-000000000000', { value: 1 })).toBeNull();
  });
});

describe('delete', () => {
  it('reports whether a row was removed', async () => {
    const created = await items.create({ name: 'doomed' });

    expect(await items.delete(created.id)).toBe(true);
    expect(await items.delete(created.id)).toBe(false);
    expect(await items.count()).toBe(0);
  });
});

describe('the executor', () => {
  it('joins the caller’s transaction when one is passed, and the pool when not', async () => {
    const outside = await withTransaction(async (tx) => {
      await items.create({ name: 'in-tx' }, tx);

      // The same repository method, the same process, two different
      // connections: the pool cannot see an uncommitted row. This is the whole
      // argument for the optional executor, and a mocked query layer cannot
      // produce it because there is only ever one fake.
      expect(await items.count()).toBe(0);
      expect(await items.count(undefined, tx)).toBe(1);

      return items.findOne({ name: 'in-tx' });
    });

    expect(outside).toBeNull();
    expect(await items.count()).toBe(1);
  });

  it('rolls the row back with the transaction that created it', async () => {
    await expect(
      withTransaction(async (tx) => {
        await items.create({ name: 'rolled-back' }, tx);
        throw new Error('abandon');
      }),
    ).rejects.toThrow('abandon');

    expect(await items.count()).toBe(0);
  });
});

describe('the statements themselves', () => {
  it('leaves no prepared-statement or plan residue the next call trips over', async () => {
    // Twelve different shapes of statement from the same repository in one
    // session, which is the case a `$n` numbering bug survives in a unit suite:
    // each call is asserted individually there, and none of them is asserted
    // against the others' parameter lists.
    await items.createMany([{ name: 'x', value: 1 }, { name: 'y', value: 2 }]);
    const found = await items.findOne({ name: 'x', value: 1 });
    await items.update(found!.id, { value: 5, tags: ['t'], order: 1 });
    await items.findWhere({ value: 5 }, { orderBy: 'name', limit: 1, offset: 0 });
    await items.withTag(['t']);
    await items.count({ value: 5 });
    await items.delete(found!.id);

    expect(await items.count()).toBe(1);
    expect((await queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM "it_items"'))?.n).toBe('1');
    expect(await query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });
});
