import {
  formatContentRange,
  formatUnsatisfiedRange,
  parseRangeHeader,
  rangeLength,
  resolveRange,
} from '@/http/range';
import type { RangeSpec } from '@/http/range';

const int = (first: number, last: number | null): RangeSpec => ({ kind: 'int', first, last });
const suffix = (length: number): RangeSpec => ({ kind: 'suffix', length });

describe('parseRangeHeader', () => {
  it('reads a closed interval', () => {
    expect(parseRangeHeader('bytes=0-499')).toEqual([int(0, 499)]);
  });

  it('reads an open-ended interval', () => {
    expect(parseRangeHeader('bytes=500-')).toEqual([int(500, null)]);
  });

  it('reads a suffix range', () => {
    expect(parseRangeHeader('bytes=-500')).toEqual([suffix(500)]);
  });

  it('reads a single-byte range', () => {
    expect(parseRangeHeader('bytes=0-0')).toEqual([int(0, 0)]);
  });

  it('reads a list, in the order it was written', () => {
    expect(parseRangeHeader('bytes=0-99, 200-299 ,-50')).toEqual([
      int(0, 99),
      int(200, 299),
      suffix(50),
    ]);
  });

  it('tolerates the empty list members the # rule allows', () => {
    expect(parseRangeHeader('bytes=,0-1,,2-3,')).toEqual([int(0, 1), int(2, 3)]);
  });

  it('compares the range unit case-insensitively, as a token', () => {
    expect(parseRangeHeader('BYTES=0-1')).toEqual([int(0, 1)]);
  });

  it('accepts leading zeros, which the grammar permits', () => {
    expect(parseRangeHeader('bytes=0000-0010')).toEqual([int(0, 10)]);
  });

  it.each([
    ['items=0-1', 'a range unit other than bytes'],
    ['bytes', 'no "=" at all'],
    ['bytes=', 'an empty range-set'],
    ['bytes=abc', 'a non-numeric spec'],
    ['bytes=-', 'a hyphen with nothing on either side'],
    ['bytes=10-5', 'a last-pos below the first-pos'],
    ['bytes=1-2-3', 'an extra hyphen'],
    ['bytes=0 - 10', 'whitespace inside the spec'],
    ['bytes=-1.5', 'a non-integer suffix length'],
    ['bytes=+1-2', 'a signed position'],
    ['bytes=0-1, bad', 'one malformed member, which invalidates the whole list'],
  ])('rejects %p — %s', (header) => {
    expect(parseRangeHeader(header)).toBeNull();
  });

  it('clamps an absurdly long position rather than losing precision on it', () => {
    // `Number('99999999999999999999')` is 1e20, which is not that number. A
    // position that has silently changed value is worse than one that was
    // refused, because it goes into a `Content-Range` the client trusts.
    const specs = parseRangeHeader('bytes=0-99999999999999999999');
    expect(specs).toEqual([int(0, Number.MAX_SAFE_INTEGER)]);
    // And it still resolves to something sane: past the end is clamped.
    expect(resolveRange(specs ?? [], 100)).toEqual({
      kind: 'range',
      range: { start: 0, end: 99 },
    });
  });

  it('does not treat leading zeros as length when clamping', () => {
    expect(parseRangeHeader(`bytes=0-${'0'.repeat(40)}42`)).toEqual([int(0, 42)]);
  });
});

describe('resolveRange', () => {
  const size = 1000;

  it('resolves a closed interval unchanged', () => {
    expect(resolveRange([int(0, 499)], size)).toEqual({
      kind: 'range',
      range: { start: 0, end: 499 },
    });
  });

  it('resolves an open-ended interval to the end of the representation', () => {
    expect(resolveRange([int(900, null)], size)).toEqual({
      kind: 'range',
      range: { start: 900, end: 999 },
    });
  });

  it('clamps a last-pos past the end rather than refusing it', () => {
    expect(resolveRange([int(0, 5000)], size)).toEqual({
      kind: 'range',
      range: { start: 0, end: 999 },
    });
  });

  it('resolves a suffix range from the end', () => {
    expect(resolveRange([suffix(100)], size)).toEqual({
      kind: 'range',
      range: { start: 900, end: 999 },
    });
  });

  it('treats a suffix longer than the representation as the whole thing', () => {
    expect(resolveRange([suffix(5000)], size)).toEqual({
      kind: 'range',
      range: { start: 0, end: 999 },
    });
  });

  it('refuses a first-pos at or past the end', () => {
    expect(resolveRange([int(1000, null)], size)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange([int(1001, 2000)], size)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuses a zero-length suffix, which names nothing', () => {
    expect(resolveRange([suffix(0)], size)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuses every range against a zero-byte representation', () => {
    expect(resolveRange([int(0, null)], 0)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange([int(0, 0)], 0)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange([suffix(10)], 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a multi-range request rather than answering part of it', () => {
    // Answering with one of several requested ranges is not permitted — the
    // client cannot tell which it got — and the whole representation always is.
    expect(resolveRange([int(0, 9), int(20, 29)], size)).toEqual({ kind: 'ignore' });
  });

  it('ignores an empty spec list', () => {
    expect(resolveRange([], size)).toEqual({ kind: 'ignore' });
  });

  it('rejects a size that is not a byte count', () => {
    expect(() => resolveRange([int(0, 1)], -1)).toThrow(RangeError);
    expect(() => resolveRange([int(0, 1)], 1.5)).toThrow(RangeError);
  });
});

describe('formatting', () => {
  it('renders a satisfied range', () => {
    expect(formatContentRange({ start: 0, end: 499 }, 1000)).toBe('bytes 0-499/1000');
  });

  it('renders the unsatisfied form, which carries the real length', () => {
    expect(formatUnsatisfiedRange(1000)).toBe('bytes */1000');
    expect(formatUnsatisfiedRange(0)).toBe('bytes */0');
  });

  it('counts an inclusive interval', () => {
    expect(rangeLength({ start: 0, end: 0 })).toBe(1);
    expect(rangeLength({ start: 0, end: 499 })).toBe(500);
    expect(rangeLength({ start: 900, end: 999 })).toBe(100);
  });
});
