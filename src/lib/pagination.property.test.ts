import fc from 'fast-check';

import { AppError } from '@/lib/errors';
import { buildCursorWhere, createCursor, paginate } from '@/lib/pagination';
import { jsonScalar } from '@/tests/property';

/**
 * Cursor pagination as properties, and the last one is a walk over a whole
 * dataset rather than a statement about a single call.
 *
 * Keyset pagination fails in a way unit examples are bad at catching. Each
 * piece is obviously right — the cursor encodes the last row, the `WHERE`
 * clause asks for rows after it, the extra row says whether to keep going — and
 * the bug is in the seam between them: an off-by-one that drops the row on a
 * page boundary, or repeats it, or loops forever when two rows share a sort
 * value. Nothing shows up in a single page. What shows up is a client that
 * paged through a list and never saw one of its own records.
 *
 * So the final test pages through a generated dataset to exhaustion and asserts
 * that what came back is the dataset: every row once, in order. The in-memory
 * predicate standing in for Postgres is the honest limit of it, and is written
 * out where it is used.
 */

const columnName = fc.constantFrom('created_at', 'name', 'rank', 'updated_at');
const idValue = fc.oneof(fc.integer({ min: 1, max: 1_000_000 }), fc.string({ maxLength: 16 }));
const direction = fc.constantFrom<'ASC' | 'DESC'>('ASC', 'DESC');

describe('cursor round-trip (properties)', () => {
  it('returns the row it was built from, whatever the sort column holds', () => {
    fc.assert(
      fc.property(columnName, jsonScalar, idValue, direction, (sortColumn, sortValue, id, order) => {
        const cursor = createCursor({ [sortColumn]: sortValue, id }, sortColumn);
        const clause = buildCursorWhere({ cursor, sortColumn, direction: order });

        // The values are what the query will be parameterised with, so a
        // round-trip that loses a `0`, a `false` or a `null` along the way is a
        // page that silently starts in the wrong place.
        expect(clause.params).toEqual([sortValue, id]);
      }),
    );
  });

  it('is URL-safe, because a cursor spends its life in a query string', () => {
    fc.assert(
      fc.property(columnName, jsonScalar, idValue, (sortColumn, sortValue, id) => {
        const cursor = createCursor({ [sortColumn]: sortValue, id }, sortColumn);
        expect(cursor).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(encodeURIComponent(cursor)).toBe(cursor);
      }),
    );
  });

  it('carries the sort column and the id, and nothing else from the row', () => {
    fc.assert(
      fc.property(
        columnName,
        jsonScalar,
        idValue,
        fc.dictionary(fc.constantFrom('email', 'secret', 'password_hash'), jsonScalar, { maxKeys: 3 }),
        (sortColumn, sortValue, id, extra) => {
          // A cursor is handed to a client. Encoding the whole row would put
          // every column of it in a query string, a log and a browser history.
          const cursor = createCursor({ ...extra, [sortColumn]: sortValue, id }, sortColumn);
          const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          expect(decoded).toEqual({ [sortColumn]: sortValue, id });
        },
      ),
    );
  });

  it('refuses a row that cannot produce a stable cursor', () => {
    fc.assert(
      fc.property(columnName, jsonScalar, (sortColumn, sortValue) => {
        // No id means no tie-break, and no tie-break means two rows sharing a
        // sort value page against each other forever.
        expect(() => createCursor({ [sortColumn]: sortValue }, sortColumn)).toThrow(/missing required fields/);
        expect(() => createCursor({ id: 1 }, sortColumn)).toThrow(/missing required fields/);
      }),
    );
  });
});

describe('buildCursorWhere (properties)', () => {
  it('adds no predicate at all for the first page', () => {
    fc.assert(
      fc.property(columnName, direction, fc.integer({ min: 1, max: 20 }), (sortColumn, order, paramStart) => {
        expect(buildCursorWhere({ cursor: undefined, sortColumn, direction: order, paramStart })).toEqual({
          sql: '',
          params: [],
        });
      }),
    );
  });

  it('numbers its placeholders from paramStart, one per parameter', () => {
    fc.assert(
      fc.property(
        columnName,
        jsonScalar,
        idValue,
        direction,
        fc.integer({ min: 1, max: 20 }),
        (sortColumn, sortValue, id, order, paramStart) => {
          const cursor = createCursor({ [sortColumn]: sortValue, id }, sortColumn);
          const { sql, params } = buildCursorWhere({ cursor, sortColumn, direction: order, paramStart });

          // A clause whose placeholder count and parameter count disagree is a
          // runtime error from Postgres, on a code path a unit test of either
          // half alone cannot reach.
          expect(sql.match(/\$\d+/g)).toEqual([`$${paramStart}`, `$${paramStart + 1}`]);
          expect(params).toHaveLength(2);
          expect(sql).toBe(`("${sortColumn}", "id") ${order === 'ASC' ? '>' : '<'} ($${paramStart}, $${paramStart + 1})`);
        },
      ),
    );
  });

  it('rejects a cursor it did not issue, as a 400 and not a 500', () => {
    fc.assert(
      fc.property(
        columnName,
        direction,
        fc.oneof(
          fc.string({ minLength: 1 }),
          fc.constantFrom('[]', 'null', '"a"', '42').map((json) => Buffer.from(json).toString('base64url')),
          jsonScalar.map((value) => Buffer.from(JSON.stringify({ other: value })).toString('base64url')),
        ),
        (sortColumn, order, cursor) => {
          // The decoder is an input boundary: the value arrives in a query
          // string. Every way it can be wrong has to land on the same
          // client-facing answer rather than on a stack trace.
          let thrown: unknown;
          try {
            buildCursorWhere({ cursor, sortColumn, direction: order });
          } catch (error) {
            thrown = error;
          }

          if (thrown === undefined) return;
          expect(thrown).toBeInstanceOf(AppError);
          expect(thrown).toMatchObject({ statusCode: 400, code: 'INVALID_CURSOR' });
        },
      ),
    );
  });
});

