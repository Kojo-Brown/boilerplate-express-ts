import {
  formatEntityTag,
  isEtagChar,
  parseEntityTag,
  parseEntityTagList,
  strongMatch,
  weakMatch,
} from '@/http/entity-tag';
import type { EntityTag } from '@/http/entity-tag';

const strong = (value: string): EntityTag => ({ weak: false, value });
const weak = (value: string): EntityTag => ({ weak: true, value });

describe('parseEntityTagList', () => {
  it('reads a single strong tag', () => {
    expect(parseEntityTagList('"abc"')).toEqual([strong('abc')]);
  });

  it('reads a weak tag', () => {
    expect(parseEntityTagList('W/"abc"')).toEqual([weak('abc')]);
  });

  it('reads a mixed list', () => {
    expect(parseEntityTagList('"a", W/"b" ,\t"c"')).toEqual([
      strong('a'),
      weak('b'),
      strong('c'),
    ]);
  });

  it('keeps a comma that is inside a tag rather than splitting on it', () => {
    // The reason this is scanned rather than `split(',')`: a comma is a legal
    // etagc, so a splitting parser reads one tag as two malformed halves.
    expect(parseEntityTagList('"a,b"')).toEqual([strong('a,b')]);
    expect(parseEntityTagList('"a,b", "c"')).toEqual([strong('a,b'), strong('c')]);
  });

  it('tolerates the empty list members the # rule allows', () => {
    expect(parseEntityTagList(', "a" , , "b",')).toEqual([strong('a'), strong('b')]);
  });

  it.each([
    ['*', 'the wildcard, which is a whole field value and not a list member'],
    ['abc', 'an unquoted value'],
    ['"unterminated', 'a missing closing quote'],
    ['"a""b"', 'two tags with no separator'],
    ['"a" "b"', 'two tags separated by space alone'],
    ['w/"a"', 'a lower-case weakness prefix, which the grammar does not allow'],
    ['', 'an empty header'],
    ['   ', 'whitespace alone'],
    [',,,', 'separators alone'],
    ['"a\u0001b"', 'a control character inside the tag'],
  ])('rejects %p — %s', (header) => {
    expect(parseEntityTagList(header)).toBeNull();
  });

  it('accepts obs-text bytes inside a tag', () => {
    expect(parseEntityTagList('"café"')).toEqual([strong('café')]);
  });
});

describe('parseEntityTag', () => {
  it('reads exactly one tag', () => {
    expect(parseEntityTag('  W/"v1" ')).toEqual(weak('v1'));
  });

  it('rejects a list, because If-Range takes a single value', () => {
    expect(parseEntityTag('"a", "b"')).toBeNull();
  });

  it('rejects trailing junk after an otherwise valid tag', () => {
    expect(parseEntityTag('"a"x')).toBeNull();
  });

  it('rejects the wildcard', () => {
    expect(parseEntityTag('*')).toBeNull();
  });
});

describe('comparison', () => {
  it('strong comparison requires both sides strong', () => {
    expect(strongMatch(strong('a'), strong('a'))).toBe(true);
    expect(strongMatch(weak('a'), strong('a'))).toBe(false);
    expect(strongMatch(strong('a'), weak('a'))).toBe(false);
    expect(strongMatch(weak('a'), weak('a'))).toBe(false);
  });

  it('weak comparison ignores weakness on either side', () => {
    expect(weakMatch(weak('a'), strong('a'))).toBe(true);
    expect(weakMatch(weak('a'), weak('a'))).toBe(true);
    expect(weakMatch(strong('a'), strong('b'))).toBe(false);
  });

  it('compares tag values as octets, not as numbers', () => {
    expect(weakMatch(strong('007'), strong('7'))).toBe(false);
  });
});

describe('formatEntityTag', () => {
  it('round-trips a strong tag', () => {
    expect(formatEntityTag(strong('abc'))).toBe('"abc"');
    expect(parseEntityTag(formatEntityTag(strong('abc')))).toEqual(strong('abc'));
  });

  it('round-trips a weak tag', () => {
    expect(formatEntityTag(weak('abc'))).toBe('W/"abc"');
    expect(parseEntityTag(formatEntityTag(weak('abc')))).toEqual(weak('abc'));
  });
});

describe('isEtagChar', () => {
  it('accepts the printable range and obs-text, and rejects quote, DEL and controls', () => {
    expect(isEtagChar(0x21)).toBe(true);
    expect(isEtagChar(0x22)).toBe(false); // "
    expect(isEtagChar(0x23)).toBe(true);
    expect(isEtagChar(0x7e)).toBe(true);
    expect(isEtagChar(0x7f)).toBe(false); // DEL
    expect(isEtagChar(0x80)).toBe(true); // obs-text
    expect(isEtagChar(0x1f)).toBe(false);
  });
});
