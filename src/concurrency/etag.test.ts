import { ETAG_HEADER, IF_MATCH_HEADER, formatETag, parseIfMatch } from '@/concurrency/etag';
import type { Precondition } from '@/concurrency/concurrency.types';

/** The parsed precondition, or the failure reason — whichever the case is about. */
function preconditionFor(header: string): Precondition {
  const result = parseIfMatch(header);
  if (!result.ok) throw new Error(`expected "${header}" to parse, got: ${result.reason}`);
  return result.precondition;
}

function versionsFor(header: string): readonly number[] {
  const precondition = preconditionFor(header);
  if (precondition.kind !== 'versions') {
    throw new Error(`expected "${header}" to name versions, got "${precondition.kind}"`);
  }
  return precondition.versions;
}

function reasonFor(header: string): string {
  const result = parseIfMatch(header);
  if (result.ok) throw new Error(`expected "${header}" to be rejected`);
  return result.reason;
}

/** The largest `version` a Postgres `integer` column can hold. */
const MAX_VERSION = 2_147_483_647;

describe('the header names', () => {
  it('are spelled the way the wire spells them', () => {
    // Not a tautology: these two strings are the whole interface. A typo in
    // either is a conditional write that silently stops being conditional —
    // the client sends `If-Match`, nothing reads it, and the lost update the
    // header exists to prevent happens with the tag sitting in the request.
    expect(ETAG_HEADER).toBe('ETag');
    expect(IF_MATCH_HEADER).toBe('If-Match');
  });
});

describe('formatETag', () => {
  it('emits a strong, quoted, decimal tag', () => {
    expect(formatETag(1)).toBe('"1"');
    expect(formatETag(4096)).toBe('"4096"');
  });

  it('accepts the largest version the column can hold', () => {
    // The boundary itself, from the inside. `version > MAX_VERSION` and
    // `version >= MAX_VERSION` disagree on exactly this value, and only the
    // first is right: a row *can* reach 2147483647, and refusing to tag it
    // would make the most-written row in the table the one row no client can
    // write conditionally.
    expect(formatETag(MAX_VERSION)).toBe('"2147483647"');
  });

  it('refuses a version no row can hold', () => {
    // Each of these would produce a tag that round-trips to something else, so
    // a client comparing what it received against what it sends back would be
    // comparing two different strings.
    expect(() => formatETag(0)).toThrow(RangeError);
    expect(() => formatETag(-1)).toThrow(RangeError);
    expect(() => formatETag(1.5)).toThrow(RangeError);
    expect(() => formatETag(Number.NaN)).toThrow(RangeError);
    expect(() => formatETag(MAX_VERSION + 1)).toThrow(RangeError);
  });

  it('says which version it refused', () => {
    // This throw reaches a developer, not a client — nothing in the request
    // chooses the number — so the number is the entire content of the message.
    expect(() => formatETag(0)).toThrow('version 0');
    expect(() => formatETag(MAX_VERSION + 1)).toThrow(`version ${MAX_VERSION + 1}`);
  });
});

