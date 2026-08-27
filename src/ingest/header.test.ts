import { bindHeader, normaliseHeaderName } from '@/ingest/header';
import type { ColumnSpec } from '@/ingest/header';
import { CsvParseError } from '@/streams/csv.errors';
import type { CsvRecord } from '@/streams/csv-parser';

const COLUMNS: readonly ColumnSpec[] = [
  { name: 'email', required: true },
  { name: 'roles', required: false },
];

const header = (...fields: string[]): CsvRecord => ({ line: 1, fields });

describe('normaliseHeaderName', () => {
  it.each([
    ['Email', 'email'],
    ['  email  ', 'email'],
    ['EMAIL', 'email'],
  ])('normalises %p to %p', (raw, expected) => {
    expect(normaliseHeaderName(raw)).toBe(expected);
  });

  it('leaves internal punctuation and spacing alone', () => {
    // Guessing across these is how a column silently binds to the wrong one.
    expect(normaliseHeaderName('user email')).toBe('user email');
    expect(normaliseHeaderName('user_email')).toBe('user_email');
  });
});

describe('bindHeader', () => {
  it('maps each column to the index it was found at', () => {
    expect(bindHeader(header('roles', 'email'), COLUMNS)).toEqual(
      new Map([
        ['roles', 0],
        ['email', 1],
      ]),
    );
  });

  it('accepts the casing and stray spaces a spreadsheet export produces', () => {
    expect(bindHeader(header(' Email ', 'ROLES'), COLUMNS)).toEqual(
      new Map([
        ['email', 0],
        ['roles', 1],
      ]),
    );
  });

  it('accepts a file that omits an optional column', () => {
    expect(bindHeader(header('email'), COLUMNS)).toEqual(new Map([['email', 0]]));
  });

  it('refuses a header that omits a required column', () => {
    expect(() => bindHeader(header('roles'), COLUMNS)).toThrow(
      expect.objectContaining({ code: 'CSV_HEADER_INVALID' }) as Error,
    );
    expect(() => bindHeader(header('roles'), COLUMNS)).toThrow(/email/);
  });

  it('refuses an unrecognised column rather than silently dropping it', () => {
    // The whole point: the wrong export would otherwise import partially and
    // report success.
    expect(() => bindHeader(header('email', 'nickname'), COLUMNS)).toThrow(/nickname/);
  });

  it('refuses a duplicated column', () => {
    expect(() => bindHeader(header('email', 'email'), COLUMNS)).toThrow(/more than once/);
  });

  it('names the line so a human can find it', () => {
    try {
      bindHeader({ line: 1, fields: ['nope'] }, COLUMNS);
      throw new Error('expected bindHeader to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CsvParseError);
      expect((err as CsvParseError).line).toBe(1);
    }
  });
});