describe('paginate (properties)', () => {
  const rows = fc.array(fc.record({ rank: fc.integer({ min: 0, max: 50 }), id: idValue }), { maxLength: 12 });

  it('returns a prefix of the rows it was given, never more than the limit', () => {
    fc.assert(
      fc.property(rows, fc.integer({ min: 1, max: 10 }), (all, limit) => {
        const page = paginate(all, limit, 'rank');

        expect(page.data).toEqual(all.slice(0, Math.min(all.length, limit)));
        expect(page.meta.hasNextPage).toBe(all.length > limit);
        expect(page.meta.limit).toBe(limit);
        // The caller fetched `limit + 1` rows; the extra one is a signal, not
        // data, and handing it to the client is how a page comes back one row
        // longer than the page size it asked for.
        expect(page.data.length).toBeLessThanOrEqual(limit);
      }),
    );
  });

  it('issues a cursor exactly when there is a next page, pointing at the last row of this one', () => {
    fc.assert(
      fc.property(rows, fc.integer({ min: 1, max: 10 }), (all, limit) => {
        const page = paginate(all, limit, 'rank');

        if (!page.meta.hasNextPage) {
          expect(page.meta.nextCursor).toBeNull();
          return;
        }

        const last = page.data.at(-1);
        expect(last).toBeDefined();
        if (last === undefined) return;

        // Pointing at the *returned* last row rather than at the extra one is
        // the whole of the off-by-one: the other choice skips a row on every
        // page boundary.
        expect(page.meta.nextCursor).toBe(createCursor(last, 'rank'));
      }),
    );
  });
});

describe('paging to exhaustion (properties)', () => {
  /**
   * Postgres's row-value comparison, in memory.
   *
   * `("rank", "id") > ($1, $2)` is lexicographic over the pair, which is the
   * point of using it: it is one index scan and it cannot repeat or skip a row
   * when two rows share a `rank`. The model is numeric on both components, so
   * nothing here rests on a collation — a `text` sort column would order by the
   * database's collation and not by JavaScript's, and this test would be
   * asserting the wrong comparison. The version of this walk that runs against
   * a real Postgres is the Testcontainers item, not this one.
   */
  const after = (
    row: { rank: number; id: number },
    [rank, id]: readonly [number, number],
    order: 'ASC' | 'DESC',
  ): boolean =>
    order === 'ASC'
      ? row.rank > rank || (row.rank === rank && row.id > id)
      : row.rank < rank || (row.rank === rank && row.id < id);

  const dataset = fc
    .uniqueArray(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 40 })), {
      selector: ([, id]) => id,
      maxLength: 20,
    })
    // Ranks drawn from five values against twenty rows, so ties are the common
    // case rather than the exotic one: a tie is what a cursor built from the
    // sort column alone gets wrong.
    .map((pairs) => pairs.map(([rank, id]) => ({ rank, id })));

  it('visits every row exactly once, in order, however the pages fall', () => {
    fc.assert(
      fc.property(dataset, fc.integer({ min: 1, max: 5 }), direction, (all, limit, order) => {
        const sorted = [...all].sort((a, b) =>
          order === 'ASC' ? a.rank - b.rank || a.id - b.id : b.rank - a.rank || b.id - a.id,
        );

        const seen: { rank: number; id: number }[] = [];
        let cursor: string | undefined;

        // Bounded so a cursor that fails to advance fails the test instead of
        // hanging the suite — which is the symptom of the tie-break being
        // dropped from the `WHERE` clause.
        for (let request = 0; request <= sorted.length + 1; request++) {
          const clause = buildCursorWhere({ cursor, sortColumn: 'rank', direction: order });
          const remaining =
            clause.sql === ''
              ? sorted
              : sorted.filter((row) => after(row, clause.params as [number, number], order));

          // What the repository does: fetch one more row than the page size.
          const page = paginate(remaining.slice(0, limit + 1), limit, 'rank');
          seen.push(...page.data);

          if (!page.meta.hasNextPage) {
            expect(seen).toEqual(sorted);
            return;
          }

          expect(page.meta.nextCursor).not.toBeNull();
          cursor = page.meta.nextCursor ?? undefined;
        }

        throw new Error(`paging did not terminate after ${sorted.length + 2} requests`);
      }),
    );
  });
});