describe('parseIfMatch: the wildcard', () => {
  it('reads "*" as any version', () => {
    expect(preconditionFor('*')).toEqual({ kind: 'any' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(preconditionFor('  * ')).toEqual({ kind: 'any' });
  });

  it('rejects "*" as a member of a list', () => {
    // RFC 9110: `*` is the whole field value or it is nothing.
    expect(reasonFor('"1", *')).toContain('entity-tag');
  });
});

describe('parseIfMatch: entity-tag lists', () => {
  it('reads a single tag', () => {
    expect(versionsFor('"7"')).toEqual([7]);
  });

  it('reads a tag of more than one digit', () => {
    // `"7"` on its own cannot tell a correct version pattern from one that
    // accepts a digit followed by anything but digits, and every row past its
    // tenth write carries a tag like these.
    expect(versionsFor('"4096"')).toEqual([4096]);
    expect(versionsFor(`"${MAX_VERSION}"`)).toEqual([MAX_VERSION]);
  });

  it('reads every tag in a list, because If-Match passes if any of them matches', () => {
    expect(versionsFor('"6", "7", "8"')).toEqual([6, 7, 8]);
  });

  it('accepts the optional whitespace around separators', () => {
    expect(versionsFor('"6","7" ,  "8"')).toEqual([6, 7, 8]);
  });

  it('tolerates the empty list members the # rule allows', () => {
    expect(versionsFor(', "6", , "7",')).toEqual([6, 7]);
  });

  it('does not split on a comma inside a tag', () => {
    // `header.split(',')` — the obvious implementation — turns this into two
    // malformed halves. A comma is a legal etagc.
    const result = parseIfMatch('"a,b"');
    expect(result.ok).toBe(true);
    // Unmatchable, but *parsed*: one tag, not two broken ones.
    expect(versionsFor('"a,b"')).toEqual([]);
  });
});

describe('parseIfMatch: tags that cannot name a version', () => {
  // These are well-formed entity-tags that simply do not match anything this
  // API issues. Dropping them yields a precondition no row satisfies — a 412 —
  // which is the honest answer. Rejecting them as malformed would be a 400 and
  // would be wrong: the client's syntax was fine.

  it('drops a non-numeric tag', () => {
    expect(versionsFor('"deadbeef"')).toEqual([]);
  });

  it('drops a tag with a leading zero, because comparison is by octets', () => {
    // `"007"` is not the tag this API emits for version 7, and strong
    // comparison is octet equality — not `Number()`.
    expect(versionsFor('"007"')).toEqual([]);
  });

  it('drops a tag above the column’s range', () => {
    expect(versionsFor('"2147483648"')).toEqual([]);
    expect(versionsFor('"99999999999999999999"')).toEqual([]);
  });

  it('drops a tag that only starts like a number', () => {
    // The anchors on the version pattern, which are the difference between
    // reading a tag and reading a prefix of one. `"1e3"` and `"1.5"` are both
    // legal entity-tags and neither is a tag this API ever emitted; a pattern
    // that matched their first character would hand `Number()` the whole string
    // and come back with version 1000 and version 1.5 — the second of which is
    // not an integer any row can be at, so the conditional write it produced
    // would compare a row against a version that cannot exist.
    expect(versionsFor('"1e3"')).toEqual([]);
    expect(versionsFor('"1.5"')).toEqual([]);
    expect(versionsFor('"7x"')).toEqual([]);
  });

  it('drops the empty tag', () => {
    expect(versionsFor('""')).toEqual([]);
  });

  it('keeps the matchable tags in a mixed list', () => {
    expect(versionsFor('"deadbeef", "7"')).toEqual([7]);
  });
});

describe('parseIfMatch: rejections', () => {
  it('rejects a weak tag rather than letting it never match', () => {
    const reason = reasonFor('W/"7"');
    expect(reason).toContain('strong comparison');
  });

  it('rejects a weak tag anywhere in the list', () => {
    expect(reasonFor('"6", W/"7"')).toContain('strong comparison');
  });

  it('rejects a bare number — an ETag is a quoted-string', () => {
    expect(reasonFor('7')).toContain('entity-tag');
  });

  it('rejects an unterminated tag', () => {
    expect(reasonFor('"7')).toContain('entity-tag');
  });

  it('rejects two tags with no separator between them', () => {
    expect(reasonFor('"6""7"')).toContain('entity-tag');
  });

  it('rejects a control character inside a tag', () => {
    // Not an `etagc`. Letting it through would put a raw control byte into
    // log lines and into anything that echoes the tag back.
    expect(reasonFor('"7\u0001"')).toContain('entity-tag');
  });

  it('rejects an empty header', () => {
    expect(reasonFor('')).toContain('entity-tag');
    expect(reasonFor('   ')).toContain('entity-tag');
  });

  it('rejects a list that is only separators', () => {
    expect(reasonFor(', ,')).toContain('entity-tag');
  });

  it('rejects trailing junk after a valid tag', () => {
    expect(reasonFor('"7" and more')).toContain('entity-tag');
  });
});
