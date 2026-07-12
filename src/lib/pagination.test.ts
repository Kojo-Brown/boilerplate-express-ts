import {
  buildCursorWhere,
  createCursor,
  paginate,
  cursorPageQuerySchema,
} from '@/lib/pagination';
import { AppError } from '@/lib/errors';

function encodeCursor(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeCursorRaw(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const SORT_COL = 'created_at';
const CURSOR_DATE = '2024-01-15T10:00:00.000Z';
const CURSOR_DATA = { created_at: CURSOR_DATE, id: 'abc-123' };
const VALID_CURSOR = encodeCursor(CURSOR_DATA);

describe('cursorPageQuerySchema', () => {
  it('parses cursor and coerces limit from string', () => {
    const result = cursorPageQuerySchema.parse({ cursor: VALID_CURSOR, limit: '10' });
    expect(result).toEqual({ cursor: VALID_CURSOR, limit: 10 });
  });

  it('defaults limit to 20 when omitted', () => {
    const result = cursorPageQuerySchema.parse({});
    expect(result).toEqual({ cursor: undefined, limit: 20 });
  });

  it('rejects limit of 0', () => {
    expect(() => cursorPageQuerySchema.parse({ limit: '0' })).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() => cursorPageQuerySchema.parse({ limit: '101' })).toThrow();
  });

  it('accepts limit of 1 and 100', () => {
    expect(cursorPageQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(cursorPageQuerySchema.parse({ limit: '100' }).limit).toBe(100);
  });
});

describe('buildCursorWhere', () => {
  it('returns empty sql and params when cursor is undefined', () => {
    const result = buildCursorWhere({ cursor: undefined, sortColumn: SORT_COL, direction: 'ASC' });
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('builds correct ASC WHERE clause starting at $1', () => {
    const result = buildCursorWhere({ cursor: VALID_CURSOR, sortColumn: SORT_COL, direction: 'ASC' });
    expect(result.sql).toBe('("created_at", "id") > ($1, $2)');
    expect(result.params).toEqual([CURSOR_DATE, 'abc-123']);
  });

  it('builds correct DESC WHERE clause starting at $1', () => {
    const result = buildCursorWhere({ cursor: VALID_CURSOR, sortColumn: SORT_COL, direction: 'DESC' });
    expect(result.sql).toBe('("created_at", "id") < ($1, $2)');
    expect(result.params).toEqual([CURSOR_DATE, 'abc-123']);
  });

  it('respects paramStart offset for composing with existing params', () => {
    const result = buildCursorWhere({
      cursor: VALID_CURSOR,
      sortColumn: SORT_COL,
      direction: 'ASC',
      paramStart: 3,
    });
    expect(result.sql).toBe('("created_at", "id") > ($3, $4)');
    expect(result.params).toEqual([CURSOR_DATE, 'abc-123']);
  });

  it('throws AppError(400) for an invalid base64 cursor', () => {
    expect(() =>
      buildCursorWhere({ cursor: 'not!!!valid', sortColumn: SORT_COL, direction: 'ASC' }),
    ).toThrow(AppError);

    try {
      buildCursorWhere({ cursor: 'not!!!valid', sortColumn: SORT_COL, direction: 'ASC' });
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).code).toBe('INVALID_CURSOR');
    }
  });

  it('throws AppError when cursor is missing the sortColumn field', () => {
    const missingSort = encodeCursor({ id: 'abc' });
    expect(() =>
      buildCursorWhere({ cursor: missingSort, sortColumn: SORT_COL, direction: 'ASC' }),
    ).toThrow(AppError);
  });

  it('throws AppError when cursor is missing the id field', () => {
    const missingId = encodeCursor({ created_at: CURSOR_DATE });
    expect(() =>
      buildCursorWhere({ cursor: missingId, sortColumn: SORT_COL, direction: 'ASC' }),
    ).toThrow(AppError);
  });

  it('throws AppError when cursor payload is not an object', () => {
    const arrayCursor = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64url');
    expect(() =>
      buildCursorWhere({ cursor: arrayCursor, sortColumn: SORT_COL, direction: 'ASC' }),
    ).toThrow(AppError);
  });
});

describe('createCursor', () => {
  it('creates a decodable cursor containing sortColumn and id', () => {
    const row = { id: 'xyz-789', created_at: CURSOR_DATE, value: 42 };
    const cursor = createCursor(row, SORT_COL);
    const decoded = decodeCursorRaw(cursor);
    expect(decoded).toEqual({ created_at: CURSOR_DATE, id: 'xyz-789' });
  });

  it('only encodes sortColumn and id (not extra fields)', () => {
    const row = { id: 'a', created_at: CURSOR_DATE, secret: 'should-not-appear' };
    const cursor = createCursor(row, SORT_COL);
    const decoded = decodeCursorRaw(cursor);
    expect(Object.keys(decoded)).toEqual(['created_at', 'id']);
  });

  it('throws when row is missing id', () => {
    expect(() => createCursor({ created_at: CURSOR_DATE }, SORT_COL)).toThrow(
      'missing required fields',
    );
  });

  it('throws when row is missing sortColumn', () => {
    expect(() => createCursor({ id: 'abc' }, SORT_COL)).toThrow('missing required fields');
  });
});

describe('paginate', () => {
  const makeRow = (id: string, created_at: string) =>
    ({ id, created_at, name: 'item' }) as Record<string, unknown>;

  it('returns all data and null nextCursor when rows.length <= limit', () => {
    const rows = [makeRow('1', '2024-01'), makeRow('2', '2024-02')];
    const result = paginate(rows, 5, SORT_COL);
    expect(result.data).toHaveLength(2);
    expect(result.meta.nextCursor).toBeNull();
    expect(result.meta.hasNextPage).toBe(false);
    expect(result.meta.limit).toBe(5);
  });

  it('slices off the extra row and provides nextCursor when rows.length > limit', () => {
    const rows = [
      makeRow('1', '2024-01'),
      makeRow('2', '2024-02'),
      makeRow('3', '2024-03'), // sentinel — proves there is a next page
    ];
    const result = paginate(rows, 2, SORT_COL);
    expect(result.data).toHaveLength(2);
    expect(result.meta.hasNextPage).toBe(true);
    expect(result.meta.nextCursor).not.toBeNull();

    const decoded = decodeCursorRaw(result.meta.nextCursor!);
    expect(decoded['id']).toBe('2');
    expect(decoded['created_at']).toBe('2024-02');
  });

  it('returns empty data and null cursor for empty input', () => {
    const result = paginate([], 10, SORT_COL);
    expect(result.data).toEqual([]);
    expect(result.meta.nextCursor).toBeNull();
    expect(result.meta.hasNextPage).toBe(false);
  });

  it('cursor from paginate can be round-tripped through buildCursorWhere', () => {
    const rows = [makeRow('row-1', '2024-06-01'), makeRow('row-2', '2024-06-02')];
    const { meta } = paginate([...rows, makeRow('row-3', '2024-06-03')], 2, SORT_COL);

    const { sql, params } = buildCursorWhere({
      cursor: meta.nextCursor ?? undefined,
      sortColumn: SORT_COL,
      direction: 'ASC',
    });
    expect(sql).toBe('("created_at", "id") > ($1, $2)');
    expect(params).toEqual(['2024-06-02', 'row-2']);
  });
});
